import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CATALOG_FIELDS, CONTEXT_FIELDS, pairDisplayCatalog, createNativeCatalog, createCatalogLookup } from '../src/native-catalog.mjs';
import { NAME_FIELDS, createNativeNames } from '../src/native-names.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const expected = { game_patch: '0.5.5.5', realm: 'international', locale: 'zh-TW' };
function tables(localized = false, language = 'Traditional Chinese') {
  return Object.fromEntries(Object.entries(CATALOG_FIELDS).map(([table, fields]) => {
    const key = NAME_FIELDS[table][0];
    const contexts = Object.fromEntries(CONTEXT_FIELDS[table].map(f => [f, f === 'Text' ? 'Name' : f === 'BaseClass' ? 'Warrior' : f === 'GrantedEffect' ? 'Effect' : 1]));
    const values = { [key]: key === 'HASH32' ? 42 : 'stable', ...contexts,
      ...Object.fromEntries(Object.keys(fields).map(f => [f, localized ? '譯名' : 'Name'])) };
    const columns = Object.keys(values).map((name, source_column) => ({ source_column,
      physical_fields: [name], schema: { name, type: typeof values[name] === 'string' ? 'string' : 'u32', localized: false } }));
    return [table, { table, raw_resource: `Data/Balance/${localized ? language + '/' : ''}${table}.datc64`,
      columns, physical_fields: Object.keys(values), rows: [{ _row: 0, values }] }];
  }));
}
const catalog = (en, zh) => ({ schema: 'poe2-native-catalog/v1', status: 'candidate', production_ready: false,
  game: 'poe2', language: 'Traditional Chinese', ...expected, ...pairDisplayCatalog(en, zh, 'Traditional Chinese') });
const query = (more = {}) => ({ table: 'Words', field: 'Text2', english: 'Name', ...more });
const cloneRow = (table, id, mutate = {}) => ({ _row: table.rows.length,
  values: { ...table.rows[0].values, [NAME_FIELDS[table.table][0]]: id, ...mutate } });
