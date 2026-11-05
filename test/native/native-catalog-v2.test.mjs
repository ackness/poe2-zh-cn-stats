import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNativeCatalog, createCatalogLookup } from '../../src/native-catalog.mjs';
import { nativeBytes } from '../../src/native-localization.mjs';

// Source-owner synthetic example metadata; no Windows or acquired game rows.
const seed = JSON.parse(await readFile(new URL('../fixtures/native-catalog-v2-target.json', import.meta.url)));
const wordsSeed = JSON.parse(await readFile(new URL('../fixtures/native-catalog-v2-words.json', import.meta.url)));
const root = fileURLToPath(new URL('../../', import.meta.url));
const hash = b => createHash('sha256').update(b).digest('hex');
const fp = b => ({ bytes: b.length, sha256: hash(b) });
const policy = 'stable-key-current-english-all-nontext/v1';
const targetIdentity = { game: 'poe2', game_patch: '0.5.5.5', realm: 'international' };
const expected = { ...targetIdentity, locale: 'zh-CN' };
const textFields = ['Name', 'FlavourText'];
function data(name = 'Ascendancy') {
  const source = name === 'Words' ? wordsSeed : seed;
  const target = structuredClone(source.table), defaults = structuredClone(source.table), localized = structuredClone(source.table);
  defaults.raw_resource = `data/balance/${name.toLowerCase()}.datc64`;
  localized.raw_resource = `data/balance/simplified chinese/${name.toLowerCase()}.datc64`;
  if (name === 'Words') localized.rows[0].values.Text2 = '夹具稀有名';
  else { localized.rows[0].values.Name = '夹具译名'; localized.rows[0].values.FlavourText = '夹具说明'; }
  return { target, defaults, localized };
}
function record(d, id, overrides = {}) {
  const name = d.target.table, key = name === 'Words' ? 'HASH32' : 'Id';
  const fields = name === 'Words' ? ['Text2', 'Inflection', 'Text'] : textFields;
  id ??= d.target.rows[0].values[key];
  const rows = [d.defaults, d.localized, d.target].map(t => t.rows.filter(r => r.values[key] === id));
  return { table: name, key_field: key, id, decision: 'accepted', binding_kind: 'resource-bound', reason_codes: [],
    source_default_rows: rows[0].map(r => r._row), source_localized_rows: rows[1].map(r => r._row), target_rows: rows[2].map(r => r._row),
    english: rows[2].length === 1 ? Object.fromEntries(fields.map(f => [f, rows[2][0].values[f]])) : {},
    comparison: { source_nontext_equal: true, target_nontext_equal: true, target_english_equal: true },
    differing_fields: { source_nontext: [], target_nontext: [], target_english: [] }, ...overrides };
}
const emptyComparison = { source_nontext_equal: null, target_nontext_equal: null, target_english_equal: null };
async function fixture(t, name = 'Ascendancy', targetSchemaMetadata = {}) {
  await mkdir(path.join(root, '.cache'), { recursive: true });
  const dir = await mkdtemp(path.join(root, '.cache/catalog-v2-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'target')); await mkdir(path.join(dir, 'observed'));
  const d = data(name), fields = name === 'Words' ? ['Text2', 'Inflection'] : textFields;
  return { dir, d, async seal(records = [record(d)], mutate = () => {}) {
    const rawPin = table => fp(nativeBytes({ synthetic_row_values: table.rows.map(r => r.values) }));
    for (const table of Object.values(d)) table.validation.rows = table.rows.length;
    const enRaw = nativeBytes({ [name]: d.target });
    const enManifest = { format: 'repoe-native-tables/v1', status: 'partial-candidate', production_ready: false,
      schema: { ...seed.schema, ...targetSchemaMetadata }, source_identity: { ...targetIdentity, raw_resources: { [d.target.raw_resource]: rawPin(d.target) } },
      files: { 'tables.json': fp(enRaw) } };
    const enManifestRaw = nativeBytes(enManifest);
    await writeFile(path.join(dir, 'target/tables.json'), enRaw); await writeFile(path.join(dir, 'target/manifest.json'), enManifestRaw);
    const pins = { ...targetIdentity, language: 'English', manifest_sha256: hash(enManifestRaw), payload: 'tables.json',
      payload_bytes: enRaw.length, payload_sha256: hash(enRaw), table_pointer: '/' + name, raw_resource: d.target.raw_resource,
      raw_identity: rawPin(d.target), schema: seed.schema, columns_sha256: hash(nativeBytes(d.target.columns.map(c => c.schema))) };
    const resourceEqual = hash(nativeBytes(rawPin(d.defaults))) === hash(nativeBytes(rawPin(d.target)));
    const bindingRows = structuredClone(records).map(r => ({ ...r, binding_kind: resourceEqual ? 'resource-bound' : 'record-bound' }));
    const nontext = d.target.physical_fields.filter(f => !fields.includes(f));
    const entry = { key_field: name === 'Words' ? 'HASH32' : 'Id', text_fields: fields, nontext_fields: nontext,
      source_default_raw_equals_target: resourceEqual, target_pins: pins, records: bindingRows };
    const client = { game: 'poe2', game_patch: null, realm: null, index_sha256: 'a'.repeat(64) };
    const decoder = { method: 'stdlib-memory-schema-decoder/v2', python: 'synthetic-fixture', source_sha256: 'b'.repeat(64) };
    const receipt = { format: 'repoe-decoded-table-transfer/v1', language: 'Simplified Chinese', observed_client: client,
      schema: { revision: seed.schema.revision, sha256: seed.schema.sha256 },
      decoder, patch_certified: false, realm_certified: false, acquisition_evidence: [{ kind: 'synthetic-fixture' }],
      tables: { [name]: { default: { raw_resource: d.defaults.raw_resource, raw_identity: rawPin(d.defaults) },
        localized: { raw_resource: d.localized.raw_resource, raw_identity: rawPin(d.localized) } } } };
    const payloads = { 'tables.json': { [name]: d.localized }, 'default-tables.json': { [name]: d.defaults },
      'target_binding.json': { policy_id: policy, target_identity: targetIdentity, row_addresses_are_identity: false,
        reference_policy: 'Synthetic physical values only; no foreign-row semantics.', tables: { [name]: entry } },
      'transfer-receipt.json': receipt, 'target-lock.json': { format: 'synthetic-target-lock', tables: { [name]: pins } },
      'wire-observations.json': { synthetic: true } };
    mutate({ payloads, entry, pins, receipt, client, decoder });
    const files = {};
    for (const [name, value] of Object.entries(payloads)) { const raw = nativeBytes(value); await writeFile(path.join(dir, 'observed', name), raw); files[name] = fp(raw); }
    const manifest = { format: 'repoe-localized-tables/v2', status: 'partial-observation-candidate', production_ready: false,
      source_identity: { game: 'poe2', game_patch: null, realm: null, language: 'Simplified Chinese',
        kind: 'decoded-client-language-observation', observation_receipt_sha256: files['transfer-receipt.json'].sha256,
        raw_resources: { [d.localized.raw_resource]: rawPin(d.localized) } },
      observed_client: { ...client, resources: { [d.defaults.raw_resource]: rawPin(d.defaults), [d.localized.raw_resource]: rawPin(d.localized) } },
      schema: seed.schema, decoder, ingest: { method: 'decoded-observation-validation/v1', raw_dat_redecoded: false,
        transfer_receipt_sha256: files['transfer-receipt.json'].sha256, target_lock_sha256: files['target-lock.json'].sha256 },
      producer: { synthetic_fixture: 'c'.repeat(64) }, files,
      target_binding: { policy_id: policy, ...targetIdentity, file: 'target_binding.json',
        tables: { [name]: { target_pins: pins, text_fields: fields, nontext_fields: nontext } } },
      summary: { tables: { [name]: d.localized.rows.length }, bindings: { [name]: {
        accepted: bindingRows.filter(r => r.decision === 'accepted').length, rejected: bindingRows.filter(r => r.decision === 'rejected').length } } } };
    const manifestRaw = nativeBytes(manifest); await writeFile(path.join(dir, 'observed/manifest.json'), manifestRaw);
    return { schema: 'poe2-native-catalog-request/v2', language: 'Simplified Chinese', tables: [name],
      localized: { manifest: path.join(dir, 'observed/manifest.json'), sha256: hash(manifestRaw) },
      english: [{ manifest: path.join(dir, 'target/manifest.json'), sha256: hash(enManifestRaw), tables: [name] }] };
  } };
}
const query = (c, more = {}) => ({ table: 'Ascendancy', field: 'Name', id: c.records[0].id, english: c.records[0].english, ...more });

test('v2 pins schema identity separately from sealed native package metadata', async t => {
  const f = await fixture(t, 'Ascendancy', { compatibility_views: 0 }), config = await f.seal();
  const c = await createNativeCatalog(config, path.join(f.dir, 'catalog'));
  assert.equal(c.sources[1].schema.compatibility_views, 0);
  assert.deepEqual(c.target_binding.tables.Ascendancy.target_pins.schema, seed.schema);
  assert.equal(createCatalogLookup(c, expected)(query(c)).text, '夹具译名');
  const wrong = await fixture(t, 'Ascendancy', { compatibility_views: 0, sha256: 'f'.repeat(64) });
  await assert.rejects(createNativeCatalog(await wrong.seal(), path.join(wrong.dir, 'catalog')), /schema differs/);
});

test('v2 resource-bound SC text keeps null observation identity and explicit target runtime; deterministic files', async t => {
  const f = await fixture(t), config = await f.seal();
  const a = await createNativeCatalog(config, path.join(f.dir, 'a')), b = await createNativeCatalog(config, path.join(f.dir, 'b'));
  assert.deepEqual(a, b); assert.equal(a.schema, 'poe2-native-catalog/v2');
  assert.equal(a.observed_client.game_patch, null); assert.equal(a.observed_client.realm, null);
  assert.deepEqual(a.target_binding.target_identity, targetIdentity); assert.equal(a.sources[0].source_identity.game_patch, null);
  assert.equal(a.records[0].applicability.binding_kind, 'resource-bound');
  assert.match(a.bindings.Ascendancy.localized.raw_resource, /^data\/balance\/simplified chinese\//);
  assert.equal(createCatalogLookup(a, expected)(query(a)).text, '夹具译名');
  await assert.rejects(createNativeCatalog(config, path.join(f.dir, 'a')), /exists/);
  assert.throws(() => createCatalogLookup(a, { ...expected, locale: 'zh-TW' }), /locale/);
});

test('v2 joins reordered records by key and checks whole nontext structure rather than row position', async t => {
  const f = await fixture(t), id = f.d.target.rows[0].values.Id;
  for (const table of Object.values(f.d)) table.rows.push({ _row: 1, values: { ...table.rows[0].values, Id: 'OtherFixture', Name: 'Other', FlavourText: 'Other text' } });
  f.d.localized.rows[1].values.Name = '另一夹具'; f.d.localized.rows[1].values.FlavourText = '另一说明';
  f.d.defaults.rows.reverse().forEach((r, i) => { r._row = i; });
  f.d.localized.rows.reverse().forEach((r, i) => { r._row = i; });
  const config = await f.seal([record(f.d, id), record(f.d, 'OtherFixture')]);
  const c = await createNativeCatalog(config, path.join(f.dir, 'a')), lookup = createCatalogLookup(c, expected);
  assert.equal(c.records[0].applicability.binding_kind, 'record-bound');
  assert.equal(lookup(query(c)).text, '夹具译名');
  assert.equal(lookup(query(c, { id: 'OtherFixture', english: 'Other' })).text, '另一夹具');
  assert.equal(c.records[0].english_row, 0); assert.equal(c.records[0].localized_row, 1);
});

test('v2 rejected nontext/English changes retain actual candidate strings and fall back', async t => {
  for (const role of ['localized', 'target', 'english']) {
    const f = await fixture(t); const r = record(f.d);
    if (role === 'english') f.d.target.rows[0].values.Name = 'Changed current English';
    else f.d[role].rows[0].values.Unknown0--;
    const mismatch = role === 'localized' ? 'source_nontext' : role === 'target' ? 'target_nontext' : 'target_english';
    const declared = record(f.d, r.id, { decision: 'rejected', reason_codes: [mismatch + '-mismatch'],
      comparison: { source_nontext_equal: role !== 'localized', target_nontext_equal: role !== 'target', target_english_equal: role !== 'english' },
      differing_fields: { source_nontext: role === 'localized' ? ['Unknown0'] : [], target_nontext: role === 'target' ? ['Unknown0'] : [], target_english: role === 'english' ? ['Name'] : [] } });
    const c = await createNativeCatalog(await f.seal([declared]), path.join(f.dir, 'a'));
    const result = createCatalogLookup(c, expected)(query(c));
    assert.equal(result.reason, 'target-binding-rejected'); assert.equal(result.text, c.records[0].english);
    assert.equal(c.records[0].localized, '夹具译名'); assert.deepEqual(c.records[0].applicability.reason_codes, [mismatch + '-mismatch']);
  }
});

test('v2 duplicate localized keys preserve all rows/texts and block text-only homonyms without selecting first', async t => {
  const f = await fixture(t), id = f.d.target.rows[0].values.Id, en = f.d.target.rows[0].values.Name;
  f.d.localized.rows.push({ _row: 1, values: { ...f.d.localized.rows[0].values, Name: '重复候选' } });
  for (const table of Object.values(f.d)) table.rows.push({ _row: table.rows.length,
    values: { ...table.rows[0].values, Id: 'OtherFixture', Name: table === f.d.localized ? '另一译文' : en } });
  const rejected = record(f.d, id, { decision: 'rejected', reason_codes: ['source-localized-duplicate-key'], comparison: emptyComparison, differing_fields: {} });
  const c = await createNativeCatalog(await f.seal([rejected, record(f.d, 'OtherFixture')]), path.join(f.dir, 'a'));
  const lookup = createCatalogLookup(c, expected);
  assert.equal(c.records[0].localized, null); assert.deepEqual(c.records[0].candidates.localized.map(r => r.text), ['夹具译名', '重复候选']);
  assert.equal(lookup(query(c)).reason, 'target-binding-rejected');
  assert.equal(lookup({ table: 'Ascendancy', field: 'Name', english: en }).reason, 'unresolved-homonym');
  assert.equal(lookup(query(c, { id: 'OtherFixture' })).text, '另一译文');
});

test('v2 missing source keys remain complete binding diagnoses, with no stale text revival', async t => {
  const f = await fixture(t); f.d.localized.rows = [];
  const r = record(f.d, undefined, { decision: 'rejected', reason_codes: ['source-localized-missing-key'], comparison: emptyComparison, differing_fields: {} });
  const c = await createNativeCatalog(await f.seal([r]), path.join(f.dir, 'a'));
  assert.equal(c.coverage.Ascendancy.Name.localized_rows, 0);
  assert.equal(createCatalogLookup(c, expected)(query(c)).reason, 'target-binding-rejected');
});

test('v2 input changes propagate through pins and current English/translated text without relabeling source', async t => {
  const f = await fixture(t), before = await createNativeCatalog(await f.seal(), path.join(f.dir, 'a'));
  f.d.defaults.rows[0].values.Name = 'New current English'; f.d.target.rows[0].values.Name = 'New current English';
  f.d.localized.rows[0].values.Name = '新的夹具译文';
  const after = await createNativeCatalog(await f.seal(), path.join(f.dir, 'b')), lookup = createCatalogLookup(after, expected);
  assert.notEqual(before.sources[0].manifest_sha256, after.sources[0].manifest_sha256);
  assert.equal(lookup(query(after)).text, '新的夹具译文');
  assert.equal(lookup(query(after, { english: before.records[0].english })).reason, 'source-english-changed');
});

test('v2 does not trust forged accepted flags, wrong current English, target pins, row refs or omitted inventory', async t => {
  for (const mutation of ['accepted', 'english', 'pins', 'rows', 'missing', 'receipt-schema']) {
    const f = await fixture(t); if (mutation === 'accepted') f.d.localized.rows[0].values.Unknown0--;
    const config = await f.seal(undefined, ({ entry, receipt }) => {
      if (mutation === 'english') entry.records[0].english.Name = 'Forged English';
      if (mutation === 'pins') entry.target_pins.payload_sha256 = '0'.repeat(64);
      if (mutation === 'rows') entry.records[0].source_localized_rows = [99];
      if (mutation === 'missing') entry.records = [];
      if (mutation === 'receipt-schema') receipt.schema.sha256 = '0'.repeat(64);
    });
    await assert.rejects(createNativeCatalog(config, path.join(f.dir, 'bad')), /(binding|pins|schema)/i, mutation);
  }
});

test('v2 rejects typed/schema drift and unsafe resource aliases before publication', async t => {
  for (const mutation of ['typed', 'column', 'path']) {
    const f = await fixture(t);
    if (mutation === 'typed') f.d.localized.rows[0].values.Unknown0 = 'wrong type';
    if (mutation === 'column') f.d.localized.columns[0].schema.type = 'bool';
    if (mutation === 'path') f.d.localized.raw_resource = 'data/balance/traditional chinese/ascendancy.datc64';
    await assert.rejects(createNativeCatalog(await f.seal(), path.join(f.dir, 'bad')), /(typed|schema|resource)/i);
  }
});

test('v2 keeps v1 guards and unknown observation identity distinct; unused ancillary files are pinned too', async t => {
  const f = await fixture(t), config = await f.seal();
  await assert.rejects(createNativeCatalog({ ...config, schema: 'poe2-native-catalog-request/v1' }, path.join(f.dir, 'v1')), /format\/status/);
  const mpath = config.localized.manifest, m = JSON.parse(await readFile(mpath));
  m.source_identity.game_patch = '0.5.5.5'; const bytes = nativeBytes(m); await writeFile(mpath, bytes);
  await assert.rejects(createNativeCatalog({ ...config, localized: { manifest: mpath, sha256: hash(bytes) } }, path.join(f.dir, 'false-identity')), /language\/game identity/);
  const original = await f.seal(); await writeFile(path.join(f.dir, 'observed/wire-observations.json'), '{}');
  await assert.rejects(createNativeCatalog(original, path.join(f.dir, 'bad-wire')), /(pin|Fingerprint)/);
  const aliasConfig = await f.seal(), alias = JSON.parse(await readFile(mpath));
  alias.observed_client.resources['DATA/BALANCE/ASCENDANCY.DATC64'] = alias.observed_client.resources['data/balance/ascendancy.datc64'];
  const aliasBytes = nativeBytes(alias); await writeFile(mpath, aliasBytes);
  await assert.rejects(createNativeCatalog({ ...aliasConfig, localized: { manifest: mpath, sha256: hash(aliasBytes) } }, path.join(f.dir, 'case-alias')), /case collision/);
});

test('v2 lookup rejects altered applicability and incomplete candidate/field inventories', async t => {
  const f = await fixture(t), c = await createNativeCatalog(await f.seal(), path.join(f.dir, 'a'));
  const changed = structuredClone(c); changed.records[0].applicability.decision = 'rejected';
  assert.throws(() => createCatalogLookup(changed, expected), /applicability/);
  const missing = structuredClone(c); missing.records.pop();
  assert.throws(() => createCatalogLookup(missing, expected), /coverage/);
  const moved = structuredClone(c); moved.records[0].localized_row = 1;
  assert.throws(() => createCatalogLookup(moved, expected), /candidates/);
});

test('v2 duplicated target identities retain every current English candidate as an unresolved text blocker', async t => {
  const f = await fixture(t), id = f.d.target.rows[0].values.Id;
  f.d.target.rows.push({ _row: 1, values: { ...f.d.target.rows[0].values, Name: 'Other current English' } });
  const r = record(f.d, id, { decision: 'rejected', reason_codes: ['target-duplicate-key'], comparison: emptyComparison, differing_fields: {} });
  const c = await createNativeCatalog(await f.seal([r]), path.join(f.dir, 'a')), lookup = createCatalogLookup(c, expected);
  assert.equal(c.records[0].english, null); assert.equal(c.coverage.Ascendancy.Name.english_rows, 2);
  for (const candidate of c.records[0].candidates.english) assert.equal(lookup({ table: 'Ascendancy', field: 'Name', english: candidate.text }).reason, 'unresolved-homonym');
  assert.equal(lookup(query(c, { english: 'Other current English' })).reason, 'target-binding-rejected');
});

test('v2 Words binds HASH32 plus Text/Wordlist and keeps empty Inflection unresolved', async t => {
  const f = await fixture(t, 'Words'), c = await createNativeCatalog(await f.seal(), path.join(f.dir, 'a'));
  const lookup = createCatalogLookup(c, expected), q = { table: 'Words', field: 'Text2', id: 42, english: 'FixtureWord' };
  assert.equal(lookup(q).text, '夹具稀有名');
  assert.equal(lookup({ ...q, field: 'Inflection', english: '' }).reason, 'empty-english-text');
  assert.deepEqual(c.target_binding.tables.Words.text_fields, ['Text2', 'Inflection']);
  assert.equal(c.target_binding.tables.Words.records[0].english.Text, 'FixtureWord');
  f.d.localized.rows[0].values.Wordlist = 2;
  const rejected = record(f.d, 42, { decision: 'rejected', reason_codes: ['source_nontext-mismatch'],
    comparison: { source_nontext_equal: false, target_nontext_equal: true, target_english_equal: true },
    differing_fields: { source_nontext: ['Wordlist'], target_nontext: [], target_english: [] } });
  const b = await createNativeCatalog(await f.seal([rejected]), path.join(f.dir, 'b'));
  assert.equal(createCatalogLookup(b, expected)(q).reason, 'target-binding-rejected');
  assert.equal(b.records[0].candidates.localized[0].context.Wordlist, 2);
});
