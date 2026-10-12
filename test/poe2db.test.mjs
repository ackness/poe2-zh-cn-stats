import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPagePairs, PoE2DBDecodeError } from '../src/poe2db.mjs';

const urls = { enUrl: 'https://poe2db.tw/us/example', cnUrl: 'https://poe2db.tw/cn/example' };
const span = value => `<span class="mod-value">${value}</span>`;
const page = pools => `<script>$(function() { new ModsView(${JSON.stringify(pools)}); });</script>`;
const row = (str, overrides = {}) => ({
  Name: 'localized display name', Level: '10', ModGenerationTypeID: '2',
  ModFamilyList: ['SharedFamily'], str, fossil_no: [], adds_no: [], spawn_no: [], mod_no: [],
  ...overrides,
});
const pair = (en, cn) => extractPagePairs(page({ normal: en }), page({ normal: cn }), urls);

// Small synthetic schemas exercise source identity, not production prose.
test('shuffled rows use stable tags, not family, display name, hover or position', () => {
  const en = [
    row(`${span('+2')} to Spell Skills`, { fossil_no: ['caster', 'gem'], Name: 'A', hover: '/us/a' }),
    row(`${span('+2')} to Minion Skills`, { fossil_no: ['minion', 'gem'], Name: 'B', hover: '/us/b' }),
  ];
  const cn = [
    row(`召唤技能 ${span('+2')}`, { fossil_no: ['gem', 'minion'], Name: '甲', hover: '/cn/x' }),
    row(`法术技能 ${span('+2')}`, { fossil_no: ['gem', 'caster'], Name: '乙', hover: '/cn/y' }),
  ];
  const result = pair(en, cn);
  assert.equal(result.pairs.length, 2);
  const matches = new Map(result.pairs.map(p => [p.english, p.chinese]));
  assert.equal(matches.get('+# to Spell Skills'), '法术技能 +#');
  assert.equal(matches.get('+# to Minion Skills'), '召唤技能 +#');
  assert.deepEqual(result.issues, []);
});

test('unresolved same-family identities are not zipped or guessed', () => {
  const result = pair([
    row(`${span(2)} Spell Skills`), row(`${span(2)} Minion Skills`),
  ], [row(`法术 ${span(2)}`), row(`召唤 ${span(2)}`)]);
  assert.deepEqual(result.pairs, []);
  const issue = result.issues.find(i => i.type === 'ambiguous-identity');
  assert.equal(issue.english.length, 2);
  assert.equal(issue.chinese.length, 2);
});

test('numeric spans alone become slots; literal conditions, signs and line order survive', () => {
  const result = pair([
    row(`${span('+(30<span class="ndash">—</span>60)')}% local damage in past 8 seconds<br>then ${span('-2')} mana`),
  ], [row(`过去 8 秒内本地伤害 ${span('+(30—60)')}%<br>然后魔力 ${span('-2')}`)]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].english, '+#% local damage in past 8 seconds then -# mana');
  assert.equal(result.pairs[0].chinese, '过去 8 秒内本地伤害 +#% 然后魔力 -#');
  assert.deepEqual(result.pairs[0].proof.values.map(v => v.range), [[30, 60], [-2, -2]]);
});

test('condition numbers are not required to be digits in both languages', () => {
  const result = pair([row(`${span('(30—60)')}% damage in past eight seconds`)],
    [row(`过去 8 秒内伤害 ${span('(30—60)')}%`)]);
  assert.equal(result.pairs.length, 1);
  assert.match(result.pairs[0].english, /eight seconds/u);
  assert.match(result.pairs[0].chinese, /8 秒/u);
});

