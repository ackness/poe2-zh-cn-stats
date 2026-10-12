import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildPobrExport } from '../src/pobr-export.mjs';
import { generateFiles, writeGenerated, checkGenerated, activateGenerated } from '../src/snapshot.mjs';
import { sha256 } from '../src/sources.mjs';

const snapshot = '20260101T000000000Z';
const empty = () => ({ schema_version: 1, templates: [], words: [] });
const entry = (english, chinese, id = 'explicit.stat_1', extra = {}) => ({
  id, english, chinese, method: 'trade', evidence: [{ source: 'trade-cn', id, text: chinese }], ...extra,
});
const reviewed = (src, en, id = 'reviewed.test') => ({
  id, src, en, note: 'Reviewed indexed template', source_url: 'https://example.org/review',
});
const build = (entries = [], curated = empty()) => buildPobrExport({ snapshot, entries, curated });
const reasons = result => result.excluded.flatMap(row => row.reasons ?? [row.reason]);

test('zero/one-slot conversion preserves signs, constants, conditions and full attribution', () => {
  const entries = [
    entry('+# to maximum Life', '+# 最大生命', 'explicit.stat_1|1'),
    entry('Gain # Rage every 2 seconds', '每 2 秒获得 # 怒火', 'explicit.stat_2'),
    entry('100 Passive Skill Points become Weapon Set Skill Points', '100 个天赋技能点转变为武器组技能点', 'explicit.stat_3'),
    entry('-#% to Fire Resistance', '-#% 火焰抗性', 'explicit.stat_4'),
  ];
  const before = JSON.stringify(entries);
  const result = build(entries);
  assert.equal(result.schema_version, 1);
  assert.equal(result.snapshot, snapshot);
  assert.equal(result.templates.length, 4);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.templates.find(row => row.en.startsWith('+')).en, '+{0:d} to maximum Life');
  assert.equal(result.templates.find(row => row.en.startsWith('Gain')).src, '每 2 秒获得 {0:d} 怒火');
  assert.equal(result.templates.find(row => row.en.startsWith('100')).en, entries[2].english);
  assert.equal(result.templates.find(row => row.en.startsWith('-')).en, '-{0:d}% to Fire Resistance');
  for (const template of result.templates) {
    assert.equal(template.kind, 'trade');
    const source = entries.find(row => row.id === template.provenance.entries[0].id);
    assert.deepEqual(template.provenance.entries, [source]);
  }
  assert.equal(JSON.stringify(entries), before);
});

test('automatic conversion never invents reduced or negative variants', () => {
  const result = build([entry('#% increased Damage', '伤害提高 #%')]);
  assert.deepEqual(result.templates.map(({ src, en }) => ({ src, en })), [
    { src: '伤害提高 {0:d}%', en: '{0:d}% increased Damage' },
  ]);
});

test('unsafe automatic shapes are diagnostic exclusions, not generic string captures', () => {
  const result = build([
    entry('Adds # to # Fire Damage', '附加 # 至 # 火焰伤害'),
    entry('# maximum Life', '最大生命'),
    entry('{0} maximum Life', '{0} 最大生命'),
    entry('# Life after 2 seconds', '3 秒后获得 # 生命'),
    entry('+# maximum Life', '# 最大生命'),
    entry('# maximum Life', '# maximum Life'),
    entry('# maximum Mana', null, 'explicit.stat_2', { method: 'unresolved', evidence: [] }),
  ]);
  assert.deepEqual(result.templates, []);
  assert.deepEqual(new Set(reasons(result)), new Set([
    'multiple-slots', 'placeholder-arity', 'unsupported-braces', 'literal-number-mismatch',
    'placeholder-sign-mismatch', 'non-chinese', 'unresolved',
  ]));
});

