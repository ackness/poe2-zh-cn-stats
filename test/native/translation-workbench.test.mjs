import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pairDisplayCatalog, createCatalogLookup } from '../../src/native-catalog.mjs';
import { reconcileNativeTranslations, createSupplementedLookup, exportReviewedSupplements,
  createReviewedSupplementLookup, entryId, writeWorkbench, workbenchCommand } from '../../src/translation-workbench.mjs';

const hash = raw => createHash('sha256').update(raw).digest('hex');
const edits = entries => ({ schema: 'poe2-native-translation-edits/v1', entries });
function input({ english = 'Flask', localized = english, realm = 'international', patch = '0.5.5.5', locale = 'zh-CN', missing = false } = {}) {
  const row = name => ({ _row: 0, values: { Id: 'stable', Name: name } });
  const en = { ItemClasses: { rows: [row(english)] } }, zh = { ItemClasses: { rows: missing ? [] : [row(localized)] } };
  const language = locale === 'zh-CN' ? 'Simplified Chinese' : 'Traditional Chinese';
  const catalog = { schema: 'poe2-native-catalog/v1', status: 'candidate', production_ready: false, game: 'poe2',
    game_patch: patch, realm, locale, language, ...pairDisplayCatalog(en, zh, language, ['ItemClasses']) };
  const bytes = Buffer.from(JSON.stringify(catalog) + '\n');
  return { bytes, sha256: hash(bytes) };
}
const entry = source => reconcileNativeTranslations([source]).entries[0];
function edit(source, more = {}) {
  const row = entry(source);
  return { entry_id: row.entry_id, identity: row.identity, english: row.english, context: row.context,
    based_on: row.current, text: '药剂', origin: 'agent', author: 'fixture-agent',
    note: 'Translated supplied source text', status: 'draft', review: null, ...more };
}
const reviewed = { status: 'reviewed', review: { by: 'fixture-reviewer', note: 'Checked meaning and placeholders' } };
const query = more => ({ game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN', table: 'ItemClasses', field: 'Name', id: 'stable', english: 'Flask', context: {}, ...more });
const pinned = value => { const bytes = Buffer.from(JSON.stringify(value) + '\n'); return { bytes, sha256: hash(bytes) }; };

// A synthetic v2 projection, including all reasons and raw candidate strings.
// It exercises the existing reader contract without acquiring/building data.
function observedInput(reasons = []) {
  const catalog = JSON.parse(input().bytes), row = catalog.records[0];
  catalog.schema = 'poe2-native-catalog/v2';
  catalog.observed_client = { game: 'poe2', game_patch: null, realm: null };
  catalog.target_binding = { policy_id: 'stable-key-current-english-all-nontext/v1',
    target_identity: { game: 'poe2', game_patch: catalog.game_patch, realm: catalog.realm },
    tables: { ItemClasses: { records: [{ table: row.table, key_field: row.key_field, id: row.id,
      decision: reasons.length ? 'rejected' : 'accepted', binding_kind: 'record-bound', reason_codes: reasons,
      source_default_rows: [0], source_localized_rows: [0], target_rows: [0], english: { Name: row.english },
      comparison: { source_nontext_equal: true, target_nontext_equal: true, target_english_equal: true },
      differing_fields: { source_nontext: [], target_nontext: [], target_english: [] } }] } } };
  row.applicability = { binding_record: 0, decision: reasons.length ? 'rejected' : 'accepted', binding_kind: 'record-bound', reason_codes: reasons };
  if (reasons.length) {
    row.reason = 'target-binding-rejected';
    row.candidates = Object.fromEntries(['english', 'localized', 'default'].map(side => [side,
      [{ row: 0, text: row.english, context: {} }]]));
  }
  catalog.coverage.ItemClasses.Name.source_default_rows = 1;
  return pinned(catalog);
}

test('official missing, source unverified, empty and internal strings remain distinct', () => {
  assert.equal(entry(input()).official_translation.status, 'missing');
  assert.equal(entry(input()).workflow_status, 'pending');
  assert.equal(entry(input({ missing: true })).official_translation.status, 'unverified');
  assert.equal(entry(input({ missing: true })).agent_eligible, false);
  assert.equal(entry(input({ english: '', localized: '' })).workflow_status, 'not-applicable');
  assert.equal(entry(input({ english: '[DNT-UNUSED] Example' })).workflow_status, 'source-review');
  for (const english of ['TBD', '???']) assert.equal(entry(input({ english })).agent_blocker, 'internal-placeholder');
  assert.equal(entry(input({ localized: 'LatinName' })).official_translation.status, 'unverified');
});

test('drafts are visible but never returned; exact reviewed supplements retain agent provenance', () => {
  const source = input(), draft = edit(source);
  const book = reconcileNativeTranslations([source], edits([draft]));
  assert.equal(book.entries[0].workflow_status, 'draft');
  assert.equal(book.entries[0].effective_translation.text, null);
  assert.equal(createSupplementedLookup(source, edits([draft]))(query()).status, 'fallback');
  const lookup = createSupplementedLookup(source, edits([{ ...draft, ...reviewed }]));
  assert.deepEqual(lookup(query()), { status: 'translated', text: '药剂', origin: 'agent', reason: 'reviewed-supplement', ids: ['stable'] });
  assert.equal(lookup(query({ context: undefined })).status, 'fallback');
  assert.equal(lookup(query({ id: 'other' })).status, 'fallback');
  assert.equal(lookup(query({ english: 'Old name' })).status, 'fallback');
});

test('official updates win and retain the prior agent text and evidence for comparison', () => {
  const original = input(), manual = edit(original, reviewed);
  const previous = reconcileNativeTranslations([original], edits([manual]));
  const update = input({ localized: '充能药瓶' });
  const book = reconcileNativeTranslations([update], edits([manual]), previous);
  assert.equal(book.entries[0].official_translation.status, 'available');
  assert.equal(book.entries[0].effective_translation.text, '充能药瓶');
  assert.equal(book.entries[0].effective_translation.origin, 'official');
  assert.equal(book.entries[0].translation.text, '药剂');
  assert.equal(book.entries[0].supplement_differs, true);
  assert.equal(book.entries[0].seen_in.length, 2);
});

test('a new patch needs review; English changes retain retired edits without applying them to the new row', () => {
  const original = input(), manual = edit(original, reviewed);
  const previous = reconcileNativeTranslations([original], edits([manual]));
  const patched = reconcileNativeTranslations([input({ patch: '0.5.5.6' })], edits([manual]), previous);
  assert.equal(patched.entries[0].workflow_status, 'needs-review');
  assert.equal(patched.entries[0].effective_translation.text, null);
  const changed = reconcileNativeTranslations([input({ english: 'Charm' })], edits([manual]), previous);
  assert.equal(changed.entries.length, 2);
  assert.equal(changed.entries.find(r => r.lifecycle === 'retired').translation.text, '药剂');
  assert.equal(changed.entries.find(r => r.lifecycle === 'current').workflow_status, 'pending');
  assert.equal(changed.entries.find(r => r.lifecycle === 'current').effective_translation.text, null);
});

test('China and international records with the same ID and English stay independent; locale also binds edits', () => {
  const international = input(), china = input({ realm: 'china' }), tw = input({ locale: 'zh-TW' });
  const manual = edit(china, { ...reviewed, text: '国服译名' });
  const book = reconcileNativeTranslations([international, china, tw], edits([manual]));
  assert.equal(new Set(book.entries.map(r => r.entry_id)).size, 3);
  assert.equal(book.entries.find(r => r.identity.realm === 'china').effective_translation.text, '国服译名');
  assert(book.entries.filter(r => r.identity.realm === 'international').every(r => r.effective_translation.text === null));
  assert(book.entries.every(r => r.regional_scope.exclusive === null));
  assert.throws(() => createSupplementedLookup(china, edits([manual]))(query()), /realm/);
});

test('missing source records and invalid official templates cannot be filled by a reviewed edit', () => {
  for (const source of [input({ missing: true }), input({ english: 'Gain 2 [Life|Life]', localized: '获得 3 [Life|生命]' })]) {
    const manual = edit(source, { ...reviewed, text: '获得 2 [Life|生命]' });
    assert.equal(reconcileNativeTranslations([source], edits([manual])).entries[0].effective_translation.text, null);
  }
});

test('reviewed drafts preserve placeholders, signs, numeric literals and reference keys', () => {
  const source = input({ english: 'Gain 2 [Life|Life] and +{0:d}' });
  for (const [text, reason] of [
    ['获得 3 [Life|生命] 和 +{0:d}', 'literal-number-mismatch'],
    ['获得 2 [Mana|生命] 和 +{0:d}', 'reference-mismatch'],
    ['获得 2 [Life|生命] 和 -{0:d}', 'placeholder-mismatch'],
    ['获得 2 [Life|生命] 和 +{1:d}', 'placeholder-mismatch'],
  ]) {
    const row = reconcileNativeTranslations([source], edits([edit(source, { ...reviewed, text })])).entries[0];
    assert.equal(row.translation_review.reason, reason);
    assert.equal(row.effective_translation.text, null);
  }
  const row = reconcileNativeTranslations([source], edits([edit(source, { ...reviewed, text: '获得 2 [Life|生命] 和 +{0:d}' })])).entries[0];
  assert.equal(row.effective_translation.origin, 'agent');
  assert.equal(entry(input({ english: 'Gain {} Life' })).agent_eligible, false);
});

test('corrupt pins, duplicate edits, missing reviewer and duplicate current scopes are rejected', () => {
  const source = input(), manual = edit(source);
  assert.throws(() => reconcileNativeTranslations([{ ...source, sha256: 'f'.repeat(64) }]), /SHA256/);
  assert.throws(() => reconcileNativeTranslations([source], edits([manual, manual])), /duplicate/);
  assert.throws(() => reconcileNativeTranslations([source], edits([{ ...manual, status: 'reviewed' }])), /reviewer/);
  assert.throws(() => reconcileNativeTranslations([source], edits([{ ...manual, english: 'Changed' }])), /entry_id/);
  assert.throws(() => reconcileNativeTranslations([source, source]), /one current/);
});

test('fresh workbench CLI files replay exactly, list by region/status, never overwrite or activate', async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const base = await mkdtemp(path.join(root, '.cache/workbench-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const source = input(), c = JSON.parse(source.bytes);
  await writeFile(path.join(base, 'catalog.json'), source.bytes);
  const manifest = Buffer.from(JSON.stringify({ schema: 'poe2-native-catalog-manifest/v1', status: c.status,
    production_ready: false, game: c.game, game_patch: c.game_patch, realm: c.realm, locale: c.locale,
    files: { 'catalog.json': { bytes: source.bytes.length, sha256: source.sha256 } } }));
  await writeFile(path.join(base, 'manifest.json'), manifest);
  const config = { schema: 'poe2-translation-workbench-request/v1', catalogs: [{ manifest: path.join(base, 'manifest.json'), sha256: hash(manifest) }] };
  const a = await writeWorkbench(config, path.join(base, 'a')); await writeWorkbench(config, path.join(base, 'b'));
  for (const file of [...Object.keys(a.manifest.files), 'manifest.json']) assert.deepEqual(await readFile(path.join(base, 'a', file)), await readFile(path.join(base, 'b', file)));
  const exported = await workbenchCommand('workbench-export', ['--config', await (async () => {
    const file = path.join(base, 'request.json'); await writeFile(file, JSON.stringify(config)); return file;
  })(), '--out', path.join(base, 'export')]);
  assert.equal(exported.manifest.schema, 'poe2-reviewed-native-supplements-manifest/v1');
  assert.deepEqual(Object.keys(exported.manifest.files).sort(), ['request.json', 'supplements.json']);
  assert.deepEqual(await readFile(path.join(base, 'a/supplements.json')), await readFile(path.join(base, 'export/supplements.json')));
  const result = await workbenchCommand('workbench-list', ['--file', path.join(base, 'a/workbench.json'), '--status', 'pending', '--realm', 'international']);
  assert.equal(result.total, 1); assert.equal(result.entries[0].english, 'Flask');
  await assert.rejects(writeWorkbench(config, path.join(base, 'a')), /EEXIST/);
  await assert.rejects(workbenchCommand('workbench-list', ['--file', path.join(base, 'a/workbench.json'), '--status', 'typo']), /Unknown/);
});

test('Git JSON inputs have no fixed cap while catalog byte and hash pins remain mandatory', async t => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const base = await mkdtemp(path.join(root, '.cache/workbench-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const source = input(), c = JSON.parse(source.bytes);
  await writeFile(path.join(base, 'catalog.json'), source.bytes);
  const manifest = { schema: 'poe2-native-catalog-manifest/v1', status: c.status, production_ready: false,
    game: c.game, game_patch: c.game_patch, realm: c.realm, locale: c.locale,
    files: { 'catalog.json': { bytes: source.bytes.length, sha256: source.sha256 } } };
  const publish = async suffix => {
    const raw = Buffer.from(JSON.stringify(manifest) + suffix);
    await writeFile(path.join(base, 'manifest.json'), raw);
    return { schema: 'poe2-translation-workbench-request/v1', catalogs: [{ manifest: path.join(base, 'manifest.json'), sha256: hash(raw) }] };
  };
  await writeWorkbench(await publish(' '.repeat(1024 * 1024)), path.join(base, 'accepted'));
  manifest.files['catalog.json'].bytes += 1;
  await assert.rejects(writeWorkbench(await publish(''), path.join(base, 'wrong-size')), /size differs/);
  manifest.files['catalog.json'].bytes -= 1;
  manifest.files['catalog.json'].sha256 = '0'.repeat(64);
  await assert.rejects(writeWorkbench(await publish(''), path.join(base, 'wrong-hash')), /Pinned input differs/);
  delete manifest.files['catalog.json'];
  await assert.rejects(writeWorkbench(await publish(''), path.join(base, 'missing-pin')), /Missing pinned catalog/);
});

test('compact synthetic reviewed export is pinned, scoped, deterministic and keeps official lookup official-only', () => {
  const source = input(), manual = edit(source, reviewed);
  const runtime = exportReviewedSupplements([source], edits([manual]));
  assert.deepEqual(runtime, exportReviewedSupplements([source], edits([manual])));
  assert.equal(runtime.schema, 'poe2-reviewed-native-supplements/v1');
  assert.deepEqual(runtime.sources, [{ game: 'poe2', game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN',
    catalog_sha256: source.sha256, verification: null }]);
  assert.equal(runtime.records.length, 1);
  assert.deepEqual(runtime.records[0].review, reviewed.review);
  assert.equal(runtime.records[0].entry_id, manual.entry_id);
  assert.equal(runtime.records[0].source, 0);
  assert(!Object.hasOwn(runtime.records[0], 'seen_in'));
  assert(!Object.hasOwn(runtime.records[0], 'effective_translation'));
  const catalog = JSON.parse(source.bytes);
  assert.equal(createCatalogLookup(catalog, catalog)(query()).reason, 'unchanged-text');
  const lookup = createReviewedSupplementLookup([source], pinned(runtime));
  assert.deepEqual(lookup(query()), { status: 'translated', text: '药剂', origin: 'agent', reason: 'reviewed-supplement', ids: ['stable'] });
  assert.equal(lookup(query({ id: 'unknown' })).reason, 'missing-identity-or-text');
  assert.equal(lookup(query({ english: 'Old English' })).reason, 'source-english-changed');
  assert.equal(lookup(query({ context: undefined })).origin, null);
  assert.throws(() => lookup(query({ game_patch: '0.5.5.6' })), /game_patch/);
  assert.throws(() => lookup(query({ realm: 'china' })), /realm/);
  assert.throws(() => lookup(query({ locale: 'zh-TW' })), /locale/);
  const china = input({ realm: 'china' }), tw = input({ locale: 'zh-TW' });
  const multiEdits = edits([manual, edit(china, { ...reviewed, origin: 'human', text: '国服药剂' })]);
  const multi = pinned(exportReviewedSupplements([source, china, tw], multiEdits));
  const scoped = createReviewedSupplementLookup([tw, china, source], multi);
  assert.equal(scoped(query({ realm: 'china' })).text, '国服药剂');
  assert.equal(scoped(query({ realm: 'china' })).origin, 'human');
  assert.equal(scoped(query()).text, '药剂');
  assert.equal(scoped(query({ locale: 'zh-TW' })).origin, null);
});

test('runtime excludes drafts, rejected/stale edits, blockers and official text; source rejection is unverified', () => {
  for (const source of [input(), input({ missing: true }), input({ english: '[DNT] Flask' }),
    input({ english: 'Gain {} Life' }), input({ localized: '官方药瓶' }), observedInput(['target_nontext-mismatch', 'fk-key-mismatch'])]) {
    for (const state of [{}, { status: 'rejected' }, reviewed]) {
      const manual = edit(source, state), runtime = exportReviewedSupplements([source], edits([manual]));
      if (source.sha256 === input().sha256 && state === reviewed) assert.equal(runtime.records.length, 1);
      else assert.equal(runtime.records.length, 0);
    }
  }
  const source = observedInput(['target_nontext-mismatch', 'fk-key-mismatch']);
  const previous = reconcileNativeTranslations([source], edits([edit(source, reviewed)]));
  assert.equal(previous.entries[0].official_translation.status, 'unverified');
  assert.equal(previous.entries[0].effective_translation.text, null);
  assert.deepEqual(previous.entries[0].regional_scope.reason_codes, ['target_nontext-mismatch', 'fk-key-mismatch']);
  const retired = reconcileNativeTranslations([input({ locale: 'zh-TW' })], edits([edit(source, reviewed)]), previous)
    .entries.find(r => r.lifecycle === 'out-of-scope');
  assert.deepEqual(retired.regional_scope.reason_codes, previous.entries[0].regional_scope.reason_codes);
  assert.equal(retired.translation.review.by, 'fixture-reviewer');
  const lookup = createReviewedSupplementLookup([source], pinned(exportReviewedSupplements([source])));
  assert.equal(lookup(query()).reason, 'target-binding-rejected');
  assert.equal(lookup(query()).origin, null);
  // Accepted v2 missing text still supports reviewed supplements.
  const accepted = observedInput();
  assert.equal(createReviewedSupplementLookup([accepted], pinned(exportReviewedSupplements([accepted], edits([edit(accepted, reviewed)]))))(query()).text, '药剂');
});

test('runtime rejects stale catalog/patch, unknown sources, duplicate identities and forged review bindings', () => {
  const source = input(), runtime = exportReviewedSupplements([source], edits([edit(source, reviewed)]));
  assert.throws(() => createReviewedSupplementLookup([source], { ...pinned(runtime), sha256: 'f'.repeat(64) }), /Runtime SHA256/);
  for (const mutate of [
    r => { r.sources[0].catalog_sha256 = 'a'.repeat(64); },
    r => { r.sources[0].game_patch = '0.5.5.6'; },
    r => { r.sources[0].realm = 'china'; },
    r => { r.sources[0].locale = 'zh-TW'; },
    r => { r.sources.push(r.sources[0]); },
    r => { r.sources = []; },
    r => { r.records[0].source = 2; },
    r => { r.records.push(r.records[0]); },
    r => { r.records[0].review = null; },
    r => { r.records[0].status = 'draft'; },
    r => { r.records[0].english = 'Wrong English'; },
    r => { r.records[0].english = 'Wrong English'; r.records[0].entry_id = entryId(edit(source).identity, r.records[0].english, r.records[0].context); },
    r => { r.records[0].id = 'unknown'; },
    r => { r.records[0].context = { unknown: 1 }; },
    r => { r.records[0].text = '药剂 999'; },
  ]) {
    const forged = structuredClone(runtime); mutate(forged);
    assert.throws(() => createReviewedSupplementLookup([source], pinned(forged)), /runtime|Runtime|reviewer|entry_id/);
  }
  for (const update of [input({ patch: '0.5.5.6' }), input({ localized: '' }), input({ realm: 'china' })]) {
    assert.throws(() => createReviewedSupplementLookup([update], pinned(runtime)), /runtime source/);
    assert.equal(exportReviewedSupplements([update], edits([edit(source, reviewed)])).records.length, 0);
  }
});

test('new official text overrides supplements, while prior review/history remains in workbench only', () => {
  const source = input(), manual = edit(source, reviewed), update = input({ localized: '官方药瓶' });
  const previous = reconcileNativeTranslations([source], edits([manual]));
  const book = reconcileNativeTranslations([update], edits([manual]), previous);
  const runtime = exportReviewedSupplements([update], edits([manual]));
  assert.equal(runtime.records.length, 0);
  assert.equal(book.entries[0].translation.text, '药剂');
  assert.equal(book.entries[0].seen_in.length, 2);
  assert.equal(book.entries[0].supplement_differs, true);
  assert.deepEqual(createReviewedSupplementLookup([update], pinned(runtime))(query()), {
    status: 'translated', text: '官方药瓶', reason: null, ids: ['stable'], origin: 'official' });
});

test('compact exact supplements preserve homonym/conflict fallback and require complete context', () => {
  const row = (id, Name, ItemClass) => ({ _row: id === 'stable' ? 0 : 1, values: { Id: id, Name, Inflection: '', ItemClass } });
  const c = JSON.parse(input().bytes);
  Object.assign(c, pairDisplayCatalog({ BaseItemTypes: { rows: [row('stable', 'Flask', 2), row('other', 'Flask', 3)] } },
    { BaseItemTypes: { rows: [row('stable', 'Flask', 2), row('other', '另一官方名', 3)] } }, c.language, ['BaseItemTypes']));
  const source = pinned(c), e = reconcileNativeTranslations([source]).entries.find(r => r.identity.id === 'stable' && r.identity.field === 'Name');
  const manual = { ...edit(input(), reviewed), entry_id: e.entry_id, identity: e.identity, english: e.english, context: e.context, based_on: e.current };
  const lookup = createReviewedSupplementLookup([source], pinned(exportReviewedSupplements([source], edits([manual]))));
  const q = query({ table: 'BaseItemTypes', context: { ItemClass: 2 } });
  assert.equal(lookup(q).text, '药剂');
  assert.equal(lookup({ ...q, context: {} }).origin, null);
  assert.equal(lookup({ ...q, context: { ItemClass: 3 } }).reason, 'context-mismatch');
  assert.equal(lookup({ ...q, id: 'other', context: { ItemClass: 3 } }).origin, 'official');
  const { id, context, ...textOnly } = q;
  assert.equal(lookup(textOnly).reason, 'unresolved-homonym');
});

test('v3 ingress requires original pinned Buffer and independently verifies its contents', async t => {
  const c = JSON.parse(input().bytes);
  c.schema = 'poe2-native-catalog/v3';
  c.observed_client = { game: 'poe2', game_patch: null, realm: null };
  c.target_binding = { policy_id: 'stable-key-pinned-fk-structure/v1',
    target_identity: { game: 'poe2', game_patch: c.game_patch, realm: c.realm } };
  const verification = Buffer.from('{"observed":{"retained":{},"manifest":{"format":"forged"}},"owners":{}}\n');
  c.fk_verification = { file: 'verification.json', bytes: verification.length, sha256: hash(verification) };
  const source = pinned(c);
  assert.throws(() => reconcileNativeTranslations([source]), /pinned FK verification sidecar/);
  assert.throws(() => reconcileNativeTranslations([{ ...source, verification: Buffer.from('tampered') }]), /pinned FK verification sidecar/);
  assert.throws(() => reconcileNativeTranslations([{ ...source, verification: verification.toString() }]), /pinned FK verification sidecar/);
  assert.throws(() => reconcileNativeTranslations([{ ...source, verification }]), /Invalid strict v2 parent/);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const base = await mkdtemp(path.join(root, '.cache/workbench-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(base, 'catalog.json'), source.bytes);
  const manifest = { schema: 'poe2-native-catalog-manifest/v3', status: c.status, production_ready: false,
    game: c.game, game_patch: c.game_patch, realm: c.realm, locale: c.locale,
    files: { 'catalog.json': { bytes: source.bytes.length, sha256: source.sha256 },
      'verification.json': { bytes: verification.length, sha256: hash(verification) } } };
  const publish = async () => {
    const raw = Buffer.from(JSON.stringify(manifest)); await writeFile(path.join(base, 'manifest.json'), raw);
    return { schema: 'poe2-translation-workbench-request/v1', catalogs: [{ manifest: path.join(base, 'manifest.json'), sha256: hash(raw) }] };
  };
  await writeFile(path.join(base, 'verification.json'), verification);
  await assert.rejects(writeWorkbench(await publish(), path.join(base, 'forged')), /Invalid strict v2 parent/);
  manifest.files['verification.json'].sha256 = '0'.repeat(64);
  await assert.rejects(writeWorkbench(await publish(), path.join(base, 'wrong-pin')), /verification pin differs/);
});
