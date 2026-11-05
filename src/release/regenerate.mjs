// release:regenerate — rebuild the members of a v1 release config's frozen source publication from
// their producers' pinned inputs and compare them byte for byte. Input: release/regenerate/<patch>.json
// (poe2-locale-regeneration/v1), which names the config it reproduces, the producer jobs and the
// members that cannot be regenerated yet (frozen, each with a reason and an exit condition). Every
// i18n member of the source is covered exactly once. The regenerated and frozen members are packaged
// exactly as release:build packages the source; the zip must equal the config's published pin.
// Output under .cache/regenerate/<game>-<realm>-<recipe name>/: regeneration.json and the zip.
//
// Inputs are Git objects of this repository ({revision, path}; --fetch fetches a missing revision)
// or HTTPS URLs (downloaded with --fetch into .cache/regenerate/inputs/<sha256>); every one has a
// byte length and SHA-256 pin, either in the recipe or in a pinned producer manifest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { strictJson } from '../strict-json.mjs';
import { readZip } from './stored-zip.mjs';
import { produceLocale } from '../pobr/locale-producer.mjs';
import { validateProjection } from '../pobr/display-texts.mjs';
import {
  REPOSITORY, ROOT, assetName, download, encoded, fetchOrigin, loadConfig, log, originManifestPath, packageArchive, packageMembers,
  pin, producerIdentity, publicationSource, readSource, releaseUrl, require, samePin, sha256,
} from './build.mjs';

export const RECIPE_SCHEMA = 'poe2-locale-regeneration/v1';
export const RESULT_SCHEMA = 'poe2-locale-regeneration-receipt/v1';
const MARKER = '.release-regenerate';
const HEX40 = /^[0-9a-f]{40}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const OWN_RAW = /^https:\/\/raw\.githubusercontent\.com\/ackness\/poe2-zh-cn-stats\/([0-9a-f]{40})\/(.+)$/u;
const OWN_REPOSITORY = `https://github.com/${REPOSITORY}`;
const isPin = value => Number.isSafeInteger(value?.bytes) && value.bytes >= 0 && HEX64.test(value?.sha256 ?? '');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const say = message => log('release:regenerate', message);
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// --- recipe --------------------------------------------------------------------------------------

function gitRef(value, label) {
  require(object(value) && HEX40.test(value.revision ?? '') && typeof value.path === 'string' && value.path
    && !value.path.split('/').some(part => !part || part === '.' || part === '..'), `${label}: needs a full revision and a path`);
  return value;
}

// A game Release asset {repository, tag, asset, bytes, sha256}, downloaded with --fetch.
function validateGamePackage(job) {
  const game = job.game_package;
  require(object(game) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(game.repository ?? '') && typeof game.tag === 'string' && game.tag
    && typeof game.asset === 'string' && game.asset && isPin(game), `${job.id}: game_package needs repository, tag, asset, bytes and sha256`);
}