test('same text pairs deduplicate deterministically without dropping enum IDs or evidence', () => {
  const entries = [
    entry('  # to maximum Life ', '# 最大生命', 'explicit.stat_1|2'),
    entry('# to maximum Life', '# 最大生命', 'explicit.stat_1|1'),
    entry('# TO MAXIMUM LIFE', '#最大生命', 'fractured.stat_1', {
      method: 'explicit-reuse', evidence: [{ source: 'trade-cn', id: 'explicit.stat_1|1', text: '# 最大生命' }],
    }),
  ];
  const result = build([...entries, entries[0]]);
  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].provenance.entries.length, 3);
  assert.deepEqual(build([...entries].reverse()), result);
});

test('English and Chinese ambiguity are both excluded after case and whitespace normalization', () => {
  const result = build([
    entry('# to maximum Life', '# 最大生命', 'explicit.stat_1'),
    entry('# TO  MAXIMUM LIFE', '# 生命上限', 'explicit.stat_2'),
    entry('# to maximum Mana', '# 最大魔力', 'explicit.stat_3'),
    entry('# to maximum Energy Shield', '#最大魔力', 'explicit.stat_4'),
  ]);
  assert.deepEqual(result.templates, []);
  assert.equal(result.excluded.length, 4);
  assert.ok(reasons(result).includes('ambiguous-en-to-cn'));
  assert.ok(reasons(result).includes('ambiguous-cn-to-en'));
});

test('a rejected branch cannot silently disambiguate a valid branch', () => {
  const result = build([
    entry('# Life after 2 seconds', '2 秒后获得 # 生命', 'explicit.stat_1'),
    entry('# Life after 2 seconds', '3 秒后获得 # 生命', 'explicit.stat_2'),
  ]);
  assert.deepEqual(result.templates, []);
  assert.ok(reasons(result).includes('literal-number-mismatch'));
  assert.ok(reasons(result).includes('ambiguous-en-to-cn'));
});

test('reviewed nested, string and reordered multi-slot templates stay verbatim', () => {
  const curated = empty();
  curated.templates = [
    reviewed('纽带：{0}', 'Bonded: {0}', 'reviewed.bonded'),
    reviewed('获得技能：{0} 级 {1}', 'Grants Skill: Level {0} {1}', 'reviewed.skill'),
    reviewed('{1} 消耗 {0:d} 魔力', 'Costs {0:d} Mana for {1}', 'reviewed.reordered'),
    reviewed('范围内的核心天赋还会获得：{0}', 'Notable Passive Skills in Radius also grant {0}', 'reviewed.nested'),
  ];
  const result = build([], curated);
  assert.equal(result.templates.length, 4);
  for (const original of curated.templates) {
    assert.deepEqual(result.templates.find(row => row.provenance.id === original.id), {
      src: original.src, en: original.en, kind: 'curated',
      provenance: { id: original.id, note: original.note, source_url: original.source_url },
    });
  }
});

test('curated aliases remain while automatic collisions and duplicates are excluded', () => {
  const curated = empty();
  curated.templates = [
    reviewed('获得 {0} 个天赋技能点', 'Grants {0} Passive Skill Point', 'reviewed.singular'),
    reviewed('获得 {0} 个天赋技能点', 'Grants {0} Passive Skill Points', 'reviewed.plural'),
  ];
  const result = build([
    entry('Grants # Passive Skill Points', '获得 # 个天赋技能点'),
    entry('Grants # Passive Skill Point', '获得 # 点天赋', 'explicit.stat_2'),
    entry('Gain # Points', '获得 # 个天赋技能点', 'explicit.stat_3'),
  ], curated);
  assert.equal(result.templates.length, 2);
  assert.ok(result.templates.every(row => row.kind === 'curated'));
  assert.ok(reasons(result).includes('curated-precedence'));
  assert.ok(reasons(result).includes('ambiguous-en-to-cn'));
  assert.ok(reasons(result).includes('ambiguous-cn-to-en'));
});

