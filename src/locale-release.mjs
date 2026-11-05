// release:build — package a committed language publication as PoBR's language
// part. Input: release/<patch>.json, which pins a retained publication manifest
// (poe2-retained-locale-publication/v1) in this repository. Output, under
// .cache/release/<game>-<realm>-<patch>/: pobr-locale-<patch>.zip (manifest.json
// plus every i18n/* file of the publication as data/<patch>/i18n/*, bytes
// unchanged) and receipt.json (producer commit, every source pin, the package
// pins). The zip is a function of the pinned source bytes and the target only,
// so any later clean commit with the same inputs reproduces it byte for byte.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { strictJson } from './strict-json.mjs';
import { readZip, storedZip } from './stored-zip.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY = 'ackness/poe2-zh-cn-stats';
export const CONFIG_SCHEMA = 'poe2-locale-release-config/v1';
export const RECEIPT_SCHEMA = 'poe2-locale-release-receipt/v1';
export const SOURCE_SCHEMA = 'poe2-retained-locale-publication/v1';
export const PART_SCHEMA = 'pobr-build-data-part/v1';
const MARKER = '.release-build';
// Pinned in the receipt; the commit identifies them too, the pins make a receipt self-describing.
export const CODE = ['src/locale-release.mjs', 'src/stored-zip.mjs', 'src/strict-json.mjs', 'mise.lock'];
// Untracked files here could change the build, so they make the producer dirty.
export const PRODUCER_PATHS = ['src', 'release', 'inputs', 'package.json', 'package-lock.json', 'mise.toml', 'mise.lock'];
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const PATCH = /^[0-9]+(?:\.[0-9]+)+$/u;

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

function safeRelative(name) {
  require(typeof name === 'string' && name && !name.includes('\\') && !name.includes(':')
    && !name.split('/').some(part => part === '' || part === '.' || part === '..'), `Unsafe path: ${JSON.stringify(name)}`);
  return name;
}

// A regular file inside the repository, never through a symlink.
function readRegular(repo, relative) {
  let at = repo;
  for (const part of safeRelative(relative).split('/')) {
    at = path.join(at, part);
    require(!lstatSync(at).isSymbolicLink(), `Symlink in input path: ${relative}`);
  }
  require(lstatSync(at).isFile(), `Not a regular file: ${relative}`);
  return readFileSync(at);
}

function isPin(value) {
  return value && Number.isSafeInteger(value.bytes) && value.bytes >= 0 && HEX64.test(value.sha256 ?? '');
}

// --- configuration -------------------------------------------------------------------------------

const patchKey = name => name.split('.').map(Number);
function comparePatches(a, b) {
  const [x, y] = [patchKey(a), patchKey(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (x[i] ?? -1) - (y[i] ?? -1);
  return 0;
}

// The highest game patch release/<patch>.json (named by patch, compared numerically).
export function defaultConfig(repo = ROOT) {
  const names = readdirSync(path.join(repo, 'release')).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5));
  const invalid = names.filter(name => !PATCH.test(name));
  require(!invalid.length, `Release declarations must be named by game patch: ${invalid}`);
  require(names.length, 'No release declaration under release/; pass --config');
  return path.join(repo, 'release', `${names.sort(comparePatches).at(-1)}.json`);
}

export function loadConfig(file, repo = ROOT) {
  file = path.resolve(file);
  const raw = readFileSync(file);
  const config = strictJson(raw);
  require(config.schema === CONFIG_SCHEMA, `${file}: expected schema ${CONFIG_SCHEMA}`);
  const { target, source, published } = config;
  require(target && Object.keys(target).sort().join() === 'game,game_patch,realm' && target.game === 'poe2'
    && PATCH.test(target.game_patch ?? '') && ['international', 'china'].includes(target.realm), 'Invalid release target');
  require(path.dirname(file) !== path.join(repo, 'release') || path.basename(file) === `${target.game_patch}.json`,
    `${path.basename(file)} declares game patch ${target.game_patch}`);
  safeRelative(source?.manifest?.path);
  require(source.manifest.path.endsWith('/manifest.json') && isPin(source.manifest), 'Invalid source manifest pin');
  const origin = source.origin;
  require(origin?.repository === REPOSITORY && typeof origin.tag === 'string' && HEX40.test(origin.revision ?? ''),
    'The source origin needs this repository, its tag and the full revision');
  require(origin.path === undefined || (safeRelative(origin.path) && origin.path.endsWith('/manifest.json')),
    'The source origin path must name the manifest at the origin revision');
  require(published === undefined || (typeof published.tag === 'string'
    && published.tag.startsWith(`locale/${target.game_patch}-`) && /^[1-9][0-9]*$/u.test(published.tag.slice(`locale/${target.game_patch}-`.length))
    && published.asset === assetName(target.game_patch) && isPin(published)), 'Invalid published package pin');
  const relative = path.relative(repo, file);
  return { file, raw, config, display: relative.startsWith('..') ? file : relative.split(path.sep).join('/') };
}

