import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDisplayTexts, projectDisplayTexts } from '../../src/pobr/display-texts.mjs';
import { entryId } from '../../src/pobr/display-supplements.mjs';

const row = (id, english, localized, extra = {}) => ({
  table: 'BaseItemTypes', field: 'Name', id, english, localized,
  templates: { english: { syntax_valid: true, placeholders: [], hash_slots: 0 } }, ...extra,
});
const project = records => projectDisplayTexts({ game_patch: 'test', realm: 'international', locale: 'zh-TW', records }, query => {
  const match = records.find(r => r.table === query.table && r.field === query.field && r.id === query.id);
  assert.equal(query.english, match.english ?? '');
  return { status: match.localized === null ? 'fallback' : 'translated', text: match.localized ?? query.english,
    reason: match.localized === null ? 'unchanged-text' : null, ids: [match.id] };
}, 'a'.repeat(64));

test('preserves scoped identity while blocking conflicting and incomplete English homonyms', () => {
  const { sidecar, conflicts } = project([
    row('a', 'Same', '甲'), row('b', 'Same', '乙'),
    row('c', 'Other', '丙'), row('d', 'Other', null), row('e', 'Unique', '丁'),
  ]);
  assert.deepEqual(sidecar.entries, { Other: null, Same: null, Unique: '丁' });
  assert.deepEqual(sidecar.scopes['BaseItemTypes.Name'].a, ['Same', '甲']);
  assert.deepEqual(sidecar.scopes['BaseItemTypes.Name'].d, ['Other', null]);
  assert.equal(conflicts.length, 2);
});

test('markup aliases and different tables participate in the same unscoped ambiguity check', () => {
  const { sidecar } = project([
    row('a', '[Key|Same]', '[Key|甲]'), row('b', 'Same', '乙', { table: 'PassiveSkills' }),
    row('c', '[Unchanged]', null), row('d', 'Agrees', '同'), row('e', 'Agrees', '同'),
  ]);
  assert.equal(sidecar.entries['[Key|Same]'], '[Key|甲]');
  assert.equal(sidecar.entries.Same, null);
  assert.equal(sidecar.entries.Unchanged, null);
  assert.equal(sidecar.entries.Agrees, '同');
});

test('retains unrendered placeholder, empty and unknown syntax records only in their source scope', () => {
  const { sidecar, decisions } = project([
    row('a', 'Gain {0}', '獲得 {0}', { templates: { english: { syntax_valid: true, placeholders: [{}], hash_slots: 0 } } }),
    row('b', 'Broken [', null, { templates: { english: { syntax_valid: false, placeholders: [], hash_slots: 0 } } }),
    row('c', '', null), row('d', 'Gain #', null, { templates: { english: { syntax_valid: true, placeholders: [], hash_slots: 1 } } }),
  ]);
  assert.deepEqual(sidecar.entries, {});
  assert.equal(Object.keys(sidecar.scopes['BaseItemTypes.Name']).length, 4);
  assert.equal(decisions.length, 4);
});

test('Words retain numeric decision identities and prototype-like literals without an unused browser scope', () => {
  const { sidecar, decisions } = project([row(123, '__proto__', '詞', { table: 'Words', field: 'Text2' })]);
  assert.equal(Object.getPrototypeOf(sidecar.entries), Object.prototype);
  assert.equal(Object.hasOwn(sidecar.entries, '__proto__'), true);
  assert.equal(sidecar.entries.__proto__, '詞');
  assert.equal(sidecar.scopes['Words.Text2'], undefined);
  assert.deepEqual(decisions[0].identity, ['Words', 'Text2', 123]);
});

test('duplicate source identities are rejected instead of last-write winning', () => {
  assert.throws(() => project([row('a', 'One', '一'), row('a', 'One', '一')]), /Duplicate/);
});

test('declared scopes change exact indexes without dropping ambiguity participants', () => {
  const records = [row('a', 'Same', '甲'), row('b', 'Same', null, { table: 'PassiveSkills' })];
  const { sidecar } = projectDisplayTexts({ records }, query => {
    const match = records.find(r => r.table === query.table);
    return { status: match.localized ? 'translated' : 'fallback', text: match.localized ?? match.english };
  }, 'a'.repeat(64), { scopes: ['PassiveSkills.Name'], literals: 'all-catalog-conflict-participants' });
  assert.deepEqual(Object.keys(sidecar.scopes), ['PassiveSkills.Name']);
  assert.equal(sidecar.entries.Same, null);
  assert.throws(() => projectDisplayTexts({ records }, () => ({}), 'a'.repeat(64), {
    scopes: [], literals: 'translated-only',
  }), /Invalid runtime projection/);
});