test('malformed curated records, placeholder sets and duplicate IDs fail loudly', () => {
  const valid = reviewed('获得 {0} 生命', 'Gain {0} Life');
  const withTemplates = templates => ({ ...empty(), templates });
  for (const patch of [
    { id: '' }, { src: 'untranslated {0}' }, { en: '' }, { note: ' ' },
    { source_url: 'http://example.org' }, { source_url: 'https://' },
  ]) assert.throws(() => build([], withTemplates([{ ...valid, ...patch }])), /Malformed curated template/);
  assert.throws(() => build([], { ...empty(), schema_version: 2 }), /schema_version/);
  assert.throws(() => build([], withTemplates([valid, valid])), /Duplicate curated template ID/);
  assert.throws(() => build([], withTemplates([valid, { ...valid, id: 'other' }])), /Duplicate curated template pair/);
  for (const [src, en] of [
    ['获得 {0} 生命', 'Gain {1} Life'], ['获得 {0} 生命', 'Gain Life'],
    ['获得 {0:d} 生命', 'Gain {0} Life'], ['获得 {0} 生命', 'Gain {0} {2} Life'],
  ]) assert.throws(() => build([], withTemplates([reviewed(src, en)])), /placeholder index set|format mismatch/);
  for (const text of ['获得 {name} 生命', '获得 {{0}} 生命', '获得 {0:f} 生命', '获得 # 生命', '获得 {0 生命']) {
    assert.throws(() => build([], withTemplates([{ ...valid, src: text }])), /Unsupported braces/);
  }
});

test('curated words require reviewed attribution and unique English keys', () => {
  const word = { english: 'Maelstrom', chinese: '漩涡', note: 'Rare-name fallback', source_url: 'https://example.org/review' };
  const withWords = words => ({ ...empty(), words });
  assert.deepEqual(build([], withWords([word])).words, [word]);
  const apostrophe = { ...word, english: "Dragon's", chinese: '龙' };
  assert.deepEqual(build([], withWords([apostrophe])).words, [apostrophe]);
  assert.throws(() => build([], withWords([word, { ...word, english: 'MAELSTROM' }])), /Duplicate curated word/);
  for (const patch of [
    { note: '' }, { chinese: 'Maelstrom' }, { source_url: null }, { english: '{0}' },
    { english: 'maelstrom' }, { english: ' Maelstrom ' }, { english: 'Storm Bite' },
    { english: 'Storm-Bite' }, { english: 'Storm2' }, { english: 'Élan' },
  ]) {
    assert.throws(() => build([], withWords([{ ...word, ...patch }])), /Malformed curated word/);
  }
});

test('dictionary records without attribution or required fields fail rather than emit unverifiable templates', () => {
  for (const patch of [{ id: '' }, { english: '' }, { chinese: undefined }, { method: '' }, { evidence: [] }]) {
    assert.throws(() => build([entry('# Life', '# 生命', 'explicit.stat_1', patch)]), /Malformed PoBR dictionary entry/);
  }
});

test('curated review cannot assign conflicting Chinese translations to the same English', () => {
  const curated = empty();
  curated.templates = [
    reviewed('获得 {0} 生命', 'Gain {0} Life', 'reviewed.life'),
    reviewed('获得 {0} 魔力', 'GAIN  {0} LIFE', 'reviewed.mana'),
  ];
  assert.throws(() => build([], curated), /Conflicting curated English translation/);
});

test('existing manual and supplemental dictionary workflow retains its attribution in exports', () => {
  const entries = [
    entry('# Life', '# 生命', 'explicit.stat_1', { method: 'manual-fallback',
      evidence: [{ source: 'manual-fallback', reason: 'Reviewed Life wording', url: null }] }),
    entry('# Mana', '# 魔力', 'explicit.stat_2', { method: 'poe2db',
      evidence: [{ source: 'poe2db', enUrl: 'https://poe2db.tw/us/Amulets', cnUrl: 'https://poe2db.tw/cn/Amulets' }] }),
  ];
  const result = build(entries);
  assert.equal(result.templates.length, 2);
  for (const source of entries) {
    assert.deepEqual(result.templates.find(row => row.provenance.entries[0].id === source.id).provenance.entries, [source]);
  }
});