async function fixture(t, language = 'Traditional Chinese') {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const dir = await mkdtemp(path.join(root, '.cache/catalog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = { schema: 'poe2-native-catalog-request/v1', language, english: [] };
  for (const localized of [false, true]) {
    const target = path.join(dir, localized ? 'localized' : 'english'); await mkdir(target);
    const value = tables(localized, language), raw = JSON.stringify(value);
    const manifest = { format: localized ? 'repoe-localized-tables/v1' : 'repoe-native-tables/v1',
      status: 'partial-candidate', production_ready: false,
      source_identity: { game: 'poe2', game_patch: expected.game_patch, realm: expected.realm,
        ...(localized ? { language } : {}),
        raw_resources: Object.fromEntries(Object.values(value).map(t => [t.raw_resource, { bytes: 1, sha256: 'a'.repeat(64) }])) },
      schema: { revision: 'r', sha256: 'a'.repeat(64), native_specification_sha256: 'b'.repeat(64) },
      files: { 'tables.json': { bytes: Buffer.byteLength(raw), sha256: hash(raw) } } };
    await writeFile(path.join(target, 'tables.json'), raw);
    const doc = JSON.stringify(manifest); await writeFile(path.join(target, 'manifest.json'), doc);
    const input = { manifest: path.join(target, 'manifest.json'), sha256: hash(doc) };
    if (localized) config.localized = input;
    else config.english.push({ ...input, tables: Object.keys(CATALOG_FIELDS) });
  }
  return { dir, config };
}
async function mutateSource(config, mutate) {
  const file = config.localized.manifest, manifest = JSON.parse(await readFile(file));
  const payload = path.join(path.dirname(file), 'tables.json'), tables = JSON.parse(await readFile(payload));
  mutate(tables); const raw = JSON.stringify(tables); await writeFile(payload, raw);
  manifest.files['tables.json'] = { bytes: Buffer.byteLength(raw), sha256: hash(raw) };
  const doc = JSON.stringify(manifest); await writeFile(file, doc); config.localized.sha256 = hash(doc);
}

test('18 real display fields retain separate table/identity/field and source row contexts', () => {
  const en = tables(), zh = tables(true);
  zh.ActiveSkills.rows[0].values.Description = '實際技能說明';
  zh.PassiveSkills.rows[0].values.FlavourText = '天賦風味';
  zh.Words.rows[0].values.Inflection = '變格';
  const c = catalog(en, zh), lookup = createCatalogLookup(c, expected);
  assert.equal(c.records.length, 18);
  assert.equal(lookup(query({ table: 'ActiveSkills', field: 'Description', id: 'stable' })).text, '實際技能說明');
  assert.equal(lookup(query({ table: 'PassiveSkills', field: 'FlavourText', id: 'stable' })).text, '天賦風味');
  assert.equal(lookup(query({ field: 'Inflection', id: 42 })).text, '變格');
  assert.equal(c.records.find(r => r.table === 'PassiveSkills').context.english.PassiveSkillGraphId, 1);
});

test('Words hash identities and explicit Wordlist context disambiguate collisions without first-match', () => {
  const en = tables(), zh = tables(true);
  en.Words.rows.push(cloneRow(en.Words, 43, { Wordlist: 2 }));
  zh.Words.rows.push(cloneRow(zh.Words, 43, { Wordlist: 2, Text2: '另一譯名' }));
  const c = catalog(en, zh), lookup = createCatalogLookup(c, expected);
  assert.equal(lookup(query()).reason, 'ambiguous-english');
  assert.equal(lookup(query({ id: 43 })).text, '另一譯名');
  assert.equal(lookup(query({ context: { Wordlist: 2 } })).text, '另一譯名');
  assert.equal(lookup(query({ context: { Wordlist: 3 } })).reason, 'context-mismatch');
  assert.ok(c.conflicts.some(c => c.field === 'Text2' && c.alternatives.length === 2));
  zh.Words.rows[1].values.Text = 'Changed';
  assert.throws(() => catalog(en, zh), /hash binding/);
});

test('unresolved homonyms remain blockers even if only one translated alternative exists', () => {
  const en = tables(), zh = tables(true);
  en.Mods.rows.push(cloneRow(en.Mods, 'other'));
  zh.Mods.rows.push(cloneRow(zh.Mods, 'other', { Name: '' }));
  const c = catalog(en, zh), lookup = createCatalogLookup(c, expected);
  const q = query({ table: 'Mods', field: 'Name' });
  assert.equal(lookup(q).reason, 'unresolved-homonym');
  assert.equal(lookup({ ...q, id: 'stable' }).text, '譯名');
  assert.equal(lookup({ ...q, id: 'other' }).reason, 'empty-localized-text');
  assert.equal(c.conflicts.find(c => c.table === 'Mods').reason, 'incomplete-homonym');
});

test('placeholder reordering preserves raw formats, signs, repeats, references and literal conditions', () => {
  const en = tables(), zh = tables(true);
  const left = 'After 2 seconds [Damage|Damage] {0:+d} to {1:0.00} and {0:+d}', right = '2 秒後 [Damage|傷害] {1:0.00} 至 {0:+d} 及 {0:+d}';
  en.ActiveSkills.rows[0].values.Description = left; zh.ActiveSkills.rows[0].values.Description = right;
  const c = catalog(en, zh), row = c.records.find(r => r.table === 'ActiveSkills' && r.field === 'Description');
  assert.equal(row.status, 'translated');
  assert.equal(row.english, left); assert.equal(row.localized, right);
  assert.deepEqual(row.templates.localized.placeholders.map(p => p.format_raw), ['0.00', '+d', '+d']);
  assert.equal(row.templates.localized.references[0].key_raw, 'Damage');
  assert.deepEqual(row.templates.localized.literal_numbers, ['2']);
});

test('malformed, missing, repeated/format/sign/hash slots, references and literal changes fall back honestly', () => {
  for (const [left, right, reason] of [
    ['Gain {0} Life', '獲得 {1} 生命', 'placeholder-mismatch'],
    ['Gain {0} and {0} Life', '獲得 {0} 生命', 'placeholder-mismatch'],
    ['Gain {0:d} Life', '獲得 {0} 生命', 'placeholder-mismatch'],
    ['Gain −{0} Life', '獲得 {0} 生命', 'placeholder-mismatch'],
    ['Gain # Life', '獲得生命', 'placeholder-mismatch'],
    ['Gain {0} Life', '獲得 {bad} 生命', 'unresolved-template-syntax'],
    ['Gain [Life|Life]', '獲得 [Mana|生命]', 'reference-mismatch'],
    ['Gain 2 Life', '獲得 3 生命', 'literal-number-mismatch'],
  ]) {
    const en = tables(), zh = tables(true);
    en.ActiveSkills.rows[0].values.Description = left; zh.ActiveSkills.rows[0].values.Description = right;
    const c = catalog(en, zh), lookup = createCatalogLookup(c, expected);
    const result = lookup(query({ table: 'ActiveSkills', field: 'Description', id: 'stable', english: left }));
    assert.equal(result.reason, reason); assert.equal(result.text, left);
    assert.equal(c.records.find(r => r.table === 'ActiveSkills' && r.field === 'Description').localized, right);
  }
});

test('missing rows, unchanged text and changed English never resurrect a stale translation', () => {
  const en = tables(), zh = tables(true);
  zh.Characters.rows = []; zh.Mods.rows[0].values.Name = 'Name';
  const c = catalog(en, zh), lookup = createCatalogLookup(c, expected);
  assert.equal(lookup(query({ table: 'Characters', field: 'Name', id: 'stable' })).reason, 'missing-localized-id');
  assert.equal(lookup(query({ table: 'Mods', field: 'Name', id: 'stable' })).reason, 'unchanged-text');
  assert.equal(lookup(query({ id: 42, english: 'Old Name' })).reason, 'source-english-changed');
  assert.throws(() => createCatalogLookup(c, { ...expected, locale: 'zh-CN' }), /locale/);
  assert.throws(() => createCatalogLookup(c, { ...expected, game_patch: '0.5.5.4' }), /game_patch/);
});

test('consumer rejects duplicate identities, incomplete inventories and tampered template status', () => {
  const c = catalog(tables(), tables(true));
  const dup = structuredClone(c); dup.records.push(dup.records[0]);
  assert.throws(() => createCatalogLookup(dup, expected), /Duplicate/);
  const missing = structuredClone(c); missing.records.pop();
  assert.throws(() => createCatalogLookup(missing, expected), /coverage/);
  const tampered = structuredClone(c); tampered.records[0].localized = '新增 {0}';
  assert.throws(() => createCatalogLookup(tampered, expected), /status\/templates/);
});

test('pinned export is deterministic and source/column changes propagate; manifest seals exact files', async t => {
  const { dir, config } = await fixture(t);
  const a = await createNativeCatalog(config, path.join(dir, 'a'));
  const b = await createNativeCatalog(config, path.join(dir, 'b')); assert.deepEqual(a, b);
  const binding = a.bindings.ActiveSkills.localized.columns.Description;
  assert.equal(binding.schema.localized, false); assert.equal(binding.source_column, 3);
  const manifest = JSON.parse(await readFile(path.join(dir, 'a/manifest.json')));
  for (const [file, pin] of Object.entries(manifest.files)) {
    const raw = await readFile(path.join(dir, 'a', file)); assert.equal(hash(raw), pin.sha256); assert.equal(raw.length, pin.bytes);
  }
  await mutateSource(config, tables => { tables.ActiveSkills.rows[0].values.Description = '新來源說明'; });
  const changed = await createNativeCatalog(config, path.join(dir, 'changed'));
  assert.equal(createCatalogLookup(changed, expected)(query({ table: 'ActiveSkills', field: 'Description', id: 'stable' })).text, '新來源說明');
  assert.notEqual(a.bindings.ActiveSkills.localized.manifest_sha256, changed.bindings.ActiveSkills.localized.manifest_sha256);
  await assert.rejects(createNativeCatalog(config, path.join(dir, 'a')), /exists/);
  await mutateSource(config, tables => { tables.ActiveSkills.columns = tables.ActiveSkills.columns.filter(c => c.schema.name !== 'Description'); });
  await assert.rejects(createNativeCatalog(config, path.join(dir, 'bad-column')), /source column/);
});

test('explicit Simplified Chinese fixtures require their own language and raw paths; v1 names remain compatible', async t => {
  const { dir, config } = await fixture(t, 'Simplified Chinese');
  const result = await createNativeCatalog(config, path.join(dir, 'sc'));
  assert.equal(result.locale, 'zh-CN'); assert.match(result.bindings.Words.localized.raw_resource, /Simplified Chinese/);
  await assert.rejects(createNativeCatalog({ ...config, language: 'Traditional Chinese' }, path.join(dir, 'wrong')), /identity/);
  const old = await createNativeNames({ ...config, schema: 'poe2-native-name-request/v1' }, path.join(dir, 'names'));
  assert.equal(old.schema, 'poe2-native-names/v1'); assert.equal(old.entries.length, 9);
  for (const row of old.entries) assert.equal(result.records.find(r => r.table === row.table && r.field === row.field && r.id === row.id).localized, row.localized);
});

test('explicit partial locale acquisition exports only selected tables without claiming other name coverage', async t => {
  const { dir, config } = await fixture(t, 'Simplified Chinese');
  config.tables = ['Words', 'Ascendancy']; config.english[0].tables = config.tables;
  const result = await createNativeCatalog(config, path.join(dir, 'partial'));
  assert.deepEqual(result.selected_tables, ['Words', 'Ascendancy']);
  assert.deepEqual(Object.keys(result.bindings), ['Words', 'Ascendancy']);
  assert.equal(result.records.length, 4);
  const lookup = createCatalogLookup(result, { ...expected, locale: 'zh-CN' });
  assert.equal(lookup(query({ id: 42 })).text, '譯名'); // Synthetic locale fixture, not acquired SC evidence.
  assert.equal(lookup(query({ table: 'Characters', field: 'Name', id: 'stable' })).reason, 'missing-identity-or-text');
  await assert.rejects(createNativeCatalog({ ...config, tables: ['Words', 'Words'] }, path.join(dir, 'duplicate')), /scope/);
});

test('resealed duplicate JSON keys and unpinned source mutations reject before publication', async t => {
  const { dir, config } = await fixture(t);
  const file = path.join(dir, 'localized/tables.json'), raw = await readFile(file, 'utf8');
  await writeFile(file, raw + ' ');
  await assert.rejects(createNativeCatalog(config, path.join(dir, 'bad-pin')), /(Fingerprint|byte pin)/);
  const duplicate = raw.replace('{', '{"ActiveSkills":{},'); await writeFile(file, duplicate);
  const manifest = JSON.parse(await readFile(config.localized.manifest));
  manifest.files['tables.json'] = { bytes: Buffer.byteLength(duplicate), sha256: hash(duplicate) };
  const doc = JSON.stringify(manifest); await writeFile(config.localized.manifest, doc); config.localized.sha256 = hash(doc);
  await assert.rejects(createNativeCatalog(config, path.join(dir, 'bad-json')), /Duplicate JSON key/);
});