test('duplicate target English candidates block other stable IDs and stripped aliases without choosing a row', () => {
  const rejected = row('duplicate', null, null, {
    templates: { english: null },
    candidates: { english: [{ text: '[Key|Same]' }, { text: 'Other' }, { text: '[Key|Same]' }, { text: '' }] },
  });
  for (const records of [
    [rejected, row('a', '[Key|Same]', '甲'), row('b', 'Same', '乙'), row('c', 'Other', '丙')],
    [row('a', '[Key|Same]', '甲'), row('b', 'Same', '乙'), row('c', 'Other', '丙'), rejected],
  ]) {
    const { sidecar } = project(records);
    assert.deepEqual(sidecar.entries, { '[Key|Same]': null, Same: null, Other: null });
    assert.deepEqual(sidecar.scopes['BaseItemTypes.Name'].duplicate, [null, null]);
    assert.deepEqual(sidecar.scopes['BaseItemTypes.Name'].a, ['[Key|Same]', '甲']);
  }
});

test('additional English candidates block stale text without blocking the exact accepted query', () => {
  const { sidecar } = project([
    row('a', 'Current', '目前', { candidates: { english: [
      { text: 'Current' }, { text: '[Old|Former]' }, { text: '   ' },
    ] } }),
    row('b', 'Former', '旧'),
  ]);
  assert.deepEqual(sidecar.entries, { Current: '目前', '[Old|Former]': null, Former: null });
});

test('browser indexes retain only active exact-ID scopes while all fields still block ambiguous literals', () => {
  const records = [
    row('base', 'Same', '甲'),
    row('class', 'Warrior', '战士', { table: 'Characters' }),
    row('asc', 'Titan', '泰坦', { table: 'Ascendancy' }),
    row('skill', 'Same', null, { table: 'ActiveSkills', field: 'Description' }),
    row('empty', '', null, { table: 'Words', field: 'Inflection' }),
    // One English passive name, two client translations: the literal is blocked,
    // each PassiveSkills Id keeps its own translation.
    row('mana10', 'Mana Regeneration', '魔力再生', { table: 'PassiveSkills' }),
    row('energy_shield_recovery10', 'Mana Regeneration', '魔力回复', { table: 'PassiveSkills' }),
  ];
  const { sidecar, decisions } = project(records);
  assert.deepEqual(Object.keys(sidecar.scopes), ['Ascendancy.Name', 'BaseItemTypes.Name', 'Characters.Name', 'PassiveSkills.Name']);
  assert.deepEqual(sidecar.scopes['PassiveSkills.Name'], {
    energy_shield_recovery10: ['Mana Regeneration', '魔力回复'], mana10: ['Mana Regeneration', '魔力再生'] });
  assert.deepEqual(sidecar.entries, { 'Mana Regeneration': null, Same: null, Titan: '泰坦', Warrior: '战士' });
  assert.equal(decisions.length, records.length);
  assert.throws(() => project([...records, records[4]]), /Duplicate/);
});

function fixture(t, version, modules, options = {}) {
  const cache = fileURLToPath(new URL('../../.cache/', import.meta.url));
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'display-contract-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const pin = bytes => ({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: Buffer.byteLength(bytes) });
  const write = (file, value) => { fs.writeFileSync(path.join(root, file), value); return pin(value); };
  const identity = { game_patch: 'test', realm: 'international', locale: 'zh-CN' };
  const catalog = { schema: `poe2-native-catalog/v${version}`, ...identity, records: options.records ?? [] };
  const verification = '{"original":"验证"}\n';
  if (version === 3) catalog.fk_verification = { file: 'verification.json', ...write('verification.json', verification) };
  const catalogPin = write('catalog.json', JSON.stringify(catalog));
  const manifest = { schema: `poe2-native-catalog-manifest/v${version}`, game: 'poe2', status: 'candidate',
    production_ready: false, ...identity, files: {
      'catalog.json': catalogPin, 'request.json': write('request.json', '{}'),
    } };
  if (version === 3) manifest.files['verification.json'] = pin(verification);
  fs.mkdirSync(path.join(root, 'src'));
  const library = { root, files: {} };
  for (const module of ['native-catalog', 'native-names', 'strict-json',
    ...(modules >= 5 ? ['native-catalog-binding', 'native-localization'] : []),
    ...(modules === 6 ? ['native-catalog-fk-binding'] : [])]) {
    const source = module === 'native-catalog' ? `export const createCatalogLookup = (catalog, expected) => {
      if (catalog.schema.endsWith('/v3') && (!Buffer.isBuffer(expected.verification)
        || expected.verification.toString() !== ${JSON.stringify(verification)})) throw new Error('Original sidecar required');
      return query => ({ status: 'fallback', text: query.english, reason: 'missing-identity-or-text', ids: [] });
    };`
      : module === 'strict-json' ? 'export const strictJson = JSON.parse;' : 'export {};';
    library.files[`src/${module}.mjs`] = write(`src/${module}.mjs`, source).sha256;
  }
  manifest.producer = { ...library.files };
  const request = { schema: 'pobr-native-display-texts-request/v1', ...identity, library,
    catalog: { manifest: path.join(root, 'manifest.json'), ...write('manifest.json', JSON.stringify(manifest)) } };
  const output = { root, manifest, catalog, library, request, write, pin, out: path.join(root, 'out') };
  if (options.supplement) addSupplement(output, pin, write);
  return output;
}