test('range, sign, arity and numeric argument order mismatches cannot yield pairs', () => {
  const english = row(`Adds ${span('(10—15)')} to ${span('(21—26)')} damage`);
  for (const chinese of [
    `附加 ${span('(10—16)')} 至 ${span('(21—26)')} 伤害`,
    `附加 ${span('(21—26)')} 至 ${span('(10—15)')} 伤害`,
    `附加 ${span('(10—15)')} 伤害`,
    `附加 ${span('-(10—15)')} 至 ${span('(21—26)')} 伤害`,
  ]) {
    const result = pair([english], [row(chinese)]);
    assert.equal(result.pairs.length, 0);
    assert.ok(result.issues.length);
  }
});

test('malformed recognized JSON throws a typed standalone decode error', () => {
  for (const script of [
    'new ModsView({"normal": [});',
    'new ModsView({"normal": []}',
    'new ModsView({normal: []});',
    'new ModsView({"normal": []} + evil());',
    'new ModsView(evil());',
  ]) {
    assert.throws(() => extractPagePairs(`<script>${script}</script>`, page({}), urls),
      error => error instanceof PoE2DBDecodeError && error.code === 'POE2DB_DECODE' && error.url === urls.enUrl);
  }
});

test('duplicates across pools preserve evidence without duplicating a candidate', () => {
  const en = row(`${span(5)} power`);
  const cn = row(`力量 ${span(5)}`);
  const result = extractPagePairs(page({ normal: [en], essence: [en] }),
    page({ essence: [cn], normal: [cn] }), urls);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].proof.english.length, 2);
  assert.equal(result.pairs[0].proof.chinese.length, 2);
  assert.deepEqual(result.pairs[0].proof.english.map(e => e.pool), [['normal'], ['essence']]);
});

test('different identities keep alternate Chinese for the same English template', () => {
  const result = pair([
    row(`${span(5)} power`, { Level: '1' }), row(`${span(10)} power`, { Level: '2' }),
  ], [
    row(`力量 ${span(5)}`, { Level: '1' }), row(`威力 ${span(10)}`, { Level: '2' }),
  ]);
  assert.equal(result.pairs.length, 2);
  assert.deepEqual(new Set(result.pairs.map(p => p.english)), new Set(['# power']));
  assert.deepEqual(new Set(result.pairs.map(p => p.chinese)), new Set(['力量 #', '威力 #']));
});

test('unchanged and non-Chinese renderings are reported rather than emitted', () => {
  for (const [english, chinese] of [
    [`${span(5)} power`, `${span(5)} power`],
    [`${span(5)} power`, `power ${span(5)}`],
    [`力量 ${span(5)}`, `力量 ${span(5)}`],
  ]) {
    const result = pair([row(english)], [row(chinese)]);
    assert.equal(result.pairs.length, 0);
    assert.ok(result.issues.some(i => i.type === 'untranslated-chinese'));
  }
});

test('unsupported pages and legacy configuration headings are diagnosed', () => {
  for (const html of [
    '<h1>Modifier catalogue</h1>',
    page({ config: { normal: { title: 'Legacy headings' } }, normal: [] }),
    page({ config: { legacy: [row(`${span(1)} fake`)] } }),
  ]) {
    const result = extractPagePairs(html, html, urls);
    assert.equal(result.pairs.length, 0);
    assert.equal(result.issues.filter(i => i.type === 'unsupported-page').length, 2);
  }
});

test('root arrays and nested pools are supported only for actual mod rows', () => {
  const result = extractPagePairs(page([row(`${span(1)} power`)]),
    page({ pools: { special: [row(`力量 ${span(1)}`)] } }), urls);
  assert.equal(result.pairs.length, 1);
});

test('hostile scripts, handlers, quoted constructors and comments never execute', () => {
  const attack = 'globalThis.__poe2dbExecuted = true';
  delete globalThis.__poe2dbExecuted;
  const noise = `<script>${attack}; const sample = 'new ModsView(notJSON)';
    /* new ModsView(alsoNotJSON); */ // new ModsView(nope);
    </script><img src=x onerror="${attack}">`;
  const result = extractPagePairs(noise + page({ normal: [row(`${span(2)} power`)] }),
    noise + page({ normal: [row(`力量 ${span(2)}`)] }), urls);
  assert.equal(result.pairs.length, 1);
  assert.equal(globalThis.__poe2dbExecuted, undefined);
  assert.throws(() => extractPagePairs(`<script>new ModsView((()=>{${attack};return {}})());</script>`, '', urls),
    PoE2DBDecodeError);
  assert.equal(globalThis.__poe2dbExecuted, undefined);
});

