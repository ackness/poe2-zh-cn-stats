// release:build — package a committed language publication as PoBR's language
// part. Input: release/<patch>[-<n>].json. A v1 config pins a retained publication manifest
// (poe2-retained-locale-publication/v1) in this repository; a v2 config takes a v1 config's
// package as its base and applies declared member transforms (src/release/package.mjs). Output,
// under .cache/release/<game>-<realm>-<config name>/: pobr-locale-<patch>.zip (manifest.json
// plus every i18n/* member as data/<patch>/i18n/*) and receipt.json (producer commit, every
// source pin, the transforms, the package pins and a language index). The zip is a function of
// the pinned source bytes, the transforms and the target only, so any later clean commit with
// the same inputs reproduces it byte for byte. A config may also declare a support display
// (`support_display`, src/release/support-display.mjs): support-display.zh-CN.json and
// supportDescriptions.zh-CN.json are written beside the zip, listed in SHA256SUMS and pinned in the
// receipt, and never change the zip. release:regenerate (src/release/regenerate.mjs)
// separately rebuilds a v1 source's members from their producers' pinned inputs.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { strictJson } from '../strict-json.mjs';
import { readZip, storedZip } from './stored-zip.mjs';
import { applyTransforms, localeIndex, validateTransforms } from './package.mjs';
import {
  DISPLAY_ASSET, MANIFEST_ASSET, displayOrigin, displayProblems, fetchDisplayInputs, supportDisplay, validateSupportDisplay,
} from './support-display.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const REPOSITORY = 'ackness/poe2-zh-cn-stats';
export const CONFIG_SCHEMA = 'poe2-locale-release-config/v1';
export const CONFIG_SCHEMA_V2 = 'poe2-locale-release-config/v2';
export const RECEIPT_SCHEMA = 'poe2-locale-release-receipt/v1';
export const SOURCE_SCHEMA = 'poe2-retained-locale-publication/v1';
export const PART_SCHEMA = 'pobr-build-data-part/v1';
const MARKER = '.release-build';
// Pinned in the receipt; the commit identifies them too, the pins make a receipt self-describing.
export const CODE = ['src/release/build.mjs', 'src/release/package.mjs', 'src/release/support-display.mjs',
  'src/release/support-description-projection.mjs', 'src/release/stored-zip.mjs', 'src/strict-json.mjs', 'mise.lock'];
// Untracked files here could change the build, so they make the producer dirty.
export const PRODUCER_PATHS = ['src', 'release', 'inputs', 'package.json', 'package-lock.json', 'mise.toml', 'mise.lock'];
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const PATCH = /^[0-9]+(?:\.[0-9]+)+$/u;
// release/<patch>.json, or release/<patch>-<n>.json for a package meant to be published as locale/<patch>-<n>.
const CONFIG_NAME = /^([0-9]+(?:\.[0-9]+)+)(?:-([1-9][0-9]*))?$/u;

export function require(condition, message) {
  if (!condition) throw new Error(message);
}

export const sha256 = raw => createHash('sha256').update(raw).digest('hex');
export const pin = raw => ({ bytes: raw.length, sha256: sha256(raw) });
export const samePin = (a, b) => a?.bytes === b?.bytes && a?.sha256 === b?.sha256;
// PoBR's JSON layout: insertion order, two-space indent, final newline.
export const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const assetName = patch => `pobr-locale-${patch}.zip`;
export const targetName = target => `${target.game}-${target.realm}-${target.game_patch}`;
export const log = (task, message) => process.stderr.write(`${task}: ${message}\n`);

export function sha256sums(digests) {
  return Object.keys(digests).sort().map(name => `${digests[name]}  ${name}\n`).join('');
}

export function safeRelative(name) {
  require(typeof name === 'string' && name && !name.includes('\\') && !name.includes(':')
    && !name.split('/').some(part => part === '' || part === '.' || part === '..'), `Unsafe path: ${JSON.stringify(name)}`);
  return name;
}

