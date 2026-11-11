import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { strictJson } from '../../src/strict-json.mjs';
import { readZip } from '../../src/release/stored-zip.mjs';
import { build, check, defaultConfig, loadConfig, pin } from '../../src/release/build.mjs';
import { localeIndex, rekeyByEnglish } from '../../src/release/package.mjs';
import { TARGET, bytes, commitAll, config, fixture, gitIn, sourceManifest, write } from './fixture.mjs';

// zh-TW mods keyed by mod id, and the pairing receipt that pins exactly those bytes.
const MODS = bytes({ Strength1: '野蠻之', Strength2: '野蠻之', Fire1: '火山之', Fire2: '之火山', Fire3: '之火山', Cold1: '冰之', Cold2: '之冰' });
const record = (id, english, localized, row) => ({ table: 'Mods', key_field: 'Id', id, field: 'Name', english, localized,
  english_row: row, localized_row: row });
const NAME_RECEIPT = bytes({
  schema: 'pobr-native-name-receipt/v1',
  records: { 'mods.json': { table: 'Mods', field: 'Name', adopted: [
    record('Strength1', 'of the Brute', '野蠻之', 0), record('Strength2', 'of the Brute', '野蠻之', 1),
    record('Fire1', 'of the Volcano', '火山之', 2), record('Fire2', 'of the Volcano', '之火山', 3),
    record('Fire3', 'of the Volcano', '之火山', 4), record('Cold1', 'of the Ice', '冰之', 6), record('Cold2', 'of the Ice', '之冰', 5),
  ], removed: [], historical_compatibility: [] } },
  files: { 'mods.json': pin(MODS) },
});
const BASE_FILES = {
  'i18n/zh-CN/_meta.json': bytes({ counts: {} }),
  'i18n/zh-CN/mods.json': bytes({ 'of the Brute': '野蛮之', 'of the Ice': '冰之', 'of the Storm': '风暴之' }),
  'i18n/zh-TW/mods.json': MODS,
  'evidence/zh-TW-receipt.json': NAME_RECEIPT,
};
const TRANSFORMS = [
  { id: 'zh-tw-mods-by-english', kind: 'rekey-by-english', member: 'i18n/zh-TW/mods.json',
    records: 'evidence/zh-TW-receipt.json', table: 'mods.json', conflicts: 'most-common-then-first-row' },
  { id: 'zh-tw-meta', kind: 'json', member: 'i18n/zh-TW/_meta.json', value: { fallback: ['zh-CN'] } },
];
const UNKNOWN = { package: { bytes: 1, sha256: '0'.repeat(64) } };
const v2 = extra => ({ schema: 'poe2-locale-release-config/v2', target: TARGET, base: { config: 'release/9.9.json' },
  transforms: TRANSFORMS, expect: UNKNOWN, ...extra });

// The fixture's checkout with BASE_FILES as release/9.9.json's publication and release/9.9-2.json on top.
function v2Fixture(t, extra = {}) {
  const made = fixture('locale-release-v2');
  t.after(() => rmSync(made.root, { recursive: true, force: true }));
  const { repo } = made;
  gitIn(repo, 'rm', '-rq', 'inputs');
  for (const [name, raw] of Object.entries(BASE_FILES)) write(repo, `inputs/locale-test/${name}`, raw);
  const manifestRaw = sourceManifest(BASE_FILES);
  write(repo, 'inputs/locale-test/manifest.json', manifestRaw);
  const commit = commitAll(repo, 'base publication');
  const declared = config(manifestRaw);
  write(repo, 'release/9.9.json', bytes({ ...declared, source: { ...declared.source,
    origin: { ...declared.source.origin, revision: commit } } }));
  write(repo, 'release/9.9-2.json', bytes(v2(extra)));
  commitAll(repo, 'v2 config');
  return { ...made, manifestRaw };
}

