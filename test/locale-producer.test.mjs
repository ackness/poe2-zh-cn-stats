import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DICTIONARY_FILES, projectLegacy, layerSelectedPairs, produceLocale } from '../src/locale-producer.mjs';

const bytes = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const pin = b => ({ bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });
const table = (column, values) => ({ entries: values.map(([id, en, zh]) => ({ id, columns: { [column]: [{ en, zh }] } })) });
const translation = { repository: 'https://example.test/translation', commit: 'b'.repeat(40), snapshot: '20261012T000000000Z', mode: 'pinned' };
const bundle = { schema_version: 1, snapshot: translation.snapshot, templates: [], excluded: [], words: [
  { english: 'Storm', chinese: '风暴', note: 'reviewed', source_url: 'https://example.test/words' },
  { english: 'Bite', chinese: '利齿', note: 'reviewed', source_url: 'https://example.test/words' },
] };
const identity = { dictionary: { repository: 'https://example.test/dict', commit: 'a'.repeat(40) }, translation };
function dictionary() {
  return { 'lookup/stat_lines.json': [{ forms: [{ en: 'Life', zh: '生命' }, { en: 'Life', zh: '生命' }, { en: null, zh: '未知' }] }],
    'lookup/en_to_cn.json': { Storm: '雷霆', Ignored: null },
    'tables/BaseItemTypes.json': table('Name', [['b', 'Base', '基底'], ['a', 'Missing', null]]),
    'tables/ActiveSkills.json': table('DisplayedName', [['s', 'Strike', '打击']]),
    'tables/Characters.json': table('Name', [['c', 'Warrior', '战士']]),
    'tables/Ascendancy.json': table('Name', []), 'tables/Words.json': table('Text2', [['w', 'Strike', '重击']]),
    'tables/PassiveSkills.json': table('Name', [['p', 'Node', '节点']]),
    'tables/Mods.json': table('Name', [['m', 'Sharp', '锐利']]), 'meta.json': { generatedAt: null } };
}

test('legacy projection omits null names, preserves reviewed fallback priority and deduplicates pairs', () => {
  const result = projectLegacy(dictionary(), bundle, identity);
  assert.deepEqual(result.files['base_items.json'], { b: '基底' });
  assert.equal(result.files['words.json'].Strike, '重击');
  assert.deepEqual(result.files['rare_words.json'], { Bite: '利齿', Storm: '雷霆' });
  assert.deepEqual(result.files['stat_lines.json'], [{ src: '生命', en: 'Life' }]);
  assert.deepEqual(result.audit.word_patches[0], { english: 'Storm', proposed: '风暴', retained: '雷霆' });
});

test('selected layering pins intermediate bytes and retains old pairs in sorted order', () => {
  const old = [{ src: '生命', en: 'Life' }], first = [{ src: '护甲', en: 'Armour' }], second = [{ src: '魔力', en: 'Mana' }];
  const baseline = [...first, ...old], final = [...baseline, ...second];
  const delta = { schema: 'pobr-native-selected-pair-delta/v1', old_pairs: 1, added_count: 1, removed_count: 0,
    baseline_pairs: 2, added_pairs: first, input_pins: [pin(bytes(old)), pin(bytes(baseline))] };
  const selected = { schema: 'poe2-selected-literal-layer/v1', baseline: { ...pin(bytes(baseline)), pairs: 2 },
    output: pin(bytes(final)), added: second };
  assert.deepEqual(layerSelectedPairs(old, delta, selected), final);
  assert.throws(() => layerSelectedPairs(old, { ...delta, added_pairs: old }, selected), /duplicate/);
  assert.throws(() => layerSelectedPairs(old, delta, { ...selected, baseline: { ...selected.baseline, sha256: '0'.repeat(64) } }), /baseline pin/);
});

test('offline CLI contract pins all input bytes, creates deterministic receipts and fails without partial output', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'locale-producer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const data = dictionary(), inputs = {};
  for (const f of DICTIONARY_FILES) {
    const name = `dictionary/${f}`, b = bytes(data[f]); await mkdir(path.dirname(path.join(inputDir, name)), { recursive: true });
    await writeFile(path.join(inputDir, name), b); inputs[name] = { ...pin(b), source: { fixture: true } };
  }
  const tb = bytes(bundle); await writeFile(path.join(inputDir, 'templates.json'), tb);
  inputs['templates.json'] = { ...pin(tb), source: { fixture: true } };
  const manifest = { schema: 'poe2-locale-generation-input/v1', profile: 'legacy', target: { game: 'poe2', game_patch: 'test', realm: 'international' },
    identity: { ...identity, translation: { ...translation, sha256: pin(tb).sha256 } }, inputs };
  const mb = bytes(manifest), manifestPath = path.join(root, 'manifest.json'); await writeFile(manifestPath, mb);
  const options = { manifestPath, manifestSha256: pin(mb).sha256, inputDir, out: path.join(root, 'out') };
  const receipt = await produceLocale(options);
  assert.equal(receipt.schema, 'poe2-locale-generation-receipt/v1');
  assert.equal(receipt.files['i18n/zh-CN/stat_lines.json'].sha256, pin(await readFile(path.join(options.out, 'i18n/zh-CN/stat_lines.json'))).sha256);
  const another = await produceLocale({ ...options, out: path.join(root, 'out2') });
  assert.deepEqual(receipt, another);
  await assert.rejects(produceLocale(options), /EEXIST/);
  const wrong = { ...manifest, expected_files: { ...receipt.files, 'i18n/zh-CN/stat_lines.json': { bytes: 1, sha256: '0'.repeat(64) } } };
  const wrongBytes = bytes(wrong), wrongPath = path.join(root, 'wrong-manifest.json');
  await writeFile(wrongPath, wrongBytes);
  await assert.rejects(produceLocale({ ...options, manifestPath: wrongPath, manifestSha256: pin(wrongBytes).sha256,
    out: path.join(root, 'wrong-output') }), /expected output pin/);
  await assert.rejects(readFile(path.join(root, 'wrong-output', 'receipt.json')), /ENOENT/);
  await writeFile(path.join(inputDir, 'templates.json'), '{}');
  const failedOut = path.join(root, 'failed');
  await assert.rejects(produceLocale({ ...options, out: failedOut }), /input pin mismatch/);
  await assert.rejects(readFile(path.join(failedOut, 'receipt.json')), /ENOENT/);
  await assert.rejects(produceLocale({ ...options, manifestSha256: '0'.repeat(64), out: failedOut }), /manifest SHA-256/);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.out, 'receipt.json'))), receipt);
});
