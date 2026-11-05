// The zh-CN support display of a language Release: PoBR's support gem descriptions
// (supportDescriptions.zh-CN.json) and its publication manifest (support-display.zh-CN.json,
// poe2-support-display-publication/v1). Both are extra assets of locale/<patch>-<n>, listed in its
// SHA256SUMS and pinned in receipt.json's `support_display`; neither is a zip member, so declaring
// a display never changes pobr-locale-<patch>.zip. The display binds to one trade catalog (SHA-256
// of the game package member data/<patch>/overlay/trade_catalog.json): PoBR's data:bump refuses it
// for a game package that carries another catalog.
//
// A release config declares it in `support_display`, in one of two modes:
// - retained: a checked-in directory (manifest.json + the asset, optionally README.md) restored byte
//   for byte from its origin commit; `--check` compares its tree with that commit's.
// - regenerate: src/support-description-projection.mjs over two pinned downloads, the GemEffects
//   dictionary and the game Release's package (its trade catalog member); `_meta` and the manifest
//   are written deterministically from those pins and the target.
// Both modes pin the two output files and the catalog SHA-256. A retained display may also declare
// the inputs it was generated from (`dictionary`, `catalog`); `--check` then regenerates its entries
// from them and requires the same entries and untranslated IDs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { strictJson } from './strict-json.mjs';
import { readZip } from './stored-zip.mjs';
import { supportDescriptions } from './support-description-projection.mjs';
import {
  REPOSITORY, download, encoded, git, isPin, listFiles, pin, readRegular, releaseUrl, require, safeRelative, samePin,
} from './locale-release.mjs';

export const LOCALE = 'zh-CN';
export const DISPLAY_ASSET = `supportDescriptions.${LOCALE}.json`;
export const MANIFEST_ASSET = `support-display.${LOCALE}.json`;
export const DISPLAY_SCHEMA = 'poe2-support-display-publication/v1';
export const CATALOG_REPOSITORY = 'ackness/repoe';
export const MODES = ['retained', 'regenerate'];
export const INPUT_CACHE = '.cache/release/inputs';
// The `_meta` fields PoBR compares with the manifest's provenance.
const SOURCE_FIELDS = ['source', 'source_commit', 'source_file', 'source_sha256'];
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const GITHUB = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value, allowed, label) => require(object(value) && Object.keys(value).every(key => allowed.includes(key)),
  `${label}: unknown fields (allowed: ${allowed})`);
const pinOf = value => ({ bytes: value.bytes, sha256: value.sha256 });
const show = value => `${value.bytes} bytes, sha256 ${value.sha256}`;

export const catalogMember = patch => `data/${patch}/overlay/trade_catalog.json`;
export const manifestTarget = target => ({ game: target.game, version: target.game_patch, realm: target.realm });

// --- configuration -------------------------------------------------------------------------------

function validateDictionary(value, label) {
  keysOnly(value, ['source', 'source_commit', 'source_file', 'url', 'bytes', 'sha256'], label);
  const repository = GITHUB.exec(value.source ?? '')?.[1];
  require(repository && HEX40.test(value.source_commit ?? '') && isPin(value), `${label}: needs source (https://github.com/<owner>/<repo>), `
    + 'the full source_commit and the file pin');
  safeRelative(value.source_file);
  const prefix = `https://raw.githubusercontent.com/${repository}/${value.source_commit}/`;
  require(typeof value.url === 'string' && value.url.startsWith(prefix) && value.url.endsWith(`/${value.source_file}`)
    && safeRelative(value.url.slice(prefix.length)), `${label}: url must be ${prefix}<path ending in /${value.source_file}>`);
}