// --- Git -----------------------------------------------------------------------------------------

// Offline calls must not lazily fetch missing objects of a partial clone.
export function git(repo, args, { online = false } = {}) {
  const env = online ? process.env : { ...process.env, GIT_NO_LAZY_FETCH: '1' };
  const result = spawnSync('git', ['--no-replace-objects', '-C', repo, ...args], { env, maxBuffer: 1 << 26 });
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
    config: { [loaded.display]: pin(loaded.raw) },
    code: Object.fromEntries(CODE.map(name => [name, pin(readRegular(repo, name))])),
  };
}

// --- source --------------------------------------------------------------------------------------

function listFiles(directory, prefix = '') {
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

export function partManifest(target, source, files) {
  return {
    schema: PART_SCHEMA,
    kind: 'language',
    target,
    source: { repository: REPOSITORY, publication: { path: source.path, bytes: source.bytes, sha256: source.sha256 } },
    files: Object.fromEntries([...files.keys()].sort().map(name => [name, pin(files.get(name))])),
  };
}

// The package members of a source publication: data/<patch>/i18n/<lang>/<file>.json.
export function packageMembers(target, source) {
  const members = new Map(), origins = {};
  for (const [name, raw] of [...source.files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!name.startsWith('i18n/')) continue;
    require(name.split('/').length >= 3, `Invalid language member: ${name}`);
    const member = `data/${target.game_patch}/${name}`;
    members.set(member, raw);
    origins[member] = `${source.directory}/${name}`;
  }
  require(members.size, 'The source publication has no i18n files');
  return { members, origins };
}

function outputDirectory(repo, out, target) {
  out = path.resolve(out ?? path.join(repo, '.cache/release', targetName(target)));
  const inside = !path.relative(repo, out).startsWith('..');
  require(!inside || !path.relative(path.join(repo, '.cache'), out).startsWith('..'), 'Output must be under .cache/');
  return out;
}

export function build({ repo = ROOT, config: configFile, out } = {}) {
  repo = path.resolve(repo);
  const loaded = loadConfig(configFile ?? defaultConfig(repo), repo);
  const { config } = loaded, { target } = config;
  out = outputDirectory(repo, out, target);
  const source = readSource(repo, config);
  const { members, origins } = packageMembers(target, source);
  const manifestRaw = encoded(partManifest(target, { ...config.source.manifest, path: originManifestPath(config) }, members));
  const zip = storedZip(new Map([...members, ['manifest.json', manifestRaw]]));
  // The archive must read back as exactly these members and bytes.
  const read = readZip(zip);
  require(read.size === members.size + 1 && [...members].every(([name, raw]) => read.get(name)?.raw.equals(raw))
    && read.get('manifest.json')?.raw.equals(manifestRaw), 'The written archive does not read back');
  const asset = assetName(target.game_patch);
  const sourceFiles = Object.fromEntries([...source.files.keys()].sort()
    .map(name => [`${source.directory}/${name}`, pin(source.files.get(name))]));
  const receipt = {
    schema: RECEIPT_SCHEMA,
    target,
    producer: producerIdentity(repo, loaded),
    source: {
      manifest: { ...config.source.manifest, schema: SOURCE_SCHEMA },
      origin: config.source.origin,
      files: sourceFiles,
    },
    package: {
      asset,
      ...pin(zip),
      expanded_bytes: [...read.values()].reduce((sum, entry) => sum + entry.raw.length, 0),
      manifest: pin(manifestRaw),
      members: origins,
    },
  };
  const receiptRaw = encoded(receipt);
  if (existsSync(out)) {
    require(existsSync(path.join(out, MARKER)), `Refusing to replace a non-release directory: ${out}`);
    rmSync(out, { recursive: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, MARKER), 'generated by src/locale-release.mjs\n');
  writeFileSync(path.join(out, asset), zip);
  writeFileSync(path.join(out, 'receipt.json'), receiptRaw);
  writeFileSync(path.join(out, 'manifest.json'), manifestRaw);
  writeFileSync(path.join(out, 'SHA256SUMS'), sha256sums({ [asset]: sha256(zip), 'receipt.json': sha256(receiptRaw) }));
  return { out, loaded, receipt, receiptRaw, zip, asset };
}

// --- checks --------------------------------------------------------------------------------------

// Fetch the origin commit when it is missing (Git only; used by CI's shallow checkout).
export function fetchOrigin(repo, origin) {
  if (git(repo, ['cat-file', '-e', `${origin.revision}^{commit}`]).status === 0) return;
  const result = git(repo, ['fetch', '--quiet', '--depth=1', '--no-tags', 'origin', origin.revision], { online: true });
  require(result.status === 0, `Cannot fetch origin revision ${origin.revision}: ${result.stderr}`);
}

// Offline reproducibility claims of a clean build; returns the list of failures.
export function check(repo, built) {
  const { config } = built.loaded, { receipt } = built;
  const problems = [];
  if (receipt.producer.dirty) problems.push(`the checkout is dirty: ${receipt.producer.dirty_paths.slice(0, 5)}`);
  const directory = path.posix.dirname(config.source.manifest.path);
  const originDirectory = path.posix.dirname(originManifestPath(config));
  const tree = (rev, dir) => git(repo, ['rev-parse', '--verify', '--quiet', `${rev}:${dir}`]);
  const [origin, head] = [tree(config.source.origin.revision, originDirectory), tree('HEAD', directory)];
  if (origin.status !== 0) problems.push(`origin ${config.source.origin.revision} is not present locally (pass --fetch)`);
  else if (origin.stdout !== head.stdout) problems.push(`${directory} differs from ${originDirectory} at ${config.source.origin.tag}`);
  if (config.published && !samePin(receipt.package, config.published)) {
    problems.push(`the package differs from the published ${config.published.tag} (${config.published.sha256})`);
  }
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

// The declared published Release must serve exactly the rebuilt zip.
export async function checkRelease(built, fetcher = download) {
  const { published } = built.loaded.config;
  require(published, 'The release config declares no published package');
  const sums = (await fetcher(releaseUrl(REPOSITORY, published.tag, 'SHA256SUMS'))).toString('utf8');
  require(sums.split('\n').includes(`${published.sha256}  ${published.asset}`),
    `${published.tag} SHA256SUMS does not list ${published.asset} ${published.sha256}`);
  const zip = await fetcher(releaseUrl(REPOSITORY, published.tag, published.asset));
  require(zip.equals(built.zip), `${published.tag} ${published.asset} differs from the rebuilt package`);
}

export function report(built) {
  const { receipt } = built, { package: pkg, producer } = receipt;
  const sources = Object.keys(receipt.source.files);
  return [
    `target: ${targetName(receipt.target)}`,
    `source: ${receipt.source.manifest.path} (${sources.length} files: ${sources.filter(n => n.includes('/i18n/')).length} i18n, `
      + `${sources.filter(n => n.includes('/evidence/')).length} evidence)`,
    `producer: ${producer.repository}@${producer.commit}${producer.dirty ? ` DIRTY (${producer.dirty_paths.length} paths)` : ''}`,
    `${pkg.asset}: ${pkg.bytes} bytes sha256 ${pkg.sha256}`,
    `  ${Object.keys(pkg.members).length} members + manifest.json (${pkg.manifest.sha256}), ${pkg.expanded_bytes} expanded bytes`,
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
    console.log('usage: release:build [--config release/<patch>.json] [--out .cache/DIR] [--fetch] [--check] [--check-release]\n'
      + '  --fetch          fetch the source origin commit from origin when missing (Git only)\n'
      + '  --check          exit 1 unless the build is clean, the source equals its origin tag tree and\n'
      + '                   the zip equals the config\'s published pin (when declared)\n'
      + '  --check-release  download the config\'s published Release (when declared) and compare it byte for byte');
    return;
  }
  const built = build({ config: values.config, out: values.out });
  console.log(report(built));
  if (values.fetch) fetchOrigin(ROOT, built.loaded.config.source.origin);
  if (values.check) {
    const problems = check(ROOT, built);
    require(!problems.length, `check failed:\n${problems.map(p => `  - ${p}`).join('\n')}`);
    console.log('check: clean build; source equals its origin tree' + (built.loaded.config.published ? '; zip equals the published pin' : ''));
  }
  if (values['check-release']) {
    const { published } = built.loaded.config;
    if (!published) console.log('check-release: the release config declares no published package yet');
    else {
      await checkRelease(built);
      console.log(`check-release: ${published.tag} serves the rebuilt zip byte for byte`);
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { log('release:build', error.message); process.exitCode = 1; });
}
