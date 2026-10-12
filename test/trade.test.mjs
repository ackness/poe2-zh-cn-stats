import test from 'node:test';
import assert from 'node:assert/strict';
import { pairTrade } from '../src/trade.mjs';

function response(...rows) {
  const groups = new Map();
  for (const [id, text] of rows) {
    const category = id.split('.')[0];
    if (!groups.has(category)) groups.set(category, { id: category, label: category, entries: [] });
    groups.get(category).entries.push({ id, text });
  }
  return { result: [...groups.values()] };
}

const life = ['explicit.stat_1', '# to maximum Life'];
const lifeCn = ['explicit.stat_1', '最大生命提高 #'];

test('distinct branches sharing an ID are all retained and never zipped by order', () => {
  const enRows = [life, ['explicit.stat_1', '# to maximum Mana']];
  const cnRows = [lifeCn, ['explicit.stat_1', '最大魔力提高 #']];
  const result = pairTrade(response(...enRows), response(...cnRows));
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every(entry => entry.chinese === null && entry.reason === 'ambiguous-en-branches'));
  assert.deepEqual(result, pairTrade(response(...enRows.toReversed()), response(...cnRows.toReversed())));
});

test('identical formatting-normalized duplicates collapse without losing a mapping', () => {
  const result = pairTrade(response(life, [life[0], '  # to maximum\nLife  ']),
    response(lifeCn, [lifeCn[0], '最大生命提高\n #']));
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].method, 'trade');
  assert.equal(result.entries[0].chinese, lifeCn[1]);
  assert.deepEqual(result.entries[0].evidence, [{ source: 'trade-cn', id: lifeCn[0], text: lifeCn[1] }]);
});

test('a unique EN branch cannot select among different CN branches', () => {
  const { entries } = pairTrade(response(life), response(lifeCn, [life[0], '最大魔力提高 #']));
  assert.equal(entries[0].reason, 'ambiguous-cn-branches');
  assert.equal(entries[0].chinese, null);
});

test('different placeholder arity remains unresolved', () => {
  const { entries } = pairTrade(response(life), response([life[0], '附加 # 至 # 生命']));
  assert.equal(entries[0].reason, 'placeholder-arity');
});

test('missing translations retain the English branch and CN-only IDs are visible', () => {
  const cnRows = [['explicit.stat_2', '魔力 #'], ['explicit.stat_2', '生命 #'], ['explicit.stat_2', '生命 #']];
  const result = pairTrade(response(life), response(...cnRows));
  assert.equal(result.entries[0].reason, 'missing-cn');
  assert.equal(result.entries[0].english, life[1]);
  assert.deepEqual(result.cnOnly, [{ id: 'explicit.stat_2', category: 'explicit', texts: ['生命 #', '魔力 #'] }]);
});

test('option suffixes are complete identities, not interchangeable stat IDs', () => {
  const en = response(['explicit.stat_1|1', life[1]], ['explicit.stat_1|2', life[1]]);
  const cn = response(['explicit.stat_1|2', lifeCn[1]], ['explicit.stat_1', lifeCn[1]]);
  const result = pairTrade(en, cn);
  assert.equal(result.entries[0].reason, 'missing-cn');
  assert.equal(result.entries[1].method, 'trade');
  assert.equal(result.cnOnly[0].id, 'explicit.stat_1');
});

test('fractured reuses only an identical full-suffix explicit mapping with source evidence', () => {
  const { entries } = pairTrade(response(['explicit.stat_1|2', life[1]], ['fractured.stat_1|2', ' # to maximum\nLife ']),
    response(['explicit.stat_1|2', lifeCn[1]]));
  const fractured = entries.find(entry => entry.category === 'fractured');
  assert.equal(fractured.id, 'fractured.stat_1|2');
  assert.equal(fractured.method, 'explicit-reuse');
  assert.equal(fractured.chinese, lifeCn[1]);
  assert.deepEqual(fractured.evidence, [{ source: 'trade-cn', id: 'explicit.stat_1|2', text: lifeCn[1] }]);
});

test('reuse does not broaden to other suffixes, English conditions, or categories', () => {
  const en = response(life, ['fractured.stat_1|2', life[1]],
    ['fractured.stat_1', `${life[1]} while stationary`], ['crafted.stat_1', life[1]]);
  const { entries } = pairTrade(en, response(lifeCn));
  assert.ok(entries.filter(entry => entry.category !== 'explicit').every(entry => entry.chinese === null));
});