function validateJob(job, members) {
  require(object(job) && /^[a-z0-9][a-z0-9-]*$/u.test(job.id ?? ''), `Invalid job id: ${job?.id}`);
  require(Array.isArray(job.members) && job.members.length, `${job.id}: no members`);
  for (const member of job.members) {
    require(/^i18n\/[^/]+\/[^/]+\.json$/u.test(member) && !members.has(member), `${job.id}: invalid or repeated member ${member}`);
    members.add(member);
  }
  require(job.passthrough === undefined || (object(job.passthrough)
    && Object.entries(job.passthrough).every(([member, why]) => job.members.includes(member) && typeof why === 'string' && why)),
  `${job.id}: passthrough maps a member of the job to a reason`);
  require(job.composed_evidence === undefined || (object(job.composed_evidence) && Object.entries(job.composed_evidence)
    .every(([member, layers]) => job.members.includes(member) && Array.isArray(layers) && layers.length
      && layers.every(layer => typeof layer.input === 'string' && typeof layer.category === 'string' && layer.reason && layer.exit))),
  `${job.id}: composed_evidence maps a member to [{input, category, reason, exit}]`);
  if (job.kind === 'locale-producer') {
    gitRef(job.manifest, `${job.id} manifest`);
    require(isPin(job.manifest) && HEX40.test(job.producer_commit ?? ''), `${job.id}: pin the manifest and name the producer commit`);
    require(job.members.every(member => member.startsWith('i18n/zh-CN/')), `${job.id}: the producer writes i18n/zh-CN/* only`);
    // A member the producer also writes but another job of the recipe owns (loadRecipe checks the owner).
    require(job.replaced_by === undefined || (object(job.replaced_by) && Object.entries(job.replaced_by)
      .every(([member, owner]) => !job.members.includes(member) && typeof owner === 'string' && owner !== job.id)),
    `${job.id}: replaced_by maps a member it does not list to the job that produces it`);
  } else if (job.kind === 'supplement-lines') {
    validateGamePackage(job);
    // src/pobr/supplement-lines.mjs: a base stat_lines.json (and optional _meta.json) as Git pins, the
    // game Release package, and curation/display-supplements.json as a Git pin.
    for (const key of ['base', 'edits', ...(job.meta ? ['meta'] : [])]) require(isPin(gitRef(job[key], `${job.id} ${key}`)), `${job.id}: pin the ${key}`);
    require(typeof job.locale === 'string' && JSON.stringify(job.members) === JSON.stringify([`i18n/${job.locale}/stat_lines.json`,
      ...(job.meta ? [`i18n/${job.locale}/_meta.json`] : [])]),
    `${job.id}: members are i18n/<locale>/stat_lines.json, then i18n/<locale>/_meta.json when meta is pinned`);
  } else if (job.kind === 'display-texts') {
    for (const key of ['catalog', 'supplement']) require(isPin(gitRef(job[key], `${job.id} ${key}`)), `${job.id}: pin the ${key}`);
    if (job.names !== undefined) require(isPin(gitRef(job.names, `${job.id} names`)), `${job.id}: pin the names file`);
    // The official names file is a Git pin of this repository or an HTTPS download (e.g. a RePoE Release asset).
    if (job.official_names !== undefined) require(isPin(job.official_names) && (typeof job.official_names.url === 'string'
      ? job.official_names.url.startsWith('https://') : gitRef(job.official_names, `${job.id} official_names`)),
    `${job.id}: pin official_names as {revision, path, bytes, sha256} or {url, bytes, sha256}`);
    // Monster names are decided against the target English of the game Release package.
    if (job.names !== undefined || job.official_names !== undefined) validateGamePackage(job);
    gitRef(job.supplement_module, `${job.id} supplement_module`);
    // The projection is pinned in the recipe, never read from src/pobr/display-projection.json:
    // a new default scope there must not change a member that a published package already holds.
    try { validateProjection(job.projection); } catch {
      throw new Error(`${job.id}: pin the projection {scopes, literals} that produced the member`);
    }
    require(typeof job.locale === 'string' && job.members.length === 1 && job.members[0] === `i18n/${job.locale}/display_texts.json`,
      `${job.id}: one member, i18n/<locale>/display_texts.json`);
  } else throw new Error(`${job.id}: unknown job kind ${job.kind}`);
}

export function loadRecipe(file, repo = ROOT) {
  file = path.resolve(file);
  const raw = readFileSync(file);
  const recipe = strictJson(raw);
  require(recipe.schema === RECIPE_SCHEMA, `${file}: expected schema ${RECIPE_SCHEMA}`);
  require(Object.keys(recipe).every(key => ['schema', 'reproduces', 'categories', 'jobs', 'frozen'].includes(key)), `${file}: unknown fields`);
  const loaded = loadConfig(path.join(repo, recipe.reproduces ?? ''), repo);
  require(!loaded.base && loaded.underRelease, 'A recipe reproduces a v1 config under release/');
  require(path.basename(file) === path.basename(loaded.file), `${path.basename(file)} must be named like ${loaded.display}`);
  require(Array.isArray(recipe.jobs) && recipe.jobs.length, 'A recipe has at least one job');
  const members = new Set(), ids = new Set();
  for (const job of recipe.jobs) {
    validateJob(job, members);
    require(!ids.has(job.id), `Duplicate job id ${job.id}`);
    ids.add(job.id);
  }
  require(object(recipe.categories) && object(recipe.frozen ?? {}), 'categories and frozen are objects');
  for (const job of recipe.jobs) for (const [member, owner] of Object.entries(job.replaced_by ?? {})) {
    require(recipe.jobs.some(other => other.id === owner && other.members.includes(member)), `${job.id}: ${member} is not a member of job ${owner}`);
  }
  for (const job of recipe.jobs) for (const [member, layers] of Object.entries(job.composed_evidence ?? {})) {
    for (const layer of layers) {
      require(Object.hasOwn(recipe.categories, layer.category), `${job.id}: ${member} layer ${layer.input} names an undeclared category`);
    }
  }
  for (const [member, entry] of Object.entries(recipe.frozen ?? {})) {
    require(!members.has(member), `${member} is both regenerated and frozen`);
    members.add(member);
    require(isPin(entry) && Object.hasOwn(recipe.categories, entry.category) && typeof entry.reason === 'string' && entry.reason
      && typeof entry.exit === 'string' && entry.exit, `${member}: a frozen member pins its bytes and states category, reason and exit`);
  }
  const relative = path.relative(repo, file).split(path.sep).join('/');
  return { file, raw, recipe, config: loaded, members, display: relative.startsWith('..') ? file : relative };
}

