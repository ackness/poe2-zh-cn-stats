import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pairDisplayCatalog } from '../src/native-catalog.mjs';
import { reconcileNativeTranslations, createSupplementedLookup, writeWorkbench, workbenchCommand } from '../src/translation-workbench.mjs';

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
  const root = fileURLToPath(new URL('../', import.meta.url));
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
  const result = await workbenchCommand('workbench-list', ['--file', path.join(base, 'a/workbench.json'), '--status', 'pending', '--realm', 'international']);
  assert.equal(result.total, 1); assert.equal(result.entries[0].english, 'Flask');
  await assert.rejects(writeWorkbench(config, path.join(base, 'a')), /EEXIST/);
  await assert.rejects(workbenchCommand('workbench-list', ['--file', path.join(base, 'a/workbench.json'), '--status', 'typo']), /Unknown/);
});

test('Git JSON inputs have no fixed cap while catalog byte and hash pins remain mandatory', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
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