function validateCatalog(value, target, label) {
  keysOnly(value, ['repository', 'tag', 'asset', 'bytes', 'sha256', 'member'], label);
  const patch = target.game_patch;
  require(value.repository === CATALOG_REPOSITORY && typeof value.tag === 'string'
    && new RegExp(`^game/${patch.replaceAll('.', '\\.')}-[1-9][0-9]*$`, 'u').test(value.tag)
    && value.asset === `pobr-game-${patch}.zip` && value.member === catalogMember(patch) && isPin(value),
  `${label}: needs ${CATALOG_REPOSITORY}'s Release game/${patch}-<n>, its asset pobr-game-${patch}.zip (bytes, sha256) `
    + `and member ${catalogMember(patch)}`);
}

// Throws unless `spec` is a valid support_display section for `target`.
export function validateSupportDisplay(spec, target) {
  const label = 'support_display';
  require(object(spec) && MODES.includes(spec.mode), `${label}.mode must be one of ${MODES}`);
  require(HEX64.test(spec.catalog_sha256 ?? ''), `${label}.catalog_sha256 must be a SHA-256`);
  if (spec.dictionary !== undefined) validateDictionary(spec.dictionary, `${label}.dictionary`);
  if (spec.catalog !== undefined) validateCatalog(spec.catalog, target, `${label}.catalog`);
  require((spec.dictionary === undefined) === (spec.catalog === undefined), `${label}: declare dictionary and catalog together`);
  if (spec.mode === 'retained') {
    keysOnly(spec, ['mode', 'catalog_sha256', 'manifest', 'asset', 'origin', 'dictionary', 'catalog'], label);
    keysOnly(spec.manifest, ['path', 'bytes', 'sha256'], `${label}.manifest`);
    safeRelative(spec.manifest.path);
    require(spec.manifest.path.endsWith('/manifest.json') && isPin(spec.manifest), `${label}.manifest needs {path …/manifest.json, bytes, sha256}`);
    keysOnly(spec.asset, ['bytes', 'sha256'], `${label}.asset`);
    require(isPin(spec.asset), `${label}.asset needs {bytes, sha256} (the file is ${DISPLAY_ASSET} beside the manifest)`);
    const { origin } = spec;
    keysOnly(origin, ['repository', 'tag', 'revision', 'path'], `${label}.origin`);
    require(origin.repository === REPOSITORY && typeof origin.tag === 'string' && origin.tag && HEX40.test(origin.revision ?? ''),
      `${label}.origin needs this repository, its tag and the full revision`);
    require(origin.path === undefined || (safeRelative(origin.path) && origin.path.endsWith('/manifest.json')),
      `${label}.origin.path must name the manifest at the origin revision`);
  } else {
    keysOnly(spec, ['mode', 'catalog_sha256', 'dictionary', 'catalog', 'applicability', 'manifest', 'asset'], label);
    require(spec.dictionary && spec.catalog, `${label}: regenerate needs the dictionary and catalog inputs`);
    require(spec.applicability === undefined || (typeof spec.applicability === 'string' && spec.applicability.trim()),
      `${label}.applicability must be a sentence`);
    for (const key of ['manifest', 'asset']) {
      keysOnly(spec[key], ['bytes', 'sha256'], `${label}.${key}`);
      require(isPin(spec[key]), `${label}.${key} pins the generated file {bytes, sha256}`);
    }
  }
}

// --- inputs --------------------------------------------------------------------------------------

// Downloads the display declares: [{name, url, pin}].
export function displayInputs(spec) {
  if (!spec?.dictionary) return [];
  return [
    { name: 'dictionary', url: spec.dictionary.url, pin: pinOf(spec.dictionary) },
    { name: 'catalog', url: releaseUrl(spec.catalog.repository, spec.catalog.tag, spec.catalog.asset), pin: pinOf(spec.catalog) },
  ];
}

const cacheDirectory = (repo, cache) => cache ?? path.join(repo, INPUT_CACHE);