export function recipeFiles(repo = ROOT) {
  const directory = path.join(repo, 'release/regenerate');
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort().map(name => path.join(directory, name)) : [];
}

// --- inputs --------------------------------------------------------------------------------------

export class Inputs {
  constructor(repo, { fetch = false, cache, fetcher = download } = {}) {
    Object.assign(this, { repo, fetch, fetcher, cache: cache ?? path.join(repo, '.cache/regenerate/inputs'), used: {} });
  }

  record(name, source, raw) {
    this.used[name] = { ...pin(raw), source };
  }

  git({ revision, path: file }, expected, name = `${revision}:${file}`) {
    const show = () => spawnSync('git', ['--no-replace-objects', '-C', this.repo, 'cat-file', 'blob', `${revision}:${file}`],
      { env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }, maxBuffer: 1 << 30 });
    let result = show();
    if (result.status !== 0 && this.fetch) {
      fetchOrigin(this.repo, { revision });
      result = show();
    }
    require(result.status === 0, `${name}: ${revision}:${file} is not present locally${this.fetch ? '' : ' (pass --fetch)'}`);
    require(samePin(pin(result.stdout), expected), `${name}: ${revision}:${file} differs from its pin`);
    this.record(name, { repository: REPOSITORY, revision, path: file }, result.stdout);
    return result.stdout;
  }

  async url(url, expected, name = url) {
    const own = OWN_RAW.exec(url);
    if (own) return this.git({ revision: own[1], path: own[2] }, expected, name);
    require(url.startsWith('https://'), `${name}: only HTTPS inputs`);
    const cached = path.join(this.cache, expected.sha256);
    let raw = existsSync(cached) ? readFileSync(cached) : null;
    if (raw && !samePin(pin(raw), expected)) raw = null;
    if (!raw) {
      require(this.fetch, `${name}: ${url} is not cached (pass --fetch)`);
      raw = await this.fetcher(url);
      require(samePin(pin(raw), expected), `${name}: ${url} differs from its pin`);
      mkdirSync(this.cache, { recursive: true });
      writeFileSync(cached, raw);
    }
    this.record(name, { url }, raw);
    return raw;
  }
}

// --- jobs ----------------------------------------------------------------------------------------

function writeTree(directory, files) {
  for (const [name, raw] of files) {
    mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    writeFileSync(path.join(directory, name), raw);
  }
}

// src/pobr/locale-producer.mjs over its pinned generation manifest; each manifest input comes from its
// declared source: a URL, this repository at a commit, or (`producer-commit`) the job's producer commit.
async function localeProducer(job, inputs, work) {
  const manifestRaw = inputs.git(job.manifest, job.manifest, `${job.id}:manifest`);
  const manifest = strictJson(manifestRaw);
  const files = new Map();
  for (const [name, expected] of Object.entries(manifest.inputs ?? {})) {
    const source = expected.source ?? {};
    const label = `${job.id}:${name}`;
    let raw;
    if (typeof source.url === 'string') raw = await inputs.url(source.url, expected, label);
    else {
      require(source.repository === OWN_REPOSITORY && source.revision === 'producer-commit', `${label}: unsupported input source`);
      raw = inputs.git({ revision: job.producer_commit, path: source.path }, expected, label);
    }
    files.set(name, raw);
  }
  const input = path.join(work, 'input'), out = path.join(work, 'out');
  writeFileSync(path.join(work, 'manifest.json'), manifestRaw);
  writeTree(input, files);
  const receipt = await produceLocale({ manifestPath: path.join(work, 'manifest.json'), manifestSha256: job.manifest.sha256, inputDir: input, out });
  const outputs = new Map(job.members.map(member => [member, readFileSync(path.join(out, member))]));
  for (const [name, expected] of Object.entries(receipt.files)) {
    if (name.startsWith('i18n/')) require(job.members.includes(name) || job.replaced_by?.[name], `${job.id}: the producer also writes ${name}; list or drop it`);
    require(samePin(pin(readFileSync(path.join(out, name))), expected), `${job.id}: ${name} differs from the producer receipt`);
  }
  return { outputs, inputs: files, summary: { layers: receipt.layers, profile: receipt.profile } };
}