async function snapshotFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'poe2-pobr-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, '.cache', `candidate-${snapshot}`);
  await mkdir(path.join(directory, 'raw'), { recursive: true });
  const curatedRaw = JSON.stringify({ ...empty(), templates: [reviewed('纽带：{0}', 'Bonded: {0}')] }) + '\n';
  const translationsRaw = JSON.stringify([{
    id: 'explicit.stat_1', english: '+# to maximum Life', status: 'pending',
    manual_chinese: null, manual_note: '', manual_source_url: null,
  }]) + '\n';
  await writeFile(path.join(root, 'curated.json'), curatedRaw);
  await writeFile(path.join(root, 'overrides.json'), '[]\n');
  await writeFile(path.join(root, 'translations.json'), translationsRaw);
  const manifest = { schema_version: 1, id: snapshot, captured_at: '2026-01-01T00:00:00.000Z', sources: [], pages: [], errors: [] };
  for (const [key, text] of [['trade-en', '+# to maximum Life'], ['trade-cn', '+# 最大生命']]) {
    const raw = JSON.stringify({ result: [{ id: 'explicit', label: 'Explicit', entries: [{ id: 'explicit.stat_1', text }] }] });
    const file = `raw/${key}.json.gz`;
    await writeFile(path.join(directory, file), gzipSync(raw));
    manifest.sources.push({ key, file, sha256: sha256(raw), bytes: Buffer.byteLength(raw), url: `https://example.org/${key}` });
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return { root, directory, curatedRaw, translationsRaw };
}

test('snapshot generation copies and hashes curated input and activation checks the export', async t => {
  const { root, directory, curatedRaw, translationsRaw } = await snapshotFixture(t);
  assert.equal(JSON.parse(translationsRaw)[0].status, 'pending');
  const files = await generateFiles(root, directory);
  assert.equal(files.get('curated.json'), curatedRaw);
  const exported = JSON.parse(files.get('pobr.json'));
  assert.equal(exported.snapshot, snapshot);
  assert.equal(exported.curated_sha256, sha256(curatedRaw));
  assert.equal(exported.source_manifest, '../manifest.json');
  assert.deepEqual(exported.templates.filter(row => row.kind === 'curated').map(({ src, en }) => ({ src, en })),
    [{ src: '纽带：{0}', en: 'Bonded: {0}' }]);
  assert.equal(exported.templates.filter(row => row.kind === 'trade').length, 1);
  assert.equal(JSON.parse(files.get('dictionary.json')).curated_sha256, exported.curated_sha256);
  assert.equal(JSON.parse(files.get('translations.json'))[0].status, 'automatic');
  await writeGenerated(directory, files);
  await checkGenerated(root, directory);
  await writeFile(path.join(directory, 'generated', 'pobr.json'), '{}\n');
  await assert.rejects(activateGenerated(root, directory), /pobr.json/);
  await assert.rejects(readFile(path.join(root, 'data', 'CURRENT')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, 'translations.json'), 'utf8'), translationsRaw);
  await writeGenerated(directory, files);
  await activateGenerated(root, directory);
  assert.equal(await readFile(path.join(root, 'data', 'CURRENT'), 'utf8'), snapshot + '\n');
  const published = path.join(root, 'data', 'snapshots', snapshot);
  assert.equal(await readFile(path.join(published, 'generated', 'pobr.json'), 'utf8'), files.get('pobr.json'));
  assert.equal(await readFile(path.join(root, 'translations.json'), 'utf8'), files.get('translations.json'));
  await checkGenerated(root, published);
  await writeFile(path.join(root, 'curated.json'), curatedRaw + '\n');
  await assert.rejects(checkGenerated(root, published), /stale or modified/);
  assert.equal(await readFile(path.join(published, 'generated', 'curated.json'), 'utf8'), curatedRaw);
});