// A closed stub of the library's reviewed-supplement module: it accepts only the
// original verification Buffer, the catalog pin and the externally pinned runtime,
// rejects any non-reviewed record, and translates only an exact full context.
function addSupplement(input, pin, write) {
  const records = [{ source: 0, entry_id: 'e'.repeat(64), table: 'BaseItemTypes', field: 'Name', id: 'flask',
    english: 'Flask', context: { ItemClass: 'Flask' }, text: '药剂', origin: 'agent', author: 'fixture-agent',
    note: 'synthetic', status: 'reviewed', review: { by: 'fixture-reviewer', note: 'synthetic' } }];
  const runtime = { schema: 'poe2-reviewed-native-supplements/v1', status: 'candidate', production_ready: false,
    sources: [{ game: 'poe2', game_patch: 'test', realm: 'international', locale: 'zh-CN',
      catalog_sha256: input.manifest.files['catalog.json'].sha256,
      verification: { bytes: input.catalog.fk_verification.bytes, sha256: input.catalog.fk_verification.sha256 } }],
    records };
  const directory = path.join(input.root, 'supplement');
  fs.mkdirSync(directory);
  const runtimePin = pin(JSON.stringify(runtime) + '\n');
  fs.writeFileSync(path.join(directory, 'supplements.json'), JSON.stringify(runtime) + '\n');
  fs.writeFileSync(path.join(directory, 'request.json'), '{}');
  const module = `import { createHash } from 'node:crypto';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const records = ${JSON.stringify(records)};
const source = ${JSON.stringify(runtime.sources[0])};
const catalogSha = ${JSON.stringify(runtime.sources[0].catalog_sha256)};
export const createReviewedSupplementLookup = (inputs, runtime) => {
  if (inputs.length !== 1 || !Buffer.isBuffer(inputs[0].verification)) throw new Error('Original sidecar buffer required');
  if (inputs[0].sha256 !== catalogSha || digest(inputs[0].bytes) !== catalogSha) throw new Error('Catalog pin differs');
  if (digest(runtime.bytes) !== runtime.sha256) throw new Error('Runtime pin differs');
  const parsed = JSON.parse(runtime.bytes.toString('utf8'));
  if (parsed.sources.length !== 1 || JSON.stringify(parsed.sources[0]) !== JSON.stringify(source)) throw new Error('Runtime source differs');
  if (parsed.records.some(row => row.status !== 'reviewed')) throw new Error('Unreviewed supplement record');
  globalThis.supplementQueries = [];
  return query => {
    globalThis.supplementQueries.push(query);
    const row = records.find(r => r.table === query.table && r.field === query.field && r.id === query.id
      && r.english === query.english && JSON.stringify(r.context) === JSON.stringify(query.context));
    return row ? { status: 'translated', text: row.text, reason: 'reviewed-supplement', ids: [row.id], origin: row.origin }
      : { status: 'fallback', text: query.english, reason: 'missing-identity-or-text', ids: [], origin: null };
  };
};
`;
  const modulePin = write('src/translation-workbench.mjs', module);
  const producer = { ...Object.fromEntries(Object.entries(input.library.files)
    .map(([file, sha]) => [path.basename(file), sha])), 'translation-workbench.mjs': modulePin.sha256 };
  const supplementManifest = { schema: 'poe2-reviewed-native-supplements-manifest/v1', status: 'candidate',
    production_ready: false, files: { 'supplements.json': runtimePin,
      'request.json': pin(fs.readFileSync(path.join(directory, 'request.json'))) }, producer };
  const manifestPin = write('supplement/manifest.json', JSON.stringify(supplementManifest));
  // The catalog manifest producer stays the official closure; the extra module is
  // pinned only by this separate supplement block, so the official guard is unchanged.
  input.request.supplement = { manifest: path.join(directory, 'manifest.json'), ...manifestPin,
    module: { file: 'src/translation-workbench.mjs', revision: 'f'.repeat(40), ...modulePin } };
  input.supplementManifest = supplementManifest;
  input.runtimePin = runtimePin;
}