// src/pobr/display-texts.mjs over a pinned catalog archive and reviewed supplement archive, with this
// checkout's library modules (a v3 catalog's producer closure must equal them), the reviewed
// module, which must equal its file at the pinned revision, and the job's pinned projection.
async function displayTexts(job, inputs, work, repo) {
  require(path.resolve(repo) === ROOT, `${job.id}: display texts are produced by this checkout's modules`);
  const { createDisplayTexts } = await import('../pobr/display-texts.mjs');
  const extract = (key, directory) => {
    const archive = readZip(inputs.git(job[key], job[key], `${job.id}:${key}`));
    writeTree(directory, [...archive].map(([name, { raw }]) => [name, raw]));
    return pin(archive.get('manifest.json').raw);
  };
  const catalog = path.join(work, 'catalog'), supplement = path.join(work, 'supplement');
  const catalogPin = extract('catalog', catalog), supplementPin = extract('supplement', supplement);
  const moduleRaw = readFileSync(path.join(ROOT, job.supplement_module.path));
  inputs.git(job.supplement_module, pin(moduleRaw), `${job.id}:supplement_module`);
  const request = {
    schema: 'pobr-native-display-texts-request/v1', game_patch: job.target.game_patch, realm: job.target.realm, locale: job.locale,
    catalog: { manifest: path.join(catalog, 'manifest.json'), ...catalogPin },
    supplement: { manifest: path.join(supplement, 'manifest.json'), ...supplementPin,
      module: { file: job.supplement_module.path, ...pin(moduleRaw), revision: job.supplement_module.revision } },
    projection: job.projection,
  };
  if (job.names) {
    const raw = inputs.git(job.names, job.names, `${job.id}:names`);
    writeFileSync(path.join(work, 'names.json'), raw);
    request.names = { file: path.join(work, 'names.json'), ...pin(raw) };
  }
  if (job.official_names) {
    const spec = job.official_names, label = `${job.id}:official_names`;
    const raw = spec.url ? await inputs.url(spec.url, spec, label) : inputs.git(spec, spec, label);
    writeFileSync(path.join(work, 'official-names.json'), raw);
    request.official_names = { file: path.join(work, 'official-names.json'), ...pin(raw) };
  }
  if (job.names || job.official_names) {
    const { repository, tag, asset } = job.game_package;
    const zip = await inputs.url(releaseUrl(repository, tag, asset), job.game_package, `${job.id}:game_package`);
    writeFileSync(path.join(work, asset), zip);
    request.game_package = { file: path.join(work, asset), ...pin(zip), repository, tag, asset };
  }
  const receipt = await createDisplayTexts(request, path.join(work, 'out'));
  const raw = readFileSync(path.join(work, 'out', 'display_texts.json'));
  require(samePin(pin(raw), receipt.files['display_texts.json']), `${job.id}: display_texts.json differs from its receipt`);
  return { outputs: new Map([[job.members[0], raw]]), inputs: new Map(),
    summary: { decisions: receipt.decisions.length, conflicts: receipt.conflicts.length, supplement_records: receipt.supplement?.records,
      projection: receipt.projection, ...(receipt.names ? { names: receipt.names.counts } : {}) } };
}