// A pinned download from the content cache (<cache>/<sha256>); offline.
export function cachedInput(repo, input, cache) {
  const file = path.join(cacheDirectory(repo, cache), input.pin.sha256);
  const raw = existsSync(file) ? readFileSync(file) : null;
  require(raw, `support_display.${input.name}: ${input.url} is not cached under ${INPUT_CACHE} (run release:build with --fetch)`);
  require(samePin(pin(raw), input.pin), `support_display.${input.name}: the cached ${file} differs from its pin`);
  return raw;
}

// Download the display's missing inputs into the cache; each must match its pin.
export async function fetchDisplayInputs(repo, spec, { cache, fetcher = download } = {}) {
  const directory = cacheDirectory(repo, cache);
  for (const input of displayInputs(spec)) {
    const file = path.join(directory, input.pin.sha256);
    if (existsSync(file) && samePin(pin(readFileSync(file)), input.pin)) continue;
    const raw = await fetcher(input.url);
    require(samePin(pin(raw), input.pin), `support_display.${input.name}: ${input.url} is ${show(pin(raw))}, `
      + `the config pins ${show(input.pin)}`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, raw);
  }
}

// The trade catalog member of the pinned game package; it must hash to `catalog_sha256`.
export function catalogBytes(zip, spec) {
  const members = readZip(zip);
  const raw = members.get(spec.catalog.member)?.raw;
  require(raw, `${spec.catalog.tag} ${spec.catalog.asset} has no ${spec.catalog.member}`);
  const listed = members.has('manifest.json') ? strictJson(members.get('manifest.json').raw).files?.[spec.catalog.member] : undefined;
  require(listed === undefined || samePin(pin(raw), listed), `${spec.catalog.asset}: ${spec.catalog.member} differs from its manifest.json pin`);
  require(pin(raw).sha256 === spec.catalog_sha256, `Catalog mismatch: ${spec.catalog.tag} ${spec.catalog.member} has SHA-256 `
    + `${pin(raw).sha256}, support_display.catalog_sha256 is ${spec.catalog_sha256}`);
  return raw;
}

// entries/untranslated of src/support-description-projection.mjs over the cached inputs.
export function project(repo, spec, cache) {
  const [dictionary, catalog] = displayInputs(spec).map(input => cachedInput(repo, input, cache));
  const { gems } = strictJson(catalogBytes(catalog, spec));
  require(Array.isArray(gems), `${spec.catalog.member} has no gems array`);
  return supportDescriptions(strictJson(dictionary), gems);
}

// --- the two files -------------------------------------------------------------------------------

function retainedFiles(repo, spec) {
  const directory = path.posix.dirname(spec.manifest.path);
  const manifestRaw = readRegular(repo, spec.manifest.path);
  require(samePin(pin(manifestRaw), spec.manifest), `Pin mismatch: ${spec.manifest.path} is ${show(pin(manifestRaw))}, `
    + `support_display.manifest pins ${show(spec.manifest)}`);
  const assetRaw = readRegular(repo, `${directory}/${DISPLAY_ASSET}`);
  require(samePin(pin(assetRaw), spec.asset), `Pin mismatch: ${directory}/${DISPLAY_ASSET} is ${show(pin(assetRaw))}, `
    + `support_display.asset pins ${show(spec.asset)}`);
  const unlisted = listFiles(path.join(repo, directory)).filter(name => !['README.md', 'manifest.json', DISPLAY_ASSET].includes(name));
  require(!unlisted.length, `Unlisted files in ${directory}: ${unlisted}`);
  return { directory, manifestRaw, assetRaw };
}

// The command that regenerates a display, as `_meta.regen_command` records it.
export const regenCommand = configPath => `mise run release:build -- --config ${configPath} --fetch`;

