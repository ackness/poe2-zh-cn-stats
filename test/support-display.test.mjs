import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { strictJson } from '../src/strict-json.mjs';
import { readZip, storedZip } from '../src/stored-zip.mjs';
import { ROOT, build, check, checkRelease, loadConfig, pin, releaseUrl, sha256 } from '../src/locale-release.mjs';
import { releaseBody, samePayload, stage } from '../src/locale-release-publish.mjs';
import { DISPLAY_ASSET, MANIFEST_ASSET, displayInputs, fetchDisplayInputs, regenCommand } from '../src/support-display.mjs';
import { bytes, commitAll, config, fixture, gitIn, write } from './locale-release-fixture.mjs';

const DISPLAY_DIR = 'inputs/support-display-test';
const COMMIT = 'd'.repeat(40); // the fixture's i18n/zh-CN/_meta.json source_commit
const SOURCE = 'https://github.com/example/dict';
const CATALOG = bytes({ _meta: {}, gems: [
  { skill_id: 'SupportB', description: 'Supports nothing.', is_support: true },
  { skill_id: 'SupportA', description: 'Supports Attacks.', is_support: true },
  { skill_id: 'Active', description: 'Supports Attacks.', is_support: false },
] });
const CATALOG_SHA = sha256(CATALOG);
const MEMBER = 'data/9.9/overlay/trade_catalog.json';
const GAME_ZIP = storedZip(new Map([[MEMBER, CATALOG], ['manifest.json', bytes({ files: { [MEMBER]: pin(CATALOG) } })]]));
const DICTIONARY = bytes({ table: 'GemEffects', entries: [{ columns: { SupportText: [{ en: 'Supports [Attack|Attacks].', zh: '辅助[Attack|攻击]。' }] } }] });
const ENTRIES = { SupportA: { en: 'Supports Attacks.', zh_cn: '辅助攻击。' } };
const UNTRANSLATED = ['SupportB'];
const dictionary = (raw = DICTIONARY) => ({ source: SOURCE, source_commit: COMMIT, source_file: 'tables/GemEffects.json',
  url: `https://raw.githubusercontent.com/example/dict/${COMMIT}/dictionary/tables/GemEffects.json`, ...pin(raw) });