// src/pobr/supplement-lines.mjs over a pinned base member, the game Release package and the pinned
// display supplements. Every input is materialized from its pin; the producer re-checks each pin.
async function supplementLinesJob(job, inputs, work) {
  const { createSupplementLines } = await import('../pobr/supplement-lines.mjs');
  const files = new Map(), request = { schema: 'pobr-supplement-lines-request/v1',
    target: { game: job.target.game, game_patch: job.target.game_patch, realm: job.target.realm, locale: job.locale } };
  const materialize = (key, name, raw) => {
    writeFileSync(path.join(work, name), raw);
    files.set(key, raw);
    return { file: path.join(work, name), ...pin(raw) };
  };
  request.base = materialize('base', 'stat_lines.json', inputs.git(job.base, job.base, `${job.id}:base`));
  if (job.meta) request.meta = materialize('meta', '_meta.json', inputs.git(job.meta, job.meta, `${job.id}:meta`));
  const { repository, tag, asset } = job.game_package;
  const zip = await inputs.url(releaseUrl(repository, tag, asset), job.game_package, `${job.id}:game_package`);
  request.game_package = { ...materialize('game_package', asset, zip), repository, tag, asset };
  request.edits = materialize('edits', 'display-supplements.json', inputs.git(job.edits, job.edits, `${job.id}:edits`));
  const receipt = createSupplementLines(request, path.join(work, 'out'));
  const outputs = new Map();
  for (const member of job.members) {
    const raw = readFileSync(path.join(work, 'out', path.basename(member)));
    require(samePin(pin(raw), receipt.files[path.basename(member)]), `${job.id}: ${member} differs from its receipt`);
    outputs.set(member, raw);
  }
  // Only the base members can be carried verbatim; the game package and edits never are.
  const carried = new Map([...files].filter(([key]) => key === 'base' || key === 'meta'));
  return { outputs, inputs: carried, summary: { counts: receipt.counts, corrections: receipt.corrections.length, entries: receipt.entries.length } };
}

const JOBS = { 'locale-producer': localeProducer, 'display-texts': displayTexts, 'supplement-lines': supplementLinesJob };

// --- regeneration --------------------------------------------------------------------------------

function outputDirectory(repo, out, recipe) {
  const { target } = recipe.config.config;
  out = path.resolve(out ?? path.join(repo, '.cache/regenerate', `${target.game}-${target.realm}-${path.basename(recipe.file, '.json')}`));
  require(!path.relative(path.join(repo, '.cache'), out).startsWith('..'), 'Output must be under .cache/');
  if (existsSync(out)) {
    require(existsSync(path.join(out, MARKER)), `Refusing to replace a non-regeneration directory: ${out}`);
    rmSync(out, { recursive: true });
  }
  mkdirSync(path.join(out, 'work'), { recursive: true });
  writeFileSync(path.join(out, MARKER), 'generated by src/release/regenerate.mjs\n');
  return out;
}

export async function regenerate({ repo = ROOT, recipe: recipeFile, out, fetch = false, fetcher, keepWork = false } = {}) {
  repo = path.resolve(repo);
  const recipe = loadRecipe(recipeFile, repo);
  const { config } = recipe.config, { target } = config;
  const source = readSource(repo, config);
  const sourceMembers = [...source.files.keys()].filter(name => name.startsWith('i18n/')).sort();
  const missing = sourceMembers.filter(name => !recipe.members.has(name));
  const extra = [...recipe.members].filter(name => !source.files.has(name));
  require(!missing.length && !extra.length, `The recipe must cover exactly the source's i18n members (missing: ${missing}; extra: ${extra})`);
  out = outputDirectory(repo, out, recipe);
  const inputs = new Inputs(repo, { fetch, fetcher });
  const members = {}, jobs = [], regenerated = new Map();
  for (const job of recipe.recipe.jobs) {
    say(`${job.id}: ${job.kind}`);
    const work = path.join(out, 'work', job.id);
    mkdirSync(work, { recursive: true });
    const result = await JOBS[job.kind]({ ...job, target }, inputs, work, repo);
    for (const member of job.members) {
      const raw = result.outputs.get(member), reference = source.files.get(member);
      // Pass-through is detected, not only declared: an output equal to one of the job's inputs.
      const carried = [...result.inputs].filter(([, input]) => input.equals(raw)).map(([name]) => name);
      const declared = job.passthrough?.[member];
      require(!carried.length === !declared, `${job.id}: ${member} ${carried.length
        ? `equals its input ${carried[0]}; declare it as passthrough` : 'is declared passthrough but equals no input'}`);
      const provenance = declared ? 'passthrough' : 'generated';
      members[member] = { class: `${provenance}-${raw.equals(reference) ? 'identical' : 'different'}`, job: job.id, ...pin(raw),
        ...(declared ? { carries: carried[0], reason: declared } : {}),
        ...(raw.equals(reference) ? {} : { reference: pin(reference) }),
        ...(job.composed_evidence?.[member] ? { composed_evidence: job.composed_evidence[member] } : {}) };
      regenerated.set(member, raw);
    }
    jobs.push({ id: job.id, kind: job.kind, members: job.members, summary: result.summary });
  }
  for (const [member, entry] of Object.entries(recipe.recipe.frozen ?? {})) {
    const raw = source.files.get(member);
    require(samePin(pin(raw), entry), `${member}: the frozen pin differs from ${source.directory}/${member}`);
    members[member] = { class: 'frozen', ...pin(raw), category: entry.category, reason: entry.reason, exit: entry.exit };
    regenerated.set(member, raw);
  }
  // Package the regenerated members exactly as release:build packages the source.
  const i18n = new Map([...source.files].filter(([name]) => !name.startsWith('i18n/')));
  for (const [name, raw] of regenerated) i18n.set(name, raw);
  const { members: packaged } = packageMembers(target, { ...source, files: i18n });
  const { zip } = packageArchive(target, publicationSource({ ...config.source.manifest, path: originManifestPath(config) }), packaged);
  const sorted = Object.fromEntries(Object.keys(members).sort(compare).map(name => [name, members[name]]));
  const counts = {};
  for (const { class: kind } of Object.values(sorted)) counts[kind] = (counts[kind] ?? 0) + 1;
  const result = {
    schema: RESULT_SCHEMA,
    target,
    producer: { ...producerIdentity(repo, recipe.config), recipe: { [recipe.display]: pin(recipe.raw) } },
    reproduces: { config: recipe.config.display, source: config.source.manifest.path, published: config.published ?? null },
    categories: recipe.recipe.categories,
    inputs: Object.fromEntries(Object.keys(inputs.used).sort(compare).map(name => [name, inputs.used[name]])),
    jobs,
    members: sorted,
    summary: counts,
    package: { asset: assetName(target.game_patch), ...pin(zip), equals_published: config.published ? samePin(pin(zip), config.published) : null },
  };
  const raw = encoded(result);
  writeFileSync(path.join(out, 'regeneration.json'), raw);
  writeFileSync(path.join(out, assetName(target.game_patch)), zip);
  if (!keepWork) rmSync(path.join(out, 'work'), { recursive: true });
  return { out, result, raw, zip };
}