export function regeneratedFiles(repo, spec, target, configPath, cache) {
  const { entries, untranslated } = project(repo, spec, cache);
  const { dictionary, catalog } = spec;
  const source = { source: dictionary.source, source_commit: dictionary.source_commit, source_file: dictionary.source_file,
    source_sha256: dictionary.sha256 };
  const assetRaw = encoded({
    _meta: { ...source, data_version: target.game_patch, catalog_sha256: spec.catalog_sha256, regen_command: regenCommand(configPath) },
    entries, untranslated,
  });
  const manifestRaw = encoded({
    schema: DISPLAY_SCHEMA,
    target: manifestTarget(target),
    locale: LOCALE,
    catalog_sha256: spec.catalog_sha256,
    files: { [DISPLAY_ASSET]: pin(assetRaw) },
    provenance: { kind: 'generated-asset', generation_data_version: target.game_patch, ...source,
      catalog: { repository: catalog.repository, tag: catalog.tag, asset: catalog.asset, sha256: catalog.sha256, member: catalog.member } },
    ...(spec.applicability ? { applicability: spec.applicability } : {}),
  });
  // Both mismatches in one message: a new config takes its pins from it.
  const wrong = [['asset', DISPLAY_ASSET, assetRaw], ['manifest', MANIFEST_ASSET, manifestRaw]].filter(([key, , raw]) => !samePin(pin(raw), spec[key]));
  require(!wrong.length, wrong.map(([key, name, raw]) => `Pin mismatch: the regenerated ${name} is ${show(pin(raw))}, `
    + `support_display.${key} pins ${show(spec[key])}`).join('; '));
  return { manifestRaw, assetRaw };
}

// The manifest and asset must describe this target, catalog and each other, as PoBR checks them
// (pipeline/imports/display_assets.py check_manifest/check_asset), and the asset's dictionary
// commit must be the language package's (PoBR's web test compares it with i18n/zh-CN/_meta.json).
export function verifyDisplay(manifestRaw, assetRaw, spec, target, members) {
  const manifest = strictJson(manifestRaw), asset = strictJson(assetRaw);
  require(object(manifest) && manifest.schema === DISPLAY_SCHEMA && JSON.stringify(manifest.target) === JSON.stringify(manifestTarget(target))
    && manifest.locale === LOCALE, `${MANIFEST_ASSET}: expected ${DISPLAY_SCHEMA} for ${JSON.stringify(manifestTarget(target))} ${LOCALE}`);
  require(manifest.catalog_sha256 === spec.catalog_sha256, `Catalog mismatch: the manifest binds trade catalog ${manifest.catalog_sha256}, `
    + `support_display.catalog_sha256 is ${spec.catalog_sha256}`);
  require(object(manifest.files) && Object.keys(manifest.files).join() === DISPLAY_ASSET && samePin(manifest.files[DISPLAY_ASSET], pin(assetRaw)),
    `${MANIFEST_ASSET}: files must pin exactly ${DISPLAY_ASSET} (${show(pin(assetRaw))})`);
  const { provenance } = manifest;
  require(object(provenance) && typeof provenance.kind === 'string' && typeof provenance.generation_data_version === 'string'
    && SOURCE_FIELDS.every(key => typeof provenance[key] === 'string'), `${MANIFEST_ASSET}: provenance needs kind, generation_data_version and ${SOURCE_FIELDS}`);
  const meta = asset?._meta;
  require(object(asset) && object(meta) && object(asset.entries) && Array.isArray(asset.untranslated),
    `${DISPLAY_ASSET}: expected {_meta, entries, untranslated}`);
  require(meta.data_version === provenance.generation_data_version, `Provenance mismatch: _meta.data_version ${meta.data_version} `
    + `differs from provenance.generation_data_version ${provenance.generation_data_version}`);
  require(meta.catalog_sha256 === manifest.catalog_sha256, `Catalog mismatch: _meta.catalog_sha256 ${meta.catalog_sha256} differs from the manifest's`);
  const differs = SOURCE_FIELDS.filter(key => meta[key] !== provenance[key]);
  require(!differs.length, `Provenance mismatch: _meta ${differs} differ from the manifest's provenance`);
  if (spec.dictionary) {
    const declared = { source: spec.dictionary.source, source_commit: spec.dictionary.source_commit,
      source_file: spec.dictionary.source_file, source_sha256: spec.dictionary.sha256 };
    const other = SOURCE_FIELDS.filter(key => declared[key] !== provenance[key]);
    require(!other.length, `Provenance mismatch: support_display.dictionary ${other} differ from the manifest's provenance`);
  }
  const localeMeta = members.get(`data/${target.game_patch}/i18n/${LOCALE}/_meta.json`);
  require(localeMeta, `The language package has no i18n/${LOCALE}/_meta.json to bind the support display to`);
  const commit = strictJson(localeMeta).source_commit;
  require(commit === meta.source_commit, `Provenance mismatch: _meta.source_commit ${meta.source_commit} differs from `
    + `i18n/${LOCALE}/_meta.json source_commit ${commit} (PoBR requires the same dictionary commit)`);
  return { manifest, asset };
}