test('pinned catalog versions admit their complete library closures without changing old v1 requests', async t => {
  for (const [version, modules] of [[1, 3], [1, 5], [2, 5], [1, 6], [2, 6], [3, 6]]) {
    const input = fixture(t, version, modules);
    const receipt = await createDisplayTexts(input.request, input.out);
    assert.equal(receipt.decisions.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json'))).locale, 'zh-CN');
  }
});

test('v3 requires the original pinned verification buffer and complete six-module closure', async t => {
  const missing = fixture(t, 3, 6);
  fs.unlinkSync(path.join(missing.root, 'verification.json'));
  await assert.rejects(createDisplayTexts(missing.request, missing.out), /ENOENT/);
  const corrupt = fixture(t, 3, 6);
  corrupt.write('verification.json', 'corrupt');
  await assert.rejects(createDisplayTexts(corrupt.request, corrupt.out), /size differs|SHA256 mismatch/);
  const mismatched = fixture(t, 3, 6);
  mismatched.catalog.fk_verification.sha256 = '0'.repeat(64);
  mismatched.manifest.files['catalog.json'] = mismatched.write('catalog.json', JSON.stringify(mismatched.catalog));
  Object.assign(mismatched.request.catalog, mismatched.write('manifest.json', JSON.stringify(mismatched.manifest)));
  await assert.rejects(createDisplayTexts(mismatched.request, mismatched.out), /verification pin differs/);
  const incomplete = fixture(t, 3, 5);
  await assert.rejects(createDisplayTexts(incomplete.request, incomplete.out), /Invalid library closure/);
  const substituted = fixture(t, 3, 6);
  substituted.manifest.producer['src/native-catalog.mjs'] = '0'.repeat(64);
  Object.assign(substituted.request.catalog, substituted.write('manifest.json', JSON.stringify(substituted.manifest)));
  await assert.rejects(createDisplayTexts(substituted.request, substituted.out), /producer closure mismatch/);
  for (const input of [missing, corrupt, mismatched, incomplete, substituted]) assert.equal(fs.existsSync(input.out), false);
});

test('v2 rejects incomplete or unpinned import closures before publishing', async t => {
  const old = fixture(t, 2, 3);
  await assert.rejects(createDisplayTexts(old.request, old.out), /Invalid library closure/);
  assert.equal(fs.existsSync(old.out), false);
  const changed = fixture(t, 2, 5);
  changed.write('src/native-catalog-binding.mjs', 'throw new Error("must never execute");');
  await assert.rejects(createDisplayTexts(changed.request, changed.out), /SHA256 mismatch/);
  assert.equal(fs.existsSync(changed.out), false);
});

test('old v1/v2 catalogs keep independently pinned compatible lookup implementations', async t => {
  for (const version of [1, 2]) {
    const input = fixture(t, version, 5);
    input.manifest.producer['src/native-catalog.mjs'] = '0'.repeat(64);
    Object.assign(input.request.catalog, input.write('manifest.json', JSON.stringify(input.manifest)));
    await createDisplayTexts(input.request, input.out);
  }
});

test('a pinned catalog still rejects a mismatched manifest version', async t => {
  const input = fixture(t, 2, 5);
  input.catalog.schema = 'poe2-native-catalog/v1';
  input.manifest.files['catalog.json'] = input.write('catalog.json', JSON.stringify(input.catalog));
  Object.assign(input.request.catalog, input.write('manifest.json', JSON.stringify(input.manifest)));
  await assert.rejects(createDisplayTexts(input.request, input.out), /schema differs/);
  assert.equal(fs.existsSync(input.out), false);
});

test('Git-delivered JSON has no fixed size cap and still requires exact bytes and SHA', async t => {
  const input = fixture(t, 2, 5);
  // Cross the former manifest cap without a large allocation in every test run.
  Object.assign(input.request.catalog, input.write('manifest.json', JSON.stringify(input.manifest) + ' '.repeat(1024 * 1024)));
  await createDisplayTexts(input.request, input.out);
  input.manifest.files['catalog.json'].bytes += 1;
  Object.assign(input.request.catalog, input.write('manifest.json', JSON.stringify(input.manifest)));
  await assert.rejects(createDisplayTexts(input.request, input.out + '-size'), /size differs/);
  input.manifest.files['catalog.json'].bytes -= 1;
  input.manifest.files['catalog.json'].sha256 = '0'.repeat(64);
  Object.assign(input.request.catalog, input.write('manifest.json', JSON.stringify(input.manifest)));
  await assert.rejects(createDisplayTexts(input.request, input.out + '-hash'), /SHA256 mismatch/);
  assert.equal(fs.existsSync(input.out + '-size'), false);
  assert.equal(fs.existsSync(input.out + '-hash'), false);
});

const supplementRecords = [
  { table: 'BaseItemTypes', field: 'Name', id: 'flask', english: 'Flask', localized: null,
    context: { english: { ItemClass: 'Flask' }, localized: null },
    templates: { english: { syntax_valid: true, placeholders: [], hash_slots: 0 }, localized: null } },
  { table: 'BaseItemTypes', field: 'Name', id: 'sword', english: 'Sword', localized: null,
    context: { english: { ItemClass: 'One Hand Swords' }, localized: null },
    templates: { english: { syntax_valid: true, placeholders: [], hash_slots: 0 }, localized: null } },
];

test('a pinned reviewed supplement projects exact-context text and keeps the official fallback', async t => {
  const input = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  const receipt = await createDisplayTexts(input.request, input.out);
  const sidecar = JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json')));
  assert.deepEqual(sidecar.entries, { Flask: '药剂', Sword: null });
  assert.deepEqual(sidecar.scopes['BaseItemTypes.Name'],
    { flask: ['Flask', '药剂'], sword: ['Sword', null] });
  // The supplemented value is marked as ours in the literal and in its scope; official values are not listed.
  assert.deepEqual(sidecar.origins, { entries: { Flask: 'agent' }, scopes: { 'BaseItemTypes.Name': { flask: 'agent' } } });
  assert.deepEqual(Object.keys(sidecar), ['schema', 'game_patch', 'realm', 'locale', 'catalog_sha256', 'entries', 'scopes', 'origins']);
  assert.equal(sidecar.catalog_sha256, input.manifest.files['catalog.json'].sha256);
  // Only the complete English context of each row reaches the library lookup.
  const scope = { game_patch: 'test', realm: 'international', locale: 'zh-CN' };
  assert.deepEqual(globalThis.supplementQueries, [
    { ...scope, table: 'BaseItemTypes', field: 'Name', id: 'flask', english: 'Flask',
      context: { ItemClass: 'Flask' } },
    { ...scope, table: 'BaseItemTypes', field: 'Name', id: 'sword', english: 'Sword',
      context: { ItemClass: 'One Hand Swords' } },
  ]);
  assert.equal(receipt.supplement.records, 1);
  assert.equal(receipt.supplement.catalog_sha256, input.manifest.files['catalog.json'].sha256);
  assert.deepEqual(receipt.supplement.runtime,
    { bytes: input.runtimePin.bytes, sha256: input.runtimePin.sha256 });
  assert.deepEqual(receipt.supplement.module, input.request.supplement.module);
  assert.deepEqual(receipt.supplement.sources, [{
    game: 'poe2', game_patch: 'test', realm: 'international', locale: 'zh-CN',
    catalog_sha256: input.manifest.files['catalog.json'].sha256,
    verification: { bytes: input.catalog.fk_verification.bytes, sha256: input.catalog.fk_verification.sha256 },
  }]);
  for (const file of ['supplement/manifest.json', 'supplement/supplements.json', 'supplement/request.json',
    'src/translation-workbench.mjs']) {
    assert.equal(typeof receipt.inputs[path.join(input.root, file)], 'object', file);
  }
  assert.deepEqual(fs.readdirSync(input.out).sort(), ['display_texts.json', 'receipt.json']);
});

test('reviewed supplement pins, module closure and catalog version fail closed', async t => {
  const cases = [];
  const wrongModule = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  wrongModule.request.supplement.module.sha256 = '0'.repeat(64);
  cases.push([wrongModule, /SHA256 mismatch/]);
  const missingModule = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  fs.unlinkSync(path.join(missingModule.root, 'src/translation-workbench.mjs'));
  cases.push([missingModule, /ENOENT/]);
  const movedRevision = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  movedRevision.request.supplement.module.revision = 'latest';
  cases.push([movedRevision, /Invalid supplement module pin/]);
  const missingModuleSize = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  delete missingModuleSize.request.supplement.module.bytes;
  cases.push([missingModuleSize, /Invalid supplement module pin/]);
  const missingManifestSize = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  delete missingManifestSize.request.supplement.bytes;
  cases.push([missingManifestSize, /Invalid supplement manifest pin/]);
  const wrongManifest = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  wrongManifest.request.supplement.sha256 = '0'.repeat(64);
  cases.push([wrongManifest, /SHA256 mismatch/]);
  const wrongRuntime = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  fs.writeFileSync(path.join(wrongRuntime.root, 'supplement/supplements.json'),
    JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(wrongRuntime.root, 'supplement/supplements.json'))),
      records: [] }) + '\n');
  cases.push([wrongRuntime, /size differs|SHA256 mismatch/]);
  const wrongProducer = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  wrongProducer.supplementManifest.producer['native-catalog.mjs'] = '0'.repeat(64);
  Object.assign(wrongProducer.request.supplement,
    wrongProducer.write('supplement/manifest.json', JSON.stringify(wrongProducer.supplementManifest)));
  cases.push([wrongProducer, /Supplement producer closure mismatch/]);
  const extraProducer = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  extraProducer.supplementManifest.producer['extra.mjs'] = '0'.repeat(64);
  Object.assign(extraProducer.request.supplement,
    extraProducer.write('supplement/manifest.json', JSON.stringify(extraProducer.supplementManifest)));
  cases.push([extraProducer, /Supplement producer closure mismatch/]);
  const oldCatalog = fixture(t, 2, 5);
  oldCatalog.request.supplement = { module: { file: 'src/translation-workbench.mjs', revision: 'f'.repeat(40) } };
  cases.push([oldCatalog, /Reviewed supplements require a v3 catalog/]);
  for (const [input, error] of cases) {
    await assert.rejects(createDisplayTexts(input.request, input.out), error);
    assert.equal(fs.existsSync(input.out), false);
  }
});