const catalog = (zip = GAME_ZIP) => ({ repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip', ...pin(zip), member: MEMBER });
const sourceFields = { source: SOURCE, source_commit: COMMIT, source_file: 'tables/GemEffects.json', source_sha256: sha256(DICTIONARY) };

// A retained publication generated for 9.8 whose catalog equals 9.9's.
function retained({ meta = {}, manifest = {}, entries = ENTRIES } = {}) {
  const assetRaw = bytes({ _meta: { ...sourceFields, data_version: '9.8', catalog_sha256: CATALOG_SHA, regen_command: 'old', ...meta },
    entries, untranslated: UNTRANSLATED });
  const manifestRaw = bytes({ schema: 'poe2-support-display-publication/v1', target: { game: 'poe2', version: '9.9', realm: 'international' },
    locale: 'zh-CN', catalog_sha256: CATALOG_SHA, files: { [DISPLAY_ASSET]: pin(assetRaw) },
    provenance: { kind: 'retained-generated-asset', generation_data_version: '9.8', ...sourceFields }, ...manifest });
  return { assetRaw, manifestRaw };
}

const retainedSpec = (files, revision, extra = {}) => ({ mode: 'retained', catalog_sha256: CATALOG_SHA,
  manifest: { path: `${DISPLAY_DIR}/manifest.json`, ...pin(files.manifestRaw) }, asset: pin(files.assetRaw),
  origin: { repository: 'ackness/poe2-zh-cn-stats', tag: 'handoff/display-test', revision }, ...extra });

// release/9.9.json declaring `display`; the locale source's origin is the fixture's first commit.
function releaseConfig(repo, manifestRaw, extra) {
  const declared = config(manifestRaw, extra);
  const revision = gitIn(repo, 'rev-list', '--max-parents=0', 'HEAD');
  return bytes({ ...declared, source: { ...declared.source, origin: { ...declared.source.origin, revision } } });
}
function writeConfig(repo, manifestRaw, display) {
  write(repo, 'release/9.9.json', releaseConfig(repo, manifestRaw, display ? { support_display: display } : {}));
}

// The fixture checkout with a committed retained display and a config that declares it.
function retainedFixture(t, { files = retained(), extra = {} } = {}) {
  const context = fixture('support-display');
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  const { repo, manifestRaw } = context;
  const plain = build({ repo, out: path.join(repo, '.cache/plain') });
  write(repo, `${DISPLAY_DIR}/manifest.json`, files.manifestRaw);
  write(repo, `${DISPLAY_DIR}/${DISPLAY_ASSET}`, files.assetRaw);
  write(repo, `${DISPLAY_DIR}/README.md`, 'retained\n');
  const origin = commitAll(repo, 'retained display');
  const spec = retainedSpec(files, origin, extra);
  writeConfig(repo, manifestRaw, spec);
  commitAll(repo, 'declare the display');
  return { ...context, plain, files, spec, origin };
}

const served = entries => async url => {
  const raw = new Map(entries).get(url);
  if (!raw) throw new Error(`GET ${url}: HTTP 404`);
  return raw;
};
const inputsServer = (dict = DICTIONARY, zip = GAME_ZIP) => served([
  [dictionary().url, dict], [releaseUrl('ackness/repoe', 'game/9.9-1', 'pobr-game-9.9.zip'), zip]]);

test('retained: the two files ride beside the unchanged zip, in SHA256SUMS and the receipt', t => {
  const { repo, plain, files } = retainedFixture(t);
  const built = build({ repo });
  assert.deepEqual(built.zip, plain.zip);
  assert.deepEqual(readFileSync(path.join(built.out, MANIFEST_ASSET)), files.manifestRaw);
  assert.deepEqual(readFileSync(path.join(built.out, DISPLAY_ASSET)), files.assetRaw);
  assert.deepEqual(readZip(built.zip).has(`data/9.9/${DISPLAY_ASSET}`), false);
  const shown = built.receipt.support_display;
  assert.deepEqual(shown.manifest, { asset: MANIFEST_ASSET, ...pin(files.manifestRaw) });
  assert.deepEqual(shown.asset, { asset: DISPLAY_ASSET, ...pin(files.assetRaw) });
  assert.deepEqual([shown.mode, shown.catalog_sha256, shown.generation_data_version, shown.counts],
    ['retained', CATALOG_SHA, '9.8', { entries: 1, untranslated: 1 }]);
  assert.deepEqual(shown.source.asset, { path: `${DISPLAY_DIR}/${DISPLAY_ASSET}`, ...pin(files.assetRaw) });
  assert.equal(readFileSync(path.join(built.out, 'SHA256SUMS'), 'utf8'), [
    `${sha256(built.zip)}  pobr-locale-9.9.zip`, `${sha256(built.receiptRaw)}  receipt.json`,
    `${sha256(files.manifestRaw)}  ${MANIFEST_ASSET}`, `${sha256(files.assetRaw)}  ${DISPLAY_ASSET}`].join('\n') + '\n');
  assert.deepEqual(check(repo, built), []);
  // The retained directory must keep its origin tree.
  write(repo, `${DISPLAY_DIR}/README.md`, 'changed\n');
  commitAll(repo, 'change the retained tree');
  assert.deepEqual(check(repo, build({ repo })), [`${DISPLAY_DIR} differs from ${DISPLAY_DIR} at handoff/display-test`]);
});

test('retained: pin, catalog and provenance mismatches are refused', t => {
  const { repo, manifestRaw, files, spec } = retainedFixture(t);
  const refuses = (display, pattern, label) => {
    writeConfig(repo, manifestRaw, display);
    assert.throws(() => build({ repo }), pattern, label);
  };
  refuses({ ...spec, asset: { ...spec.asset, sha256: '0'.repeat(64) } }, /Pin mismatch: .*supportDescriptions\.zh-CN\.json/u, 'asset pin');
  refuses({ ...spec, manifest: { ...spec.manifest, bytes: 1 } }, /Pin mismatch: .*manifest\.json/u, 'manifest pin');
  refuses({ ...spec, catalog_sha256: 'e'.repeat(64) }, /Catalog mismatch: the manifest binds/u, 'config catalog');
  refuses({ ...spec, mode: 'copied' }, /mode must be one of/u, 'mode');
  refuses({ ...spec, extra: 1 }, /unknown fields/u, 'unknown field');
  refuses({ ...spec, dictionary: dictionary() }, /declare dictionary and catalog together/u, 'half the inputs');
  // Inconsistent files, each with matching pins.
  const variant = (changed, pattern, label) => {
    write(repo, `${DISPLAY_DIR}/manifest.json`, changed.manifestRaw);
    write(repo, `${DISPLAY_DIR}/${DISPLAY_ASSET}`, changed.assetRaw);
    refuses(retainedSpec(changed, spec.origin.revision), pattern, label);
  };
  variant(retained({ meta: { catalog_sha256: 'e'.repeat(64) } }), /Catalog mismatch: _meta\.catalog_sha256/u, '_meta catalog');
  variant(retained({ meta: { data_version: '9.9' } }), /Provenance mismatch: _meta\.data_version 9\.9/u, 'data version');
  variant(retained({ meta: { source_sha256: 'f'.repeat(64) } }), /Provenance mismatch: _meta source_sha256 differ/u, 'source');
  variant(retained({ meta: { source_commit: 'c'.repeat(40) }, manifest: { provenance: { kind: 'x', generation_data_version: '9.8',
    ...sourceFields, source_commit: 'c'.repeat(40) } } }), /i18n\/zh-CN\/_meta\.json source_commit d{40}/u, 'locale commit');
  variant(retained({ manifest: { target: { game: 'poe2', version: '9.8', realm: 'international' } } }), /expected poe2-support-display/u, 'target');
  const stale = retained();
  variant({ ...stale, manifestRaw: retained({ manifest: { files: { [DISPLAY_ASSET]: { bytes: 1, sha256: '0'.repeat(64) } } } }).manifestRaw },
    /files must pin exactly/u, 'manifest pins another asset');
  write(repo, `${DISPLAY_DIR}/manifest.json`, files.manifestRaw);
  write(repo, `${DISPLAY_DIR}/${DISPLAY_ASSET}`, files.assetRaw);
  write(repo, `${DISPLAY_DIR}/extra.json`, '{}\n');
  refuses(spec, /Unlisted files in inputs\/support-display-test: extra\.json/u, 'unlisted');
});

test('retained: declared inputs must regenerate its entries (check)', async t => {
  const { repo, manifestRaw, spec } = retainedFixture(t);
  const declared = { ...spec, dictionary: dictionary(), catalog: catalog() };
  writeConfig(repo, manifestRaw, declared);
  commitAll(repo, 'declare the inputs');
  // Offline and uncached: the build succeeds, the check names the missing download.
  assert.match(check(repo, build({ repo })).join('\n'), /is not cached under \.cache\/release\/inputs \(run release:build with --fetch\)/u);
  await fetchDisplayInputs(repo, declared, { fetcher: inputsServer() });
  assert.deepEqual(check(repo, build({ repo })), []);
  // Entries that do not follow from the inputs fail the check.
  const other = retained({ entries: { SupportA: { en: 'Supports Attacks.', zh_cn: '别的' } } });
  write(repo, `${DISPLAY_DIR}/manifest.json`, other.manifestRaw);
  write(repo, `${DISPLAY_DIR}/${DISPLAY_ASSET}`, other.assetRaw);
  writeConfig(repo, manifestRaw, { ...retainedSpec(other, spec.origin.revision), dictionary: dictionary(), catalog: catalog() });
  assert.ok(check(repo, build({ repo })).includes("the support display's entries do not regenerate from its declared dictionary and catalog"));
  // A provenance that is not the declared dictionary's is refused at build.
  writeConfig(repo, manifestRaw, { ...retainedSpec(other, spec.origin.revision), catalog: catalog(), dictionary: { ...dictionary(), source_commit: 'c'.repeat(40),
    url: `https://raw.githubusercontent.com/example/dict/${'c'.repeat(40)}/tables/GemEffects.json` } });
  assert.throws(() => build({ repo }), /support_display\.dictionary source_commit differ/u);
});

// What the regenerate mode must write, spelled out independently of src/support-display.mjs.
function expectedRegenerated(configPath, applicability) {
  const assetRaw = bytes({ _meta: { ...sourceFields, data_version: '9.9', catalog_sha256: CATALOG_SHA, regen_command: regenCommand(configPath) },
    entries: ENTRIES, untranslated: UNTRANSLATED });
  const manifestRaw = bytes({ schema: 'poe2-support-display-publication/v1', target: { game: 'poe2', version: '9.9', realm: 'international' },
    locale: 'zh-CN', catalog_sha256: CATALOG_SHA, files: { [DISPLAY_ASSET]: pin(assetRaw) },
    provenance: { kind: 'generated-asset', generation_data_version: '9.9', ...sourceFields,
      catalog: { repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip', sha256: sha256(GAME_ZIP), member: MEMBER } },
    ...(applicability ? { applicability } : {}) });
  return { assetRaw, manifestRaw };
}

test('regenerate: the projection of the pinned downloads, written deterministically', async t => {
  const context = fixture('support-display');
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  const { repo, manifestRaw } = context;
  const expected = expectedRegenerated('release/9.9.json', 'Only with matching English.');
  const spec = { mode: 'regenerate', catalog_sha256: CATALOG_SHA, dictionary: dictionary(), catalog: catalog(),
    applicability: 'Only with matching English.', manifest: pin(expected.manifestRaw), asset: pin(expected.assetRaw) };
  writeConfig(repo, manifestRaw, spec);
  commitAll(repo, 'declare a regenerated display');
  assert.throws(() => build({ repo }), /support_display\.dictionary: .* is not cached .*--fetch/u);
  // Downloads must match their pins; nothing is cached otherwise.
  await assert.rejects(fetchDisplayInputs(repo, spec, { fetcher: inputsServer(Buffer.from('{}')) }), /support_display\.dictionary: .* the config pins/u);
  assert.deepEqual(displayInputs(spec).map(input => input.url), [dictionary().url,
    'https://github.com/ackness/repoe/releases/download/game/9.9-1/pobr-game-9.9.zip']);
  await fetchDisplayInputs(repo, spec, { fetcher: inputsServer() });
  const built = build({ repo });
  assert.deepEqual(readFileSync(path.join(built.out, DISPLAY_ASSET)), expected.assetRaw);
  assert.deepEqual(readFileSync(path.join(built.out, MANIFEST_ASSET)), expected.manifestRaw);
  assert.deepEqual(built.receipt.support_display.source, { dictionary: dictionary(), catalog: catalog() });
  assert.deepEqual(build({ repo, out: path.join(repo, '.cache/again') }).display.assetRaw, expected.assetRaw);
  assert.deepEqual(check(repo, built), []);
  // Output pins, the catalog binding and the game package's own manifest are enforced.
  const refuses = (display, pattern) => {
    writeConfig(repo, manifestRaw, display);
    assert.throws(() => build({ repo }), pattern);
  };
  refuses({ ...spec, asset: { ...spec.asset, bytes: 1 } }, /Pin mismatch: the regenerated supportDescriptions\.zh-CN\.json is \d+ bytes/u);
  refuses({ ...spec, manifest: { ...spec.manifest, sha256: '0'.repeat(64) } }, /Pin mismatch: the regenerated support-display\.zh-CN\.json/u);
  refuses({ ...spec, catalog_sha256: 'e'.repeat(64) }, /Catalog mismatch: game\/9\.9-1 data\/9\.9\/overlay\/trade_catalog\.json has SHA-256/u);
  const lying = storedZip(new Map([[MEMBER, CATALOG], ['manifest.json', bytes({ files: { [MEMBER]: { bytes: 1, sha256: '0'.repeat(64) } } })]]));
  const declared = { ...spec, catalog: catalog(lying) };
  await fetchDisplayInputs(repo, declared, { fetcher: inputsServer(DICTIONARY, lying) });
  refuses(declared, /differs from its manifest\.json pin/u);
  refuses({ ...spec, catalog: { ...catalog(), tag: 'game/9.8-1' } }, /needs ackness\/repoe's Release game\/9\.9-<n>/u);
  refuses({ ...spec, dictionary: { ...dictionary(), url: 'https://example.test/GemEffects.json' } }, /url must be https:\/\/raw\.githubusercontent\.com/u);
  refuses({ ...spec, origin: { repository: 'ackness/poe2-zh-cn-stats', tag: 't', revision: 'a'.repeat(40) } }, /unknown fields/u);
});

test('publish: stages both display files, lists them in SHA256SUMS and the notes', t => {
  const { repo, files } = retainedFixture(t);
  const built = build({ repo });
  const staged = stage(built.out, path.join(repo, '.cache/stage'));
  const names = ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json', DISPLAY_ASSET, MANIFEST_ASSET].sort();
  assert.deepEqual(Object.keys(staged.assets), names);
  assert.deepEqual(readdirSync(path.join(repo, '.cache/stage/assets')).sort(), names);
  assert.deepEqual(staged.assets[DISPLAY_ASSET], pin(files.assetRaw));
  assert.deepEqual(readFileSync(path.join(repo, '.cache/stage/assets', MANIFEST_ASSET)), files.manifestRaw);
  assert.deepEqual(readFileSync(path.join(repo, '.cache/stage/assets/SHA256SUMS')), readFileSync(path.join(built.out, 'SHA256SUMS')));
  const body = releaseBody(staged, 'locale/9.9-1', 1);
  assert.match(body, /Support display \(zh-CN, retained\): `support-display\.zh-CN\.json` \(\d+ bytes/u);
  assert.match(body, new RegExp(`Bound to the trade catalog SHA-256 \`${CATALOG_SHA}\``, 'u'));
  assert.match(body, /also moves PoBR's support display to this Release/u);
  // The same zip with another display is new content; the same zip and display are not.
  const sums = Object.fromEntries(Object.entries(staged.assets).map(([name, value]) => [name, value.sha256]));
  assert.equal(samePayload({ ...sums, 'receipt.json': '0'.repeat(64) }, staged.assets), true);
  assert.equal(samePayload({ ...sums, [DISPLAY_ASSET]: '0'.repeat(64) }, staged.assets), false);
  assert.equal(samePayload({ 'pobr-locale-9.9.zip': sums['pobr-locale-9.9.zip'] }, staged.assets), false);
  assert.equal(samePayload(null, staged.assets), false);
  // A display file that no longer matches the receipt is not staged.
  write(repo, path.relative(repo, path.join(built.out, DISPLAY_ASSET)), Buffer.from('{}\n'));
  assert.throws(() => stage(built.out, path.join(repo, '.cache/stage')), /supportDescriptions\.zh-CN\.json differs from its pin in receipt\.json/u);
});

test('check-release: the published SHA256SUMS must list the rebuilt display', async t => {
  const { repo, manifestRaw, spec } = retainedFixture(t);
  const plain = build({ repo });
  writeConfig(repo, manifestRaw, spec);
  write(repo, 'release/9.9.json', releaseConfig(repo, manifestRaw, { support_display: spec,
    published: { tag: 'locale/9.9-1', asset: 'pobr-locale-9.9.zip', ...pin(plain.zip) } }));
  const built = build({ repo });
  const url = name => releaseUrl('ackness/poe2-zh-cn-stats', 'locale/9.9-1', name);
  const zipLine = `${sha256(built.zip)}  pobr-locale-9.9.zip\n`;
  await assert.rejects(checkRelease(built, served([[url('SHA256SUMS'), Buffer.from(zipLine)], [url('pobr-locale-9.9.zip'), built.zip]])),
    /SHA256SUMS does not list the rebuilt support-display\.zh-CN\.json/u);
  await checkRelease(built, served([[url('SHA256SUMS'), readFileSync(path.join(built.out, 'SHA256SUMS'))], [url('pobr-locale-9.9.zip'), built.zip]]));
});

test('the committed 0.5.5.5-2 config ships the retained display of handoff/support-display-20261101', t => {
  const file = path.join(ROOT, 'release/0.5.5.5-2.json');
  const loaded = loadConfig(file), spec = loaded.config.support_display;
  assert.equal(spec.mode, 'retained');
  assert.equal(spec.catalog_sha256, 'de57e010c8bf93f18bf557c650d6cdc06d98bc3fbde58049227b31feda9deea6');
  assert.equal(loadConfig(path.join(ROOT, 'release/0.5.5.5.json')).config.support_display, undefined);
  const out = path.join(ROOT, '.cache', `support-display-real-${process.pid}`);
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const built = build({ config: file, out });
  assert.deepEqual(pin(built.zip), loaded.config.expect.package);
  assert.deepEqual(pin(built.display.assetRaw), spec.asset);
  // PoBR's web test: the display's dictionary commit is the language package's.
  assert.equal(strictJson(built.display.assetRaw)._meta.source_commit,
    strictJson(readFileSync(path.join(ROOT, 'inputs/locale-0.5.5.5/i18n/zh-CN/_meta.json'))).source_commit);
});