test('rekey-by-english: one key per English text, most common translation, ties to the first row', () => {
  const { raw, report } = rekeyByEnglish(MODS, NAME_RECEIPT, 'mods.json');
  assert.deepEqual(strictJson(raw), { 'of the Brute': '野蠻之', 'of the Ice': '之冰', 'of the Volcano': '之火山' });
  assert.deepEqual(Object.keys(strictJson(raw)), ['of the Brute', 'of the Ice', 'of the Volcano']);
  assert.deepEqual(report, { ids: 7, english_keys: 3, conflicts: [
    { english: 'of the Ice', chosen: '之冰', alternatives: { 之冰: 1, 冰之: 1 } },
    { english: 'of the Volcano', chosen: '之火山', alternatives: { 之火山: 2, 火山之: 1 } },
  ] });
  // The receipt must pin these exact bytes and agree with every entry.
  assert.throws(() => rekeyByEnglish(bytes({ Strength1: '野蠻之' }), NAME_RECEIPT, 'mods.json'), /does not pin/u);
  const edited = strictJson(NAME_RECEIPT);
  edited.records['mods.json'].adopted[0].localized = '別的';
  assert.throws(() => rekeyByEnglish(MODS, bytes(edited), 'mods.json'), /differ from the receipt/u);
});

test('index: fallback chains from _meta.json and coverage of the fallback language', () => {
  const members = new Map([
    ['i18n/zh-CN/mods.json', bytes({ a: '甲', b: '乙' })], ['i18n/zh-CN/stat_lines.json', bytes([{ src: '甲', en: 'A' }])],
    ['i18n/zh-TW/_meta.json', bytes({ fallback: ['zh-CN'] })], ['i18n/zh-TW/mods.json', bytes({ a: '甲', c: '丙' })],
  ]);
  assert.deepEqual(localeIndex(members), { languages: {
    'zh-CN': { fallback: [], tables: { 'mods.json': { entries: 2 }, 'stat_lines.json': { entries: 1 } } },
    'zh-TW': { fallback: ['zh-CN'], tables: { 'mods.json': { entries: 2, fallback_keys_covered: 1, fallback_entries: 2 } } },
  } });
});

test('v2 build: the base package with its transforms applied; check pins the expected package', t => {
  const { repo, manifestRaw } = v2Fixture(t);
  assert.equal(defaultConfig(repo), path.join(repo, 'release/9.9-2.json'));
  const base = build({ repo, config: path.join(repo, 'release/9.9.json') });
  const built = build({ repo });
  assert.equal(built.out, path.join(repo, '.cache/release/poe2-international-9.9-2'));
  const read = readZip(built.zip);
  assert.deepEqual([...read.keys()].sort(), ['data/9.9/i18n/zh-CN/_meta.json', 'data/9.9/i18n/zh-CN/mods.json',
    'data/9.9/i18n/zh-TW/_meta.json', 'data/9.9/i18n/zh-TW/mods.json', 'manifest.json']);
  // Untouched members keep the base bytes; transformed ones are the transforms' output.
  for (const name of ['data/9.9/i18n/zh-CN/_meta.json', 'data/9.9/i18n/zh-CN/mods.json']) {
    assert.deepEqual(read.get(name).raw, readZip(base.zip).get(name).raw);
  }
  assert.deepEqual(strictJson(read.get('data/9.9/i18n/zh-TW/_meta.json').raw), { fallback: ['zh-CN'] });
  assert.deepEqual(Object.keys(strictJson(read.get('data/9.9/i18n/zh-TW/mods.json').raw)), ['of the Brute', 'of the Ice', 'of the Volcano']);
  const manifest = strictJson(read.get('manifest.json').raw);
  assert.deepEqual(manifest.source, { repository: 'ackness/poe2-zh-cn-stats',
    publication: { path: 'inputs/locale-test/manifest.json', ...pin(manifestRaw) },
    transforms: TRANSFORMS.map(({ id, kind, member }) => ({ id, kind, member })) });
  const { receipt } = built;
  assert.deepEqual(Object.keys(receipt.producer.config), ['release/9.9-2.json', 'release/9.9.json']);
  assert.equal(receipt.source.base.config.path, 'release/9.9.json');
  assert.deepEqual(receipt.source.transforms.map(r => [r.id, r.report.conflicts?.length]), [['zh-tw-mods-by-english', 2], ['zh-tw-meta', undefined]]);
  assert.equal(receipt.package.members['data/9.9/i18n/zh-TW/mods.json'], 'transform:zh-tw-mods-by-english');
  assert.equal(receipt.package.members['data/9.9/i18n/zh-CN/mods.json'], 'inputs/locale-test/i18n/zh-CN/mods.json');
  assert.deepEqual(receipt.package.index.languages['zh-TW'].tables['mods.json'],
    { entries: 3, fallback_keys_covered: 2, fallback_entries: 3 });
  assert.deepEqual(check(repo, built), [`the package differs from the expected ${'0'.repeat(64)}`]);
  write(repo, 'release/9.9-2.json', bytes(v2({ expect: { package: pin(built.zip) } })));
  commitAll(repo, 'expectation');
  assert.deepEqual(check(repo, build({ repo })), []);
  assert.deepEqual(build({ repo }).zip, built.zip);
});

