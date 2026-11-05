import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createNativeNames, pairNames, NAME_FIELDS } from '../../src/native-names.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = raw => createHash('sha256').update(raw).digest('hex');
const fields = Object.keys(NAME_FIELDS);
function tables(localized = false) {
  return Object.fromEntries(fields.map(table => {
    const [key, field] = NAME_FIELDS[table];
    return [table, { table, raw_resource: `Data/Balance/${localized ? 'Traditional Chinese/' : ''}${table}.datc64`,
      rows: [{ _row: 0, values: { [key]: key === 'HASH32' ? 42 : 'stable',
        ...(key === 'HASH32' ? { Text: 'Name', Wordlist: 1 } : {}), [field]: localized ? '譯名' : 'Name' } }] }];
  }));
}
async function fixture(t) {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const dir = await mkdtemp(path.join(root, '.cache/names-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { schema: 'poe2-native-name-request/v1', language: 'Traditional Chinese', english: [] };
  for (const localized of [false, true]) {
    const target = path.join(dir, localized ? 'localized' : 'english'); await mkdir(target);
    const value = tables(localized), raw = JSON.stringify(value);
    const manifest = { format: localized ? 'repoe-localized-tables/v1' : 'repoe-native-tables/v1',
      status: 'partial-candidate', production_ready: false,
      source_identity: { game: 'poe2', game_patch: '0.5.5.5', realm: 'international',
        ...(localized ? { language: 'Traditional Chinese' } : {}),
        raw_resources: Object.fromEntries(Object.values(value).map(v => [v.raw_resource, { bytes: 1, sha256: 'a'.repeat(64) }])) },
      schema: { revision: 'r', sha256: 'a'.repeat(64), native_specification_sha256: 'b'.repeat(64) },
      files: { 'tables.json': { bytes: Buffer.byteLength(raw), sha256: hash(raw) } } };
    await writeFile(path.join(target, 'tables.json'), raw);
    const doc = JSON.stringify(manifest); await writeFile(path.join(target, 'manifest.json'), doc);
    const input = { manifest: path.join(target, 'manifest.json'), sha256: hash(doc) };
    if (localized) config.localized = input;
    else config.english.push({ ...input, tables: fields });
  }
  return { dir, config };
}

test('pair by stable identity across reordered rows; names and membership propagate', () => {
  const en = tables(), zh = tables(true);
  en.BaseItemTypes.rows.push({ _row: 1, values: { Id: 'second', Name: 'Next' } });
  zh.BaseItemTypes.rows = [{ _row: 0, values: { Id: 'second', Name: '另一名' } }, { _row: 1, values: { Id: 'stable', Name: '新名' } }];
  const result = pairNames(en, zh, 'Traditional Chinese');
  assert.equal(result.entries.find(e => e.table === 'BaseItemTypes' && e.id === 'stable').localized, '新名');
  assert.equal(result.entries.find(e => e.table === 'BaseItemTypes' && e.id === 'second').localized, '另一名');
});
test('English homonyms preserve stable-ID translations and explicit ambiguity', () => {
  const en = tables(), zh = tables(true);
  en.Mods.rows.push({ _row: 1, values: { Id: 'other', Name: 'Name' } });
  zh.Mods.rows.push({ _row: 1, values: { Id: 'other', Name: '別名' } });
  const r = pairNames(en, zh, 'Traditional Chinese');
  assert.equal(r.conflicts.length, 1); assert.equal(r.conflicts[0].alternatives.length, 2);
  assert.equal(r.entries.filter(e => e.table === 'Mods').length, 2);
});
test('missing, empty and unchanged strings stay unresolved without an English fallback', () => {
  const en = tables(), zh = tables(true);
  zh.Mods.rows = []; zh.ActiveSkills.rows[0].values.DisplayedName = '';
  zh.Characters.rows[0].values.Name = 'Name';
  const r = pairNames(en, zh, 'Traditional Chinese');
  assert.deepEqual(new Set(r.excluded.map(e => e.reason)), new Set(['missing-localized-id', 'empty-localized-text', 'unchanged-text']));
});
test('duplicate IDs and non-physical row identity reject', () => {
  const en = tables(), zh = tables(true);
  zh.Mods.rows.push({ _row: 1, values: { Id: 'stable', Name: '重複' } });
  assert.throws(() => pairNames(en, zh, 'Traditional Chinese'), /duplicate/);
  zh.Mods.rows.pop(); zh.Mods.rows[0]._row = 7;
  assert.throws(() => pairNames(en, zh, 'Traditional Chinese'), /identity/);
});
test('Words homonyms pair only by unique raw hash and matching Text/Wordlist', () => {
  const en = tables(), zh = tables(true);
  en.Words.rows.push({ _row: 1, values: { HASH32: 43, Text: 'Name', Wordlist: 2, Text2: 'Name' } });
  zh.Words.rows.push({ _row: 1, values: { HASH32: 43, Text: 'Name', Wordlist: 2, Text2: '另譯' } });
  const r = pairNames(en, zh, 'Traditional Chinese');
  assert.equal(r.entries.filter(e => e.table === 'Words').length, 2);
  assert.equal(r.conflicts.find(c => c.table === 'Words').alternatives.length, 2);
  zh.Words.rows[1].values.Wordlist = 3;
  assert.throws(() => pairNames(en, zh, 'Traditional Chinese'), /hash binding/);
});
test('offline candidate is deterministic, pins all used payloads and refuses overwrite', async t => {
  const { dir, config } = await fixture(t);
  const a = await createNativeNames(config, path.join(dir, 'a'));
  const b = await createNativeNames(config, path.join(dir, 'b'));
  assert.deepEqual(a, b); assert.equal(a.entries.length, 9); assert.equal(a.production_ready, false);
  assert.equal(a.language, 'Traditional Chinese');
  await assert.rejects(createNativeNames(config, path.join(dir, 'a')), /exists/);
  await writeFile(path.join(dir, 'localized/tables.json'), '{}');
  await assert.rejects(createNativeNames(config, path.join(dir, 'bad')), /(pin|Fingerprint)/);
});
test('wrong locale, manifest pin, overlapping ownership and patch mismatch fail before publish', async t => {
  const { dir, config } = await fixture(t);
  await assert.rejects(createNativeNames({ ...config, language: 'Simplified Chinese' }, path.join(dir, 'bad1')), /identity/);
  await assert.rejects(createNativeNames({ ...config, localized: { ...config.localized, sha256: '0'.repeat(64) } }, path.join(dir, 'bad2')), /Fingerprint/);
  await assert.rejects(createNativeNames({ ...config, english: [...config.english, config.english[0]] }, path.join(dir, 'bad3')), /ownership/);
  const m = JSON.parse(await readFile(config.english[0].manifest)); m.source_identity.game_patch = '0.5.5.4';
  const raw = JSON.stringify(m); await writeFile(config.english[0].manifest, raw); config.english[0].sha256 = hash(raw);
  await assert.rejects(createNativeNames(config, path.join(dir, 'bad4')), /game_patch/);
});