test('a library that refuses unreviewed or foreign records publishes nothing', async t => {
  const draft = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  const file = path.join(draft.root, 'supplement/supplements.json');
  const runtime = JSON.parse(fs.readFileSync(file));
  runtime.records[0].status = 'draft';
  const raw = JSON.stringify(runtime) + '\n';
  fs.writeFileSync(file, raw);
  draft.supplementManifest.files['supplements.json'] = draft.pin(raw);
  Object.assign(draft.request.supplement, draft.write('supplement/manifest.json',
    JSON.stringify(draft.supplementManifest)));
  await assert.rejects(createDisplayTexts(draft.request, draft.out), /Unreviewed supplement record/);
  assert.equal(fs.existsSync(draft.out), false);
  const foreign = fixture(t, 3, 6, { supplement: true, records: supplementRecords });
  const foreignFile = path.join(foreign.root, 'supplement/supplements.json');
  const foreignRuntime = JSON.parse(fs.readFileSync(foreignFile));
  foreignRuntime.sources[0].realm = 'china';
  const foreignRaw = JSON.stringify(foreignRuntime) + '\n';
  fs.writeFileSync(foreignFile, foreignRaw);
  foreign.supplementManifest.files['supplements.json'] = foreign.pin(foreignRaw);
  Object.assign(foreign.request.supplement, foreign.write('supplement/manifest.json',
    JSON.stringify(foreign.supplementManifest)));
  await assert.rejects(createDisplayTexts(foreign.request, foreign.out), /Runtime source differs/);
  assert.equal(fs.existsSync(foreign.out), false);
});