// The display a loaded config declares: {manifestRaw, assetRaw, receipt}, or null.
export function supportDisplay(repo, loaded, members, { cache } = {}) {
  const spec = loaded.config.support_display, { target } = loaded.config;
  if (!spec) return null;
  const files = spec.mode === 'retained' ? retainedFiles(repo, spec) : regeneratedFiles(repo, spec, target, loaded.display, cache);
  const { manifest, asset } = verifyDisplay(files.manifestRaw, files.assetRaw, spec, target, members);
  const inputs = spec.dictionary ? { dictionary: spec.dictionary, catalog: spec.catalog } : {};
  const receipt = {
    mode: spec.mode,
    locale: LOCALE,
    catalog_sha256: spec.catalog_sha256,
    generation_data_version: manifest.provenance.generation_data_version,
    manifest: { asset: MANIFEST_ASSET, ...pin(files.manifestRaw) },
    asset: { asset: DISPLAY_ASSET, ...pin(files.assetRaw) },
    counts: { entries: Object.keys(asset.entries).length, untranslated: asset.untranslated.length },
    source: spec.mode === 'retained'
      ? { manifest: { path: spec.manifest.path, ...pinOf(spec.manifest) },
        asset: { path: `${files.directory}/${DISPLAY_ASSET}`, ...pinOf(spec.asset) }, origin: spec.origin, ...inputs }
      : inputs,
  };
  return { manifestRaw: files.manifestRaw, assetRaw: files.assetRaw, receipt };
}

// --- checks --------------------------------------------------------------------------------------

// A retained directory's tree must equal its origin's; declared inputs must regenerate its entries.
export function displayProblems(repo, loaded, { cache } = {}) {
  const spec = loaded.config.support_display, problems = [];
  if (!spec) return problems;
  if (spec.mode === 'retained') {
    const directory = path.posix.dirname(spec.manifest.path);
    const originDirectory = path.posix.dirname(spec.origin.path ?? spec.manifest.path);
    const tree = (rev, dir) => git(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${dir}`]);
    const [origin, head] = [tree(spec.origin.revision, originDirectory), tree('HEAD', directory)];
    if (origin.status !== 0) problems.push(`support display origin ${spec.origin.revision} is not present locally (pass --fetch)`);
    else if (origin.stdout !== head.stdout) problems.push(`${directory} differs from ${originDirectory} at ${spec.origin.tag}`);
    if (spec.dictionary) {
      try {
        const { entries, untranslated } = project(repo, spec, cache);
        const asset = strictJson(readRegular(repo, `${directory}/${DISPLAY_ASSET}`));
        if (JSON.stringify(entries) !== JSON.stringify(asset.entries) || JSON.stringify(untranslated) !== JSON.stringify(asset.untranslated)) {
          problems.push(`the support display's entries do not regenerate from its declared dictionary and catalog`);
        }
      } catch (error) {
        problems.push(error.message);
      }
    }
  }
  return problems;
}

// The origin commit `release:build --fetch` fetches for a retained display (Git only), or null.
export function displayOrigin(spec) {
  return spec?.mode === 'retained' ? spec.origin : null;
}
