// Shared support display fixtures for test/support-display.test.mjs and the publish tests (no tests of its own).
import { storedZip } from '../../src/release/stored-zip.mjs';
import { pin, sha256 } from '../../src/release/build.mjs';
import { DISPLAY_ASSET } from '../../src/release/support-display.mjs';
import { bytes, commitAll, config, gitIn, write } from './fixture.mjs';

export const DISPLAY_DIR = 'inputs/support-display-test';
export const COMMIT = 'd'.repeat(40); // the fixture's i18n/zh-CN/_meta.json source_commit
export const SOURCE = 'https://github.com/example/dict';
export const CATALOG = bytes({ _meta: {}, gems: [
  { skill_id: 'SupportB', description: 'Supports nothing.', is_support: true },
  { skill_id: 'SupportA', description: 'Supports Attacks.', is_support: true },
  { skill_id: 'Active', description: 'Supports Attacks.', is_support: false },
] });
export const CATALOG_SHA = sha256(CATALOG);
export const MEMBER = 'data/9.9/overlay/trade_catalog.json';
export const GAME_ZIP = storedZip(new Map([[MEMBER, CATALOG], ['manifest.json', bytes({ files: { [MEMBER]: pin(CATALOG) } })]]));
export const DICTIONARY = bytes({ table: 'GemEffects', entries: [{ columns: { SupportText: [{ en: 'Supports [Attack|Attacks].', zh: '辅助[Attack|攻击]。' }] } }] });
export const ENTRIES = { SupportA: { en: 'Supports Attacks.', zh_cn: '辅助攻击。' } };
export const UNTRANSLATED = ['SupportB'];
export const dictionary = (raw = DICTIONARY) => ({ source: SOURCE, source_commit: COMMIT, source_file: 'tables/GemEffects.json',
  url: `https://raw.githubusercontent.com/example/dict/${COMMIT}/dictionary/tables/GemEffects.json`, ...pin(raw) });
export const catalog = (zip = GAME_ZIP) => ({ repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip', ...pin(zip), member: MEMBER });
export const sourceFields = { source: SOURCE, source_commit: COMMIT, source_file: 'tables/GemEffects.json', source_sha256: sha256(DICTIONARY) };

// A retained publication generated for 9.8 whose catalog equals 9.9's.
export function retained({ meta = {}, manifest = {}, entries = ENTRIES } = {}) {
  const assetRaw = bytes({ _meta: { ...sourceFields, data_version: '9.8', catalog_sha256: CATALOG_SHA, regen_command: 'old', ...meta },
    entries, untranslated: UNTRANSLATED });
  const manifestRaw = bytes({ schema: 'poe2-support-display-publication/v1', target: { game: 'poe2', version: '9.9', realm: 'international' },
    locale: 'zh-CN', catalog_sha256: CATALOG_SHA, files: { [DISPLAY_ASSET]: pin(assetRaw) },
    provenance: { kind: 'retained-generated-asset', generation_data_version: '9.8', ...sourceFields }, ...manifest });
  return { assetRaw, manifestRaw };
}

export const retainedSpec = (files, revision, extra = {}) => ({ mode: 'retained', catalog_sha256: CATALOG_SHA,
  manifest: { path: `${DISPLAY_DIR}/manifest.json`, ...pin(files.manifestRaw) }, asset: pin(files.assetRaw),
  origin: { repository: 'ackness/poe2-zh-cn-stats', tag: 'handoff/display-test', revision }, ...extra });

// release/9.9.json declaring `display`; the locale source's origin is the fixture's first commit.
export function releaseConfig(repo, manifestRaw, extra) {
  const declared = config(manifestRaw, extra);
  const revision = gitIn(repo, 'rev-list', '--max-parents=0', 'HEAD');
  return bytes({ ...declared, source: { ...declared.source, origin: { ...declared.source.origin, revision } } });
}
export function writeConfig(repo, manifestRaw, display) {
  write(repo, 'release/9.9.json', releaseConfig(repo, manifestRaw, display ? { support_display: display } : {}));
}

// Commit a retained display into the fixture checkout and declare it in release/9.9.json.
export function addRetainedDisplay({ repo, manifestRaw }, { files = retained(), extra = {}, published } = {}) {
  write(repo, `${DISPLAY_DIR}/manifest.json`, files.manifestRaw);
  write(repo, `${DISPLAY_DIR}/${DISPLAY_ASSET}`, files.assetRaw);
  write(repo, `${DISPLAY_DIR}/README.md`, 'retained\n');
  const origin = commitAll(repo, 'retained display');
  const spec = retainedSpec(files, origin, extra);
  write(repo, 'release/9.9.json', releaseConfig(repo, manifestRaw, { support_display: spec, ...(published ? { published } : {}) }));
  commitAll(repo, 'declare the display');
  return { files, spec, origin };
}