test('official-only requests still publish the same sidecar without a supplement block', async t => {
  delete globalThis.supplementQueries;
  const input = fixture(t, 3, 6, { records: supplementRecords });
  const receipt = await createDisplayTexts(input.request, input.out);
  assert.equal(Object.hasOwn(receipt, 'supplement'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json'))).entries,
    { Flask: null, Sword: null });
  assert.deepEqual(globalThis.supplementQueries, undefined);
});

test('omitting the library runs this checkout only for v3 and still compares the producer closure', async t => {
  const repo = fileURLToPath(new URL('../..', import.meta.url));
  for (const [version, modules] of [[1, 3], [2, 5]]) {
    const input = fixture(t, version, modules);
    delete input.request.library;
    await assert.rejects(createDisplayTexts(input.request, input.out), /require an explicit library closure/);
    assert.equal(fs.existsSync(input.out), false);
  }
  // The fixture's stub modules produced this catalog, so this checkout's six
  // modules do not match its producer and nothing is executed.
  const stub = fixture(t, 3, 6);
  delete stub.request.library;
  await assert.rejects(createDisplayTexts(stub.request, stub.out), /producer closure mismatch/);
  // A producer equal to this checkout's modules selects them: the real
  // native-catalog.mjs runs and rejects the stub-shaped catalog envelope.
  const local = fixture(t, 3, 6);
  delete local.request.library;
  local.manifest.producer = Object.fromEntries(Object.keys(local.library.files).map(file =>
    [file, createHash('sha256').update(fs.readFileSync(path.join(repo, file))).digest('hex')]));
  Object.assign(local.request.catalog, local.write('manifest.json', JSON.stringify(local.manifest)));
  await assert.rejects(createDisplayTexts(local.request, local.out), /Invalid catalog envelope/);
  assert.equal(fs.existsSync(local.out), false);
});

test('omitting the projection pins and applies src/pobr/display-projection.json', async t => {
  const file = fileURLToPath(new URL('../../src/pobr/display-projection.json', import.meta.url));
  const declared = JSON.parse(fs.readFileSync(file, 'utf8'));
  const records = ['BaseItemTypes', 'Characters', 'Ascendancy', 'PassiveSkills'].map((table, i) =>
    row(`r${i}`, `Text ${i}`, null, { table }));
  const input = fixture(t, 3, 6, { records });
  const receipt = await createDisplayTexts(input.request, input.out);
  assert.deepEqual(receipt.runtime_scopes, [...declared.scopes].sort());
  const raw = fs.readFileSync(file);
  assert.deepEqual(receipt.inputs[file], { sha256: createHash('sha256').update(raw).digest('hex'), bytes: raw.length });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json'))).scopes).sort(),
    [...declared.scopes].sort());
  assert.deepEqual(receipt.projection, { source: 'file', file: 'src/pobr/display-projection.json',
    ...receipt.inputs[file], scopes: declared.scopes, literals: declared.literals });
});

test('a request projection replaces the default file, which is then neither read nor pinned', async t => {
  const file = fileURLToPath(new URL('../../src/pobr/display-projection.json', import.meta.url));
  const records = ['BaseItemTypes', 'Characters', 'Ascendancy', 'PassiveSkills'].map((table, i) =>
    row(`r${i}`, `Text ${i}`, null, { table }));
  const projection = { scopes: ['Characters.Name'], literals: 'all-catalog-conflict-participants' };
  const input = fixture(t, 3, 6, { records });
  const receipt = await createDisplayTexts({ ...input.request, projection }, input.out);
  assert.deepEqual(receipt.runtime_scopes, ['Characters.Name']);
  assert.deepEqual(receipt.request.projection, projection);
  assert.deepEqual(receipt.projection, { source: 'request', ...projection });
  assert.equal(Object.hasOwn(receipt.inputs, file), false);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json'))).scopes), ['Characters.Name']);
  const other = fixture(t, 3, 6, { records });
  await assert.rejects(createDisplayTexts({ ...other.request, projection: { ...projection, extra: true } }, other.out),
    /Invalid runtime projection/);
  assert.equal(fs.existsSync(other.out), false);
});

const BASED_ON = { game_patch: 'test', game_package: { repository: 'ackness/repoe', tag: 'game/test-1', sha256: 'c'.repeat(64) },
  stat_descriptions_sha256: 'd'.repeat(64) };