test('reuse requires a unique and structurally valid explicit mapping', () => {
  const fractured = ['fractured.stat_1', life[1]];
  const fixtures = [
    [response(life, [life[0], '# to maximum Mana'], fractured), response(lifeCn)],
    [response(life, fractured), response(lifeCn, [life[0], '最大魔力提高 #'])],
    [response(life, fractured), response([life[0], '最大生命提高 # 至 #'])],
  ];
  for (const [en, cn] of fixtures) {
    assert.equal(pairTrade(en, cn).entries.find(entry => entry.category === 'fractured').method, 'unresolved');
  }
});

test('existing conflicting, invalid, or ambiguous fractured payloads are never overwritten', () => {
  const en = response(life, ['fractured.stat_1', life[1]]);
  for (const texts of [['最大魔力提高 #'], ['生命 # 至 #'], [life[1]], ['生命 #', '魔力 #']]) {
    const cn = response(lifeCn, ...texts.map(text => ['fractured.stat_1', text]));
    const entry = pairTrade(en, cn).entries.find(item => item.category === 'fractured');
    assert.notEqual(entry.method, 'explicit-reuse');
    if (texts.length === 1 && texts[0] === '最大魔力提高 #') {
      assert.equal(entry.chinese, texts[0]);
      assert.equal(entry.method, 'trade');
    } else {
      assert.equal(entry.chinese, null);
    }
  }
});

test('untranslated, non-Chinese, and symbolic-only text are not localization evidence', () => {
  for (const text of [life[1], '# to maximum Mana', '+#%']) {
    const entry = pairTrade(response(life), response([life[0], text])).entries[0];
    assert.equal(entry.chinese, null);
    assert.equal(entry.reason, text === life[1] ? 'untranslated-cn' : 'non-chinese-cn');
  }
});

test('pseudo records are excluded with a diagnostic, not silently lost', () => {
  const result = pairTrade(response(life, ['pseudo.total_life', 'Life #']),
    response(lifeCn, ['pseudo.total_life', '生命 #']));
  assert.equal(result.entries.length, 1);
  assert.deepEqual(result.cnOnly, []);
  assert.deepEqual(result.issues.filter(issue => issue.code === 'pseudo-skipped').map(issue => issue.locale), ['cn', 'en']);
});

test('malformed upstream responses fail explicitly, including excluded pseudo groups', () => {
  const malformed = [
    null, [], {}, { result: {} }, { result: [null] },
    { result: [{ id: 'explicit', label: 'Explicit', entries: {} }] },
    { result: [{ id: 'explicit', entries: [] }] },
    { result: [{ id: 'explicit', label: 'Explicit', entries: [null] }] },
    response(['explicit.stat_1', '   ']),
    response(['explicit.stat_1', 42]),
    response(['explicit.', 'Text']),
    response(['explicit.stat_1|', 'Text']),
    { result: [{ id: 'explicit', label: 'Explicit', entries: [{ id: 'fractured.stat_1', text: 'Text' }] }] },
    { result: [{ id: 'explicit', label: 'Explicit', entries: [{ id: 'explicit.stat_1', text: 'Text', type: 4 }] }] },
    response(['pseudo.total_life', '']),
  ];
  for (const value of malformed) {
    assert.throws(() => pairTrade(value, response()), { name: 'TypeError', message: /Malformed trade response at en/ });
    assert.throws(() => pairTrade(response(), value), { name: 'TypeError', message: /Malformed trade response at cn/ });
  }
});

test('category comes from the ID group even when display type differs', () => {
  const en = response(['rune.stat_1', life[1]]);
  en.result[0].entries[0].type = 'augment';
  const { entries } = pairTrade(en, response(['rune.stat_1', lifeCn[1]]));
  assert.equal(entries[0].category, 'rune');
});

test('deterministic ordering ignores upstream group and entry order', () => {
  const enRows = [life, ['implicit.stat_2', '# to Mana'], ['fractured.stat_1', life[1]], ['pseudo.total', 'Total #']];
  const cnRows = [lifeCn, ['rune.stat_2', '魔力 #'], ['rune.stat_2', '生命 #'], ['pseudo.total', '总计 #']];
  assert.deepEqual(pairTrade(response(...enRows), response(...cnRows)),
    pairTrade(response(...enRows.toReversed()), response(...cnRows.toReversed())));
});