// Failures of a regeneration that claims to reproduce its config's published package.
export function problems({ result }) {
  const found = Object.entries(result.members).filter(([, entry]) => entry.class.endsWith('-different'))
    .map(([name, entry]) => `${name} regenerates as ${entry.sha256}, the source has ${entry.reference.sha256}`);
  if (result.package.equals_published === false) {
    found.push(`the package ${result.package.sha256} differs from the published ${result.reproduces.published.tag} ${result.reproduces.published.sha256}`);
  }
  return found;
}

export function report({ out, result }) {
  const lines = [`target: ${result.target.game}-${result.target.realm}-${result.target.game_patch} (reproduces ${result.reproduces.config})`];
  for (const [name, entry] of Object.entries(result.members)) {
    lines.push(`  ${entry.class.padEnd(22)} ${name}${entry.job ? ` <- ${entry.job}` : ` (${entry.category})`}`);
  }
  lines.push(`summary: ${Object.entries(result.summary).map(([kind, n]) => `${n} ${kind}`).join(', ')}`);
  lines.push(`${result.package.asset}: ${result.package.bytes} bytes sha256 ${result.package.sha256}`
    + (result.package.equals_published === null ? '' : result.package.equals_published ? ' (equals the published pin)' : ' (DIFFERS from the published pin)'));
  lines.push(`output: ${out}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: {
    recipe: { type: 'string' }, out: { type: 'string' }, fetch: { type: 'boolean' }, 'keep-work': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('usage: release:regenerate [--recipe release/regenerate/<patch>.json] [--out .cache/DIR] [--fetch] [--keep-work]\n'
      + '  rebuilds the frozen source members of the recipe\'s release config from pinned producer inputs and exits 1\n'
      + '  unless every regenerated member and the package equal the source and the published pin\n'
      + '  --fetch      fetch missing Git revisions from origin and download URL inputs into .cache/regenerate/inputs\n'
      + '  --keep-work  keep the materialized inputs and producer outputs under <out>/work');
    return;
  }
  const files = values.recipe ? [values.recipe] : recipeFiles(ROOT);
  require(files.length, 'No recipe under release/regenerate/');
  require(!values.out || files.length === 1, '--out needs a single --recipe');
  const failed = [];
  for (const file of files) {
    const done = await regenerate({ recipe: file, out: values.out, fetch: values.fetch, keepWork: values['keep-work'] });
    console.log(report(done));
    failed.push(...problems(done).map(problem => `${path.basename(file)}: ${problem}`));
  }
  require(!failed.length, `regeneration does not reproduce the source:\n${failed.map(p => `  - ${p}`).join('\n')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { say(error.message); process.exitCode = 1; });
}