test('v2 build rejects a stale game_patch introduced by a json transform', t => {
  const { repo } = v2Fixture(t, { transforms: [{ ...TRANSFORMS[1], value: { game_patch: '9.8', fallback: ['zh-CN'] } }] });
  assert.throws(() => build({ repo }),
    { message: 'i18n/zh-TW/_meta.json: game_patch "9.8" differs from target "9.9"' });
});

test('v2 config: refuses unknown fields, bad transforms and a published tag for another sequence', t => {
  const { repo } = v2Fixture(t);
  const file = path.join(repo, 'release/9.9-2.json');
  const refuse = (value, pattern) => {
    write(repo, 'release/9.9-2.json', bytes(value));
    assert.throws(() => loadConfig(file, repo), pattern);
  };
  refuse(v2({ extra: 1 }), /unknown fields/u);
  refuse(v2({ expect: undefined }), /pins its intended package in expect\.package/u);
  refuse(v2({ base: { config: 'release/9.9-2.json' } }), /base must be a v1 config/u);
  refuse(v2({ transforms: [] }), /at least one transform/u);
  refuse(v2({ transforms: [TRANSFORMS[0], { ...TRANSFORMS[1], member: TRANSFORMS[0].member }] }), /repeated member/u);
  refuse(v2({ transforms: [{ ...TRANSFORMS[0], conflicts: 'first' }] }), /invalid records\/table\/conflicts/u);
  refuse(v2({ transforms: [{ ...TRANSFORMS[1], kind: 'rename' }] }), /unknown transform kind/u);
  refuse(v2({ published: { tag: 'locale/9.9-3', asset: 'pobr-locale-9.9.zip', bytes: 1, sha256: '0'.repeat(64) } }),
    /Invalid published package pin/u);
  refuse(v2({ hold: ' ' }), /hold must be a reason/u);
  write(repo, 'release/9.9-2.json', bytes(v2({ transforms: [{ ...TRANSFORMS[1], member: 'i18n/zh-CN/mods.json' }] })));
  assert.throws(() => build({ repo }), /already exists; a json transform only adds a member/u);
  write(repo, 'release/9.9-x.json', bytes(v2()));
  assert.throws(() => defaultConfig(repo), /named <game patch>\[-<n>\]/u);
  rmSync(path.join(repo, 'release/9.9-x.json'));
  // A held config is never the default.
  write(repo, 'release/9.9-2.json', bytes(v2({ hold: 'waiting for PoBR' })));
  assert.equal(defaultConfig(repo), path.join(repo, 'release/9.9.json'));
  write(repo, 'release/9.9.json', bytes({ ...strictJson(readFileSync(path.join(repo, 'release/9.9.json'))), hold: 'also waiting' }));
  assert.throws(() => defaultConfig(repo), /not on hold/u);
  assert.equal(strictJson(readFileSync(path.join(repo, 'release/9.9.json'))).schema, 'poe2-locale-release-config/v1');
});