const monster = (english, ids, extra = {}) => {
  const identity = { game: 'poe2', realm: 'international', locale: 'zh-TW', kind: 'monster-name',
    table: 'MonsterVarieties', field: 'Name', english, ...extra.identity };
  return { entry_id: entryId(identity), identity, ids, based_on: BASED_ON, text: extra.text ?? '骷髏', origin: 'agent',
    basis: 'own', author: 'claude-haiku-4-5', note: '音译', status: extra.status ?? 'reviewed',
    review: (extra.status ?? 'reviewed') === 'draft' ? null : { by: 'claude-opus-5-5', note: 'checked' } };
};
// The shape of RePoE's decoded MonsterVarieties.Name files (one client, one localized language).
const officialNames = (names, extra = {}) => ({ format: 'scratch-monster-variety-names/v1',
  localized: { language: 'Traditional Chinese', game_patch: 'test', realm: 'international' },
  index_identity: { kind: 'cdn-index-partial-ranges', index_receipt_sha256: 'e'.repeat(64) },
  names: Object.fromEntries(Object.entries(names).map(([id, [english, zh_tw]]) => [id, { english, zh_tw }])), ...extra });
const NAMES = { scopes: ['BaseItemTypes.Name', 'MonsterVarieties.Name'], literals: 'all-catalog-conflict-participants' };
const projectNames = (records, entries, projection = NAMES, official = null) => projectDisplayTexts(
  { game_patch: 'test', realm: 'international', locale: 'zh-TW', records }, query => {
    const match = records.find(r => r.table === query.table && r.id === query.id);
    return match.localized === null ? { status: 'fallback', text: query.english }
      : { status: 'translated', text: match.localized, origin: match.origin };
  }, 'a'.repeat(64), projection,
  { names: entries === null ? null : { schema: 'poe2-display-supplements/v1', entries, corrections: [] }, official });

test('without supplements the sidecar has no origins block, so existing members keep their bytes', () => {
  const { sidecar } = project([row('a', 'Same', '甲')]);
  assert.equal(Object.hasOwn(sidecar, 'origins'), false);
  // An empty names document adds nothing either, even with the scope declared.
  const empty = projectNames([row('a', 'Same', '甲')], []);
  assert.deepEqual(empty.sidecar, sidecar);
  assert.deepEqual(empty.names, { counts: { official: 0, supplemented: 0, superseded: 0 }, entries: [], official: null });
});

test('reviewed monster names fill MonsterVarieties.Name with origin; a catalog row and other states win', () => {
  const records = [row('Metadata/Monsters/Official', 'Official Beast', '官方野獸', { table: 'MonsterVarieties' })];
  const entries = [
    monster('Skeleton', ['Metadata/Monsters/Skeleton', 'Metadata/Monsters/Skeleton2']),
    monster('Official Beast', ['Metadata/Monsters/Official'], { text: '我們的野獸' }),
    monster('Draft', ['Metadata/Monsters/Draft'], { status: 'draft' }),
    monster('Elsewhere', ['Metadata/Monsters/Elsewhere'], { identity: { locale: 'zh-CN' } }),
  ];
  const { sidecar, names } = projectNames(records, entries);
  assert.deepEqual(sidecar.scopes['MonsterVarieties.Name'], {
    'Metadata/Monsters/Official': ['Official Beast', '官方野獸'],
    'Metadata/Monsters/Skeleton': ['Skeleton', '骷髏'], 'Metadata/Monsters/Skeleton2': ['Skeleton', '骷髏'] });
  assert.deepEqual(sidecar.origins, { entries: {}, scopes: { 'MonsterVarieties.Name': {
    'Metadata/Monsters/Skeleton': 'agent', 'Metadata/Monsters/Skeleton2': 'agent' } } });
  // Names never become literal entries (an English name can be shared by unrelated things).
  assert.equal(Object.hasOwn(sidecar.entries, 'Skeleton'), false);
  assert.deepEqual(names.entries.map(name => name.lifecycle), ['supplemented', 'superseded', 'draft', 'other-target']);
  assert.deepEqual(names.entries[1].ids, [{ id: 'Metadata/Monsters/Official', lifecycle: 'superseded', by: 'catalog' }]);
  assert.deepEqual(names.counts, { official: 0, supplemented: 2, superseded: 1 });
  assert.throws(() => projectNames([], [entries[0], monster('Skeleton Two', ['Metadata/Monsters/Skeleton'])]), /Two reviewed monster names/);
  assert.throws(() => projectNames([], [entries[0]], { ...NAMES, scopes: ['BaseItemTypes.Name'] }), /MonsterVarieties\.Name in projection\.scopes/);
  assert.throws(() => projectNames([], [{ ...entries[0], entry_id: 'f'.repeat(64) }]), /entry_id/);
});