test('unrecognized marked content is diagnosed, not erased into a slot', () => {
  const result = pair([row(`${span('up to 5')} power`)], [row(`力量 ${span('up to 5')}`)]);
  assert.equal(result.pairs.length, 0);
  assert.ok(result.issues.some(i => i.type === 'unsupported-value-span'));
});

const detail = (header, stats, { family = 'SameFamily', locale = 'en', scope = 'global' } = {}) => {
  const scopeText = scope === 'local' ? (locale === 'cn' ? '区域' : 'Local') : 'Global';
  return `<div class="card"><h5 class="card-header"><span class="item_magic">${header}</span></h5>
    <table><tr><th>Family</th><td>${family}</td></tr>
    <tr><th>Domains</th><td>${locale === 'cn' ? '物品' : 'Item'} (1)</td></tr>
    <tr><th>GenerationType</th><td>${locale === 'cn' ? '传奇' : 'Unique'} (3)</td></tr>
    <tr><th>Req. level</th><td>1</td></tr><tr><th>Stats</th><td>
    ${stats.map(([name, min, max]) => `<li>${name} <span class="badge bg-primary">${min} <span class="ndash">—</span> ${max}</span> <span class="badge bg-secondary">${scopeText}</span></li>`).join('')}
    </td></tr></table></div>`;
};

test('detail cards join raw stat definitions and ranges, never family or header position', () => {
  const a = ['damage +% with melee', 30, 60];
  const b = ['damage +% with projectile', 30, 60];
  const result = extractPagePairs(
    detail(`${span('(30—60)')}% melee in past eight seconds`, [a]) + detail(`${span('(30—60)')}% projectile`, [b]),
    detail(`投射物 ${span('(30—60)')}%`, [b], { locale: 'cn' })
      + detail(`过去 8 秒内近战 ${span('(30—60)')}%`, [a], { locale: 'cn' }), urls);
  assert.equal(result.pairs.length, 2);
  assert.equal(result.pairs.find(p => p.english.includes('melee')).chinese, '过去 8 秒内近战 #%');
  assert.ok(result.pairs.every(p => p.proof.identity.shape === 'detail-stats'));
});

test('detail cards require identical raw definitions, ranges and local/global scope', () => {
  const en = detail(`${span('(10—20)')}% speed with this weapon`, [['local attack speed +%', 10, 20]], { scope: 'local' });
  const matching = detail(`此武器速度 ${span('(10—20)')}%`, [['local attack speed +%', 10, 20]], { scope: 'local', locale: 'cn' });
  assert.equal(extractPagePairs(en, matching, urls).pairs.length, 1);
  for (const [stat, min, max, scope] of [
    ['base attack speed +%', 10, 20, 'local'],
    ['local attack speed +%', 10, 21, 'local'],
    ['local attack speed +%', 10, 20, 'global'],
  ]) {
    const cn = detail(`此武器速度 ${span('(10—20)')}%`, [[stat, min, max]], { scope, locale: 'cn' });
    assert.equal(extractPagePairs(en, cn, urls).pairs.length, 0);
  }
});

test('raw secondary detail headers cannot pretend to be translations', () => {
  const html = detail('<span class="secondary">raw stat [1]</span>', [['raw stat', 1, 1]]);
  const result = extractPagePairs(html, html, urls);
  assert.equal(result.pairs.length, 0);
  assert.ok(result.issues.some(i => i.type === 'raw-stat-display-only'));
});