// A regular file inside the repository, never through a symlink.
export function readRegular(repo, relative) {
  let at = repo;
  for (const part of safeRelative(relative).split('/')) {
    at = path.join(at, part);
    require(!lstatSync(at).isSymbolicLink(), `Symlink in input path: ${relative}`);
  }
  require(lstatSync(at).isFile(), `Not a regular file: ${relative}`);
  return readFileSync(at);
}

export function isPin(value) {
  return value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && HEX64.test(value.sha256 ?? '');
}

// --- configuration -------------------------------------------------------------------------------

const patchKey = name => {
  const [, patch, sequence] = CONFIG_NAME.exec(name);
  return [...patch.split('.').map(Number), -1, Number(sequence ?? 0)];
};
function comparePatches(a, b) {
  const [x, y] = [patchKey(a), patchKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}

// The highest release/<patch>[-<n>].json that is not on hold: patches compared numerically, then
// <n> (none first). A held config is built and checked only when named with --config.
export function defaultConfig(repo = ROOT) {
  const names = readdirSync(path.join(repo, 'release')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const invalid = names.filter(name => !CONFIG_NAME.test(name));
  require(!invalid.length, `Release declarations must be named <game patch>[-<n>]: ${invalid}`);
  const active = names.filter(name => strictJson(readFileSync(path.join(repo, 'release', `${name}.json`))).hold === undefined);
  require(active.length, 'No release declaration (not on hold) under release/; pass --config');
  return path.join(repo, 'release', `${active.sort(comparePatches).at(-1)}.json`);
}

// The <n> a release/<patch>-<n>.json declares, or null.
export function configSequence(loaded) {
  const match = CONFIG_NAME.exec(path.basename(loaded.file, '.json'));
  return match?.[2] ? Number(match[2]) : null;
}

// Every locale tag has one config name; the first retained publication predates numbered configs.
export function configForTag(tag) {
  require(/^locale\/[0-9]+(?:\.[0-9]+)+-[1-9][0-9]*$/u.test(tag), `Invalid locale tag: ${tag}`);
  return tag === 'locale/0.5.5.5-1' ? 'release/0.5.5.5.json' : `release/${tag.slice('locale/'.length)}.json`;
}

const pinFields = ({ bytes, sha256 }) => ({ bytes, sha256 });

export function assertExpectedPackage(config, actual) {
  if (config.expect) require(samePin(actual, config.expect.package),
    `the package differs from expect.package: expected ${JSON.stringify(config.expect.package)}; built ${JSON.stringify(pinFields(actual))}`);
}

// The build directory name: <game>-<realm>-<config name> under release/, else <game>-<realm>-<patch>.
export function buildName(loaded) {
  const { target } = loaded.config;
  const name = path.basename(loaded.file, '.json');
  return loaded.underRelease ? `${target.game}-${target.realm}-${name}` : targetName(target);
}

export function loadConfig(file, repo = ROOT) {
  file = path.resolve(file);
  const raw = readFileSync(file);
  const config = strictJson(raw);
  require([CONFIG_SCHEMA, CONFIG_SCHEMA_V2].includes(config.schema), `${file}: expected schema ${CONFIG_SCHEMA} or ${CONFIG_SCHEMA_V2}`);
  const { target, published } = config;
  require(target && Object.keys(target).sort().join() === 'game,game_patch,realm' && target.game === 'poe2'
    && PATCH.test(target.game_patch ?? '') && ['international', 'china'].includes(target.realm), 'Invalid release target');
  const underRelease = path.dirname(file) === path.join(repo, 'release');
  const name = CONFIG_NAME.exec(path.basename(file, '.json'));
  require(!underRelease || (path.basename(file).endsWith('.json') && name?.[1] === target.game_patch),
    `${path.basename(file)} declares game patch ${target.game_patch}`);
  require(published === undefined || (typeof published.tag === 'string'
    && published.tag.startsWith(`locale/${target.game_patch}-`) && /^[1-9][0-9]*$/u.test(published.tag.slice(`locale/${target.game_patch}-`.length))
    && published.asset === assetName(target.game_patch) && isPin(published)), 'Invalid published package pin');
  require(config.hold === undefined || (typeof config.hold === 'string' && config.hold.trim()), 'hold must be a reason');
  const relative = path.relative(repo, file);
  const loaded = { file, raw, config, underRelease, display: relative.startsWith('..') ? file : relative.split(path.sep).join('/') };
  if (published && underRelease) {
    const mapped = configForTag(published.tag);
    require(loaded.display === mapped, `${loaded.display}: published.tag ${published.tag} maps to ${mapped}`);
  }
  if (config.expect !== undefined) require(isPin(config.expect?.package), 'expect.package must pin {bytes, sha256}');
  // The support display is the config's own; a v2 config does not inherit its base's.
  if (config.support_display !== undefined) {
    validateSupportDisplay(config.support_display, target);
    // A regenerated `_meta.regen_command` names the config, so it must not depend on the machine.
    require(config.support_display.mode !== 'regenerate' || underRelease, 'A regenerated support display needs a config under release/');
  }
  if (config.schema === CONFIG_SCHEMA_V2) {
    const keys = ['schema', 'target', 'base', 'transforms', 'expect', 'hold', 'published', 'support_display'];
    require(Object.keys(config).every(key => keys.includes(key)), `${file}: unknown fields (v2 allows ${keys})`);
    require(typeof config.base?.config === 'string' && Object.keys(config.base).join() === 'config', 'base must name {config}');
    const baseFile = path.join(repo, safeRelative(config.base.config));
    require(strictJson(readFileSync(baseFile)).schema === CONFIG_SCHEMA, 'The base must be a v1 config under release/');
    const base = loadConfig(baseFile, repo);
    require(base.config.schema === CONFIG_SCHEMA && base.underRelease, 'The base must be a v1 config under release/');
    require(JSON.stringify(base.config.target) === JSON.stringify(target), 'The base targets another game patch or realm');
    validateTransforms(config.transforms);
    require(isPin(config.expect?.package), 'A v2 config pins its intended package in expect.package {bytes, sha256}');
    return { ...loaded, base };
  }
  const keys = ['schema', 'target', 'source', 'expect', 'hold', 'published', 'support_display'];
  require(Object.keys(config).every(key => keys.includes(key)), `${file}: unknown fields (v1 allows ${keys})`);
  const { source } = config;
  safeRelative(source?.manifest?.path);
  require(source.manifest.path.endsWith('/manifest.json') && isPin(source.manifest), 'Invalid source manifest pin');
  const origin = source.origin;
  require(origin?.repository === REPOSITORY && typeof origin.tag === 'string' && HEX40.test(origin.revision ?? ''),
    'The source origin needs this repository, its tag and the full revision');
  require(origin.path === undefined || (safeRelative(origin.path) && origin.path.endsWith('/manifest.json')),
    'The source origin path must name the manifest at the origin revision');
  return loaded;
}

// --- Git -----------------------------------------------------------------------------------------

// Offline calls must not lazily fetch missing objects of a partial clone.
// Online calls never wait on a credential prompt.
export function git(repo, args, { online = false, timeout } = {}) {
  const env = online ? { ...process.env, GIT_TERMINAL_PROMPT: '0' } : { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  const result = spawnSync('git', ['--no-replace-objects', '-C', repo, ...args], { env, maxBuffer: 1 << 26, timeout });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout.toString(), stderr: result.stderr.toString().trim() };
}

function gitOut(repo, args) {
  const result = git(repo, args);
  require(result.status === 0, `git ${args.slice(0, 3).join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function statusPaths(output) {
  return output.split('\0').filter(Boolean).map(entry => entry.slice(3));
}

// Dirty on any tracked change, or an untracked file under the build's inputs.
export function producerIdentity(repo, loaded) {
  const commit = gitOut(repo, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const tracked = statusPaths(gitOut(repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no']));
  const inputs = statusPaths(gitOut(repo, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all',
    '--', ...PRODUCER_PATHS]));
  const dirty = [...new Set([...tracked, ...inputs])].sort();
  return {
    repository: REPOSITORY,
    commit,
    dirty: dirty.length > 0,
    dirty_paths: dirty,
    config: Object.fromEntries([loaded, loaded.base].filter(Boolean).map(item => [item.display, pin(item.raw)])),
    code: Object.fromEntries(CODE.map(name => [name, pin(readRegular(repo, name))])),
  };
}

// --- source --------------------------------------------------------------------------------------

export function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = prefix + entry.name;
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), `${name}/`);
    require(entry.isFile(), `Not a regular file in the source publication: ${name}`);
    return [name];
  });
}

// The pinned publication: manifest, then every listed file, each against its pin.
export function readSource(repo, config) {
  const manifestPath = config.source.manifest.path;
  const manifestRaw = readRegular(repo, manifestPath);
  require(samePin(pin(manifestRaw), config.source.manifest), `${manifestPath} differs from its pin in the release config`);
  const manifest = strictJson(manifestRaw);
  require(manifest.schema === SOURCE_SCHEMA, `${manifestPath}: expected schema ${SOURCE_SCHEMA}`);
  require(JSON.stringify(manifest.target) === JSON.stringify(config.target), `${manifestPath}: target differs from the release config`);
  const directory = path.posix.dirname(manifestPath);
  const files = new Map();
  for (const [name, expected] of Object.entries(manifest.files)) {
    require(/^(?:i18n|evidence)\/.+\.json$/u.test(safeRelative(name)) && isPin(expected), `Invalid source member: ${name}`);
    const raw = readRegular(repo, `${directory}/${name}`);
    require(samePin(pin(raw), expected), `${directory}/${name} differs from its pin in ${manifestPath}`);
    files.set(name, raw);
  }
  // Nothing beside the publication: its manifest, its README and the listed files.
  const present = listFiles(path.join(repo, directory)).sort();
  const expected = ['README.md', 'manifest.json', ...files.keys()].sort();
  const unlisted = present.filter(name => !expected.includes(name) && name !== 'README.md');
  require(!unlisted.length, `Unlisted files in ${directory}: ${unlisted}`);
  return { directory, manifestRaw, manifest, files };
}

// --- package -------------------------------------------------------------------------------------

// Where the source manifest lives at its origin revision: `source.origin.path` when the directory
// was moved after that commit (its tree must be unchanged), otherwise `source.manifest.path`.
// The package records this path, so moving the directory does not change the package bytes.
export function originManifestPath(config) {
  return config.source.origin.path ?? config.source.manifest.path;
}

// The part manifest's `source`: the publication a v1 package copies (a v2 package adds its transforms).
export function publicationSource(source) {
  return { repository: REPOSITORY, publication: { path: source.path, bytes: source.bytes, sha256: source.sha256 } };
}

export function partManifest(target, source, files) {
  return {
    schema: PART_SCHEMA,
    kind: 'language',
    target,
    source: source.repository ? source : publicationSource(source),
    files: Object.fromEntries([...files.keys()].sort().map(name => [name, pin(files.get(name))])),
  };
}

// The package members of a source publication: data/<patch>/i18n/<lang>/<file>.json.
export function packageMembers(target, source) {
  const members = new Map(), origins = {};
  for (const [name, raw] of [...source.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!name.startsWith('i18n/')) continue;
    require(name.split('/').length >= 3, `Invalid language member: ${name}`);
    const value = strictJson(raw);
    // Check document headers and their explicit target envelopes. Nested source provenance keeps
    // the real source patch, including official text carried from an older client.
    for (const [location, identity] of [[name, value], [`${name}._meta`, value?._meta],
      [`${name}.target`, value?.target], [`${name}._meta.target`, value?._meta?.target]]) {
      if (identity && Object.hasOwn(identity, 'game_patch')) require(identity.game_patch === target.game_patch,
        `${location}: game_patch ${JSON.stringify(identity.game_patch)} differs from target ${JSON.stringify(target.game_patch)}`);
    }
    const member = `data/${target.game_patch}/${name}`;
    members.set(member, raw);
    origins[member] = `${source.directory}/${name}`;
  }
  require(members.size, 'The source publication has no i18n files');
  return { members, origins };
}

function outputDirectory(repo, out, loaded) {
  out = path.resolve(out ?? path.join(repo, '.cache/release', buildName(loaded)));
  const inside = !path.relative(repo, out).startsWith('..');
  require(!inside || !path.relative(path.join(repo, '.cache'), out).startsWith('..'), 'Output must be under .cache/');
  return out;
}

// The stored zip of `members` (data/<patch>/i18n/* -> bytes) and its part manifest.
export function packageArchive(target, source, members) {
  const manifestRaw = encoded(partManifest(target, source, members));
  const zip = storedZip(new Map([...members, ['manifest.json', manifestRaw]]));
  // The archive must read back as exactly these members and bytes.
  const read = readZip(zip);
  require(read.size === members.size + 1 && [...members].every(([name, raw]) => read.get(name)?.raw.equals(raw))
    && read.get('manifest.json')?.raw.equals(manifestRaw), 'The written archive does not read back');
  return { zip, manifestRaw, expanded: [...read.values()].reduce((sum, entry) => sum + entry.raw.length, 0) };
}

// What a loaded config packages: members (data/<patch>/i18n/* -> bytes), each member's origin,
// the part manifest's source and the receipt's source section.
export function packageOf(repo, loaded) {
  const { config } = loaded, { target } = config;
  if (!loaded.base) {
    const source = readSource(repo, config);
    const { members, origins } = packageMembers(target, source);
    return {
      members, origins, source,
      partSource: publicationSource({ ...config.source.manifest, path: originManifestPath(config) }),
      receiptSource: {
        manifest: { ...config.source.manifest, schema: SOURCE_SCHEMA },
        origin: config.source.origin,
        files: Object.fromEntries([...source.files.keys()].sort()
          .map(name => [`${source.directory}/${name}`, pin(source.files.get(name))])),
      },
    };
  }
  const base = packageOf(repo, loaded.base);
  const prefix = `data/${target.game_patch}/`;
  const i18n = new Map([...base.members].map(([name, raw]) => [name.slice(prefix.length), raw]));
  const evidence = new Map([...base.source.files].filter(([name]) => name.startsWith('evidence/')));
  const { members: transformed, reports } = applyTransforms(config.transforms, i18n, evidence);
  const { members, origins } = packageMembers(target, { ...base.source, files: transformed });
  for (const transform of config.transforms) origins[prefix + transform.member] = `transform:${transform.id}`;
  return {
    members, origins, source: base.source,
    partSource: { ...base.partSource, transforms: config.transforms.map(({ id, kind, member }) => ({ id, kind, member })) },
    receiptSource: { base: { config: { path: loaded.base.display, ...pin(loaded.base.raw) }, ...base.receiptSource }, transforms: reports },
  };
}

export function build({ repo = ROOT, config: configFile, out, cache } = {}) {
  repo = path.resolve(repo);
  const loaded = loadConfig(configFile ?? defaultConfig(repo), repo);
  const { config } = loaded, { target } = config;
  out = outputDirectory(repo, out, loaded);
  const { members, origins, partSource, receiptSource } = packageOf(repo, loaded);
  const { zip, manifestRaw, expanded } = packageArchive(target, partSource, members);
  const asset = assetName(target.game_patch);
  const prefix = `data/${target.game_patch}/`;
  // Release assets beside the zip, never members of it.
  const display = supportDisplay(repo, loaded, members, { cache });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    target,
    producer: producerIdentity(repo, loaded),
    source: receiptSource,
    package: {
      asset,
      ...pin(zip),
      expanded_bytes: expanded,
      manifest: pin(manifestRaw),
      members: origins,
      // Not a package member: PoBR rejects data/<patch>/i18n/* files the game snapshot does not list.
      index: localeIndex(new Map([...members].map(([name, raw]) => [name.slice(prefix.length), raw]))),
    },
    ...(display ? { support_display: display.receipt } : {}),
  };
  const receiptRaw = encoded(receipt);
  if (existsSync(out)) {
    require(existsSync(path.join(out, MARKER)), `Refusing to replace a non-release directory: ${out}`);
    rmSync(out, { recursive: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, MARKER), 'generated by src/release/build.mjs\n');
  writeFileSync(path.join(out, asset), zip);
  writeFileSync(path.join(out, 'receipt.json'), receiptRaw);
  writeFileSync(path.join(out, 'manifest.json'), manifestRaw);
  const digests = { [asset]: sha256(zip), 'receipt.json': sha256(receiptRaw) };
  if (display) {
    writeFileSync(path.join(out, MANIFEST_ASSET), display.manifestRaw);
    writeFileSync(path.join(out, DISPLAY_ASSET), display.assetRaw);
    Object.assign(digests, { [MANIFEST_ASSET]: sha256(display.manifestRaw), [DISPLAY_ASSET]: sha256(display.assetRaw) });
  }
  writeFileSync(path.join(out, 'SHA256SUMS'), sha256sums(digests));
  // Keep the receipt available to copy the actual pin even when an expectation is stale.
  assertExpectedPackage(config, receipt.package);
  return { out, loaded, receipt, receiptRaw, zip, asset, display };
}

// --- checks --------------------------------------------------------------------------------------

// Fetch the origin commit when it is missing (Git only; used by CI's shallow checkout).
export function fetchOrigin(repo, origin) {
  if (git(repo, ['cat-file', '-e', `${origin.revision}^{commit}`]).status === 0) return;
  const result = git(repo, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', origin.revision], { online: true });
  require(result.status === 0, `Cannot fetch origin revision ${origin.revision}: ${result.stderr}`);
}

// Offline reproducibility claims of a clean build; returns the list of failures.
export function check(repo, built, { cache } = {}) {
  const { config } = built.loaded, { receipt } = built;
  const problems = [];
  if (receipt.producer.dirty) problems.push(`the checkout is dirty: ${receipt.producer.dirty_paths.slice(0, 5)}`);
  problems.push(...sourceProblems(repo, built.loaded.base ?? built.loaded));
  problems.push(...displayProblems(repo, built.loaded, { cache }));
  if (config.published && !samePin(receipt.package, config.published)) {
    problems.push(`the package differs from the published ${config.published.tag} (${config.published.sha256})`);
  }
  return problems;
}

// A v1 source directory must have the tree it had at its origin revision.
function sourceProblems(repo, loaded) {
  const { config } = loaded, problems = [];
  const directory = path.posix.dirname(config.source.manifest.path);
  const originDirectory = path.posix.dirname(originManifestPath(config));
  const tree = (rev, dir) => git(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${dir}`]);
  const [origin, head] = [tree(config.source.origin.revision, originDirectory), tree('HEAD', directory)];
  if (origin.status !== 0) problems.push(`origin ${config.source.origin.revision} is not present locally (pass --fetch)`);
  else if (origin.stdout !== head.stdout) problems.push(`${directory} differs from ${originDirectory} at ${config.source.origin.tag}`);
  return problems;
}

export function releaseUrl(repository, tag, asset, base = process.env.POBR_RELEASE_BASE_URL || 'https://github.com') {
  return `${base.replace(/\/+$/u, '')}/${repository}/releases/download/${encodeURI(tag)}/${encodeURIComponent(asset)}`;
}

// GET with retries on network errors, 429 and 5xx; other HTTP errors are answers.
export async function download(url, { fetchImpl = fetch, attempts = 3, backoff = 1000, sleep } = {}) {
  sleep ??= ms => new Promise(resolve => setTimeout(resolve, ms));
  for (let attempt = 1; ; attempt++) {
    let failure;
    try {
      const response = await fetchImpl(url, { headers: { 'user-agent': 'poe2-zh-cn-stats-release' } });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      require(response.status === 429 || response.status >= 500, `GET ${url}: HTTP ${response.status}`);
      failure = `HTTP ${response.status}`;
    } catch (error) {
      if (error.message.startsWith(`GET ${url}: HTTP`)) throw error;
      failure = error.message;
    }
    require(attempt < attempts, `GET ${url}: ${failure} after ${attempt} attempts`);
    await sleep(backoff * 2 ** (attempt - 1));
  }
}

// Verify a Release against its config pin; when rebuilt here, also compare the zip and support display.
async function checkReleaseAsset(loaded, built, tag, fetcher) {
  const { published, expect, target } = loaded.config;
  const expected = published ?? expect?.package;
  require(isPin(expected), `${loaded.display}: Release ${tag} requires published or expect.package`);
  const asset = assetName(target.game_patch);
  const sums = (await fetcher(releaseUrl(REPOSITORY, tag, 'SHA256SUMS'))).toString('utf8');
  require(sums.split('\n').includes(`${expected.sha256}  ${asset}`),
    `${tag} SHA256SUMS does not list ${asset} ${expected.sha256}`);
  const zip = await fetcher(releaseUrl(REPOSITORY, tag, asset));
  require(samePin(pin(zip), expected), `${tag} ${asset} differs from its ${published ? 'published' : 'expect.package'} pin: `
    + `expected ${JSON.stringify(pinFields(expected))}; downloaded ${JSON.stringify(pin(zip))}`);
  if (!built) return;
  require(zip.equals(built.zip), `${tag} ${asset} differs from the rebuilt package`);
  // A declared support display must be the Release's, as SHA256SUMS lists it; an undeclared one must not be listed.
  for (const [name, raw] of built.display ? [[MANIFEST_ASSET, built.display.manifestRaw], [DISPLAY_ASSET, built.display.assetRaw]] : []) {
    require(sums.split('\n').includes(`${sha256(raw)}  ${name}`), `${tag} SHA256SUMS does not list the rebuilt ${name} ${sha256(raw)}`);
  }
  const listed = [MANIFEST_ASSET, DISPLAY_ASSET].filter(name => sums.split('\n').some(line => line.endsWith(`  ${name}`)));
  require(built.display || !listed.length, `${tag} SHA256SUMS lists ${listed}, but the config declares no support display`);
}

export async function checkRelease(built, fetcher = download) {
  const tag = built.loaded.config.published?.tag ?? `locale/${path.basename(built.loaded.file, '.json')}`;
  await checkReleaseAsset(built.loaded, built, tag, fetcher);
}

export async function checkReleases(repo, built, tags, fetcher = download) {
  const problems = unpinnedTags(repo, tags);
  require(!problems.length, `check-release failed:\n${problems.map(p => `  - ${p}`).join('\n')}`);
  for (const tag of tags) {
    const file = path.join(repo, configForTag(tag));
    const loaded = path.resolve(built.loaded.file) === file ? built.loaded : loadConfig(file, repo);
    await checkReleaseAsset(loaded, loaded === built.loaded ? built : null, tag, fetcher);
  }
  return tags;
}

// The names of a remote's locale/* tags (`git ls-remote`, so it needs the network).
export function remoteLocaleTags(repo, remote = 'origin') {
  let result;
  try {
    result = git(repo, ['ls-remote', '--tags', '--refs', remote, 'refs/tags/locale/*'], { online: true, timeout: 60_000 });
  } catch (error) {
    throw new Error(`Cannot list ${remote}'s locale/* tags: ${error.message}`);
  }
  require(result.status === 0, `Cannot list ${remote}'s locale/* tags: ${result.stderr}`);
  return result.stdout.split('\n').filter(Boolean).map(line => line.split('\t')[1].replace(/^refs\/tags\//u, '')).sort();
}

// Tags map to config filenames. Legacy published pins must agree with that mapping and exist remotely;
// an expect-only config without a tag is an unpublished candidate. Returns the failures.
export function unpinnedTags(repo, tags) {
  const problems = [];
  for (const name of readdirSync(path.join(repo, 'release')).filter(file => file.endsWith('.json')).sort()) {
    const { published } = strictJson(readFileSync(path.join(repo, 'release', name)));
    if (!published) continue;
    const file = `release/${name}`;
    const mapped = configForTag(published.tag);
    if (file !== mapped) problems.push(`${file}: published.tag ${published.tag} maps to ${mapped}`);
    if (!tags.includes(published.tag)) problems.push(`${published.tag} is pinned by ${file}, but the remote has no such tag`);
  }
  for (const tag of tags) {
    const file = configForTag(tag);
    if (!existsSync(path.join(repo, file))) problems.push(`${tag} has no mapped config ${file}`);
  }
  return problems;
}

function displayReport(shown) {
  return [
    `support display (${shown.mode}, ${shown.locale}): ${shown.counts.entries} entries, ${shown.counts.untranslated} untranslated, `
      + `generated for ${shown.generation_data_version}, trade catalog ${shown.catalog_sha256}`,
    ...[shown.manifest, shown.asset].map(file => `  ${file.asset}: ${file.bytes} bytes sha256 ${file.sha256}`),
  ];
}

export function report(built) {
  const { receipt } = built, { package: pkg, producer } = receipt;
  const source = receipt.source.base ?? receipt.source;
  const sources = Object.keys(source.files);
  const languages = Object.entries(pkg.index.languages)
    .map(([lang, { fallback, tables }]) => `${lang} (${Object.keys(tables).length} tables${fallback.length ? `, fallback ${fallback}` : ''})`);
  return [
    `target: ${targetName(receipt.target)}`,
    `${receipt.source.base ? `base (${receipt.source.base.config.path})` : 'source'}: ${source.manifest.path} (${sources.length} files: `
      + `${sources.filter(n => n.includes('/i18n/')).length} i18n, ${sources.filter(n => n.includes('/evidence/')).length} evidence)`,
    ...(receipt.source.transforms ?? []).map(t => `transform ${t.id}: ${t.member} -> ${t.output.bytes} bytes sha256 ${t.output.sha256}`
      + (t.report.conflicts ? ` (${t.report.ids} ids -> ${t.report.english_keys} keys, ${t.report.conflicts.length} conflicts)` : '')),
    `languages: ${languages.join(', ')}`,
    `producer: ${producer.repository}@${producer.commit}${producer.dirty ? ` DIRTY (${producer.dirty_paths.length} paths)` : ''}`,
    `${pkg.asset}: ${pkg.bytes} bytes sha256 ${pkg.sha256}`,
    `  ${Object.keys(pkg.members).length} members + manifest.json (${pkg.manifest.sha256}), ${pkg.expanded_bytes} expanded bytes`,
    ...(receipt.support_display ? displayReport(receipt.support_display) : []),
    `receipt.json: ${built.receiptRaw.length} bytes sha256 ${sha256(built.receiptRaw)}`,
    `output: ${built.out}`,
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    config: { type: 'string' }, out: { type: 'string' }, fetch: { type: 'boolean' },
    check: { type: 'boolean' }, 'check-release': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('usage: release:build [--config release/<patch>[-<n>].json] [--out .cache/DIR] [--fetch] [--check] [--check-release]\n'
      + '  --fetch          fetch the source (and retained support display) origin commits from origin when missing,\n'
      + '                   and download the support display\'s pinned inputs into .cache/release/inputs\n'
      + '  --check          exit 1 unless the build is clean, the source equals its origin tag tree and\n'
      + '                   the zip equals the config\'s expected and published pins (when declared); a retained\n'
      + '                   support display must equal its origin tree and regenerate from its declared inputs\n'
      + '  --check-release  verify every locale/* Release against its mapped config\'s published or expect.package pin;\n'
      + '                   compare this build byte for byte when released, and require every published tag on origin');
    return;
  }
  if (values.fetch) {
    // Before the build: a regenerated support display needs its downloads.
    const loaded = loadConfig(values.config ?? defaultConfig(ROOT));
    fetchOrigin(ROOT, (loaded.base ?? loaded).config.source.origin);
    const origin = displayOrigin(loaded.config.support_display);
    if (origin) fetchOrigin(ROOT, origin);
    await fetchDisplayInputs(ROOT, loaded.config.support_display);
  }
  const built = build({ config: values.config, out: values.out });
  console.log(report(built));
  if (values.check) {
    const problems = check(ROOT, built);
    require(!problems.length, `check failed:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    const { expect, published } = built.loaded.config;
    const shown = built.loaded.config.support_display;
    console.log('check: clean build; source equals its origin tree' + (expect ? '; zip equals the expected pin' : '')
      + (published ? '; zip equals the published pin' : '')
      + (shown?.mode === 'retained' ? '; the support display equals its origin tree' : '')
      + (shown?.mode === 'retained' && shown.dictionary ? ' and its entries regenerate from its declared inputs' : ''));
  }
  if (values['check-release']) {
    const tags = remoteLocaleTags(ROOT);
    await checkReleases(ROOT, built, tags);
    console.log(`check-release: origin's ${tags.length} locale/* Releases match their mapped configs' pins; every published pin is on origin`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { log('release:build', error.message); process.exitCode = 1; });
}