test('official names ship without origin and supersede our entries; mismatched English is not applied', () => {
  const official = officialNames({
    'Metadata/Monsters/Skeleton': ['Skeleton', '骷髏戰士'], 'Metadata/Monsters/Wolf': ['Wolf', '狼'],
    'Metadata/Monsters/Same': ['Same', 'Same'], 'Metadata/Monsters/Empty': ['Empty', null],
    'Metadata/Monsters/Renamed': ['Renamed Beast', '改名野獸'],
  });
  const entries = [
    monster('Skeleton', ['Metadata/Monsters/Skeleton', 'Metadata/Monsters/Skeleton2']),
    monster('Empty', ['Metadata/Monsters/Empty'], { text: '空' }),
    monster('Old Beast', ['Metadata/Monsters/Renamed'], { text: '舊野獸' }),
  ];
  const { sidecar, names } = projectNames([], entries, NAMES, official);
  assert.deepEqual(sidecar.scopes['MonsterVarieties.Name'], {
    'Metadata/Monsters/Empty': ['Empty', '空'],
    'Metadata/Monsters/Renamed': ['Old Beast', '舊野獸'],
    'Metadata/Monsters/Skeleton': ['Skeleton', '骷髏戰士'],
    'Metadata/Monsters/Skeleton2': ['Skeleton', '骷髏'],
    'Metadata/Monsters/Wolf': ['Wolf', '狼'] });
  // Only our values are marked; official ones never appear in origins.
  assert.deepEqual(sidecar.origins.scopes['MonsterVarieties.Name'], { 'Metadata/Monsters/Empty': 'agent',
    'Metadata/Monsters/Renamed': 'agent', 'Metadata/Monsters/Skeleton2': 'agent' });
  assert.deepEqual(names.counts, { official: 2, supplemented: 3, superseded: 1 });
  assert.deepEqual(names.entries[0].ids, [
    { id: 'Metadata/Monsters/Skeleton', lifecycle: 'superseded', by: 'official-names', official: '骷髏戰士', supplement_differs: true },
    { id: 'Metadata/Monsters/Skeleton2', lifecycle: 'supplemented' }]);
  assert.deepEqual(names.official.not_applied, { 'english-differs': [{ id: 'Metadata/Monsters/Renamed',
    official_english: 'Renamed Beast', target_english: 'Old Beast' }], untranslated: ['Metadata/Monsters/Same', 'Metadata/Monsters/Empty'],
  'catalog-row': [] });
  assert.deepEqual(names.official.client, { index_receipt_sha256: 'e'.repeat(64) });
  // Official names alone, without our document: no other English to compare with, so all three apply.
  assert.deepEqual(projectNames([], null, NAMES, official).names.counts, { official: 3, supplemented: 0, superseded: 0 });
  assert.equal(Object.hasOwn(projectNames([], null, NAMES, official).sidecar, 'origins'), false);
  // The file must be for this locale and patch and name its client.
  assert.throws(() => projectNames([], null, NAMES, { ...official, localized: { ...official.localized, language: 'Simplified Chinese' } }),
    /locale zh-CN differs from zh-TW/);
  assert.throws(() => projectNames([], null, NAMES, { ...official, localized: { ...official.localized, game_patch: '0.1' } }), /game_patch/);
  assert.throws(() => projectNames([], null, NAMES, { ...official, index_identity: { kind: 'x' } }), /client identity/);
  assert.throws(() => projectNames([], null, NAMES, { ...official, names: { a: { english: 'A', zh_cn: '甲' } } }), /fields must be/);
  assert.throws(() => projectNames([], null, { ...NAMES, scopes: ['BaseItemTypes.Name'] }, official), /projection\.scopes/);
});

test('createDisplayTexts reads names and official names only from pinned files and records the decisions', async t => {
  const input = fixture(t, 3, 6);
  const doc = JSON.stringify({ schema: 'poe2-display-supplements/v1', corrections: [],
    entries: [monster('Skeleton', ['Metadata/Monsters/Skeleton', 'Metadata/Monsters/Other'], { identity: { locale: 'zh-CN' }, text: '骷髅' })] });
  input.request.names = { file: path.join(input.root, 'names.json'), ...input.write('names.json', doc) };
  const official = JSON.stringify({ format: 'scratch-monster-variety-names/v1', locale: 'zh-CN',
    observed_client: { index_sha256: '1'.repeat(64) }, names: { 'Metadata/Monsters/Skeleton': { english: 'Skeleton', zh_cn: '骷髅战士' } } });
  input.request.official_names = { file: path.join(input.root, 'official.json'), ...input.write('official.json', official) };
  input.request.projection = NAMES;
  const receipt = await createDisplayTexts(input.request, input.out);
  const sidecar = JSON.parse(fs.readFileSync(path.join(input.out, 'display_texts.json')));
  assert.deepEqual(sidecar.scopes['MonsterVarieties.Name'], { 'Metadata/Monsters/Other': ['Skeleton', '骷髅'],
    'Metadata/Monsters/Skeleton': ['Skeleton', '骷髅战士'] });
  assert.deepEqual(sidecar.origins.scopes, { 'MonsterVarieties.Name': { 'Metadata/Monsters/Other': 'agent' } });
  assert.deepEqual(receipt.names.counts, { official: 1, supplemented: 1, superseded: 1 });
  for (const file of ['names.json', 'official.json']) assert.equal(typeof receipt.inputs[path.join(input.root, file)], 'object');
  input.request.official_names.sha256 = '0'.repeat(64);
  await assert.rejects(createDisplayTexts(input.request, input.out + '-bad'), /SHA256 mismatch/);
});
