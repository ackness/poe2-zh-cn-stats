#!/usr/bin/env node
// A declaration registry for the existing language-owner publication formats.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual as same } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { strictJson } from './strict-json.mjs';

export const OWNER = 'ackness/poe2-zh-cn-stats';
export const ROLES = Object.freeze(['language', 'display_catalog', 'display_library',
  'reviewed_supplement', 'workbench', 'support_display', 'locale_generation']);
export const SCOPE = Object.freeze({ complete: 'declared-dependency-closure-only',
  freshness_certified: false, official_client_certified: false, translation_quality_certified: false });
const LIBRARY = ['native-catalog.mjs', 'native-names.mjs', 'strict-json.mjs',
  'native-catalog-binding.mjs', 'native-catalog-fk-binding.mjs', 'native-localization.mjs'].map(f => `src/${f}`);
const PRODUCER = ['src/locale-producer.mjs', 'src/legacy-translation-merge.mjs', 'src/strict-json.mjs'];
const DICTIONARY = ['lookup/stat_lines.json', 'lookup/en_to_cn.json', 'tables/BaseItemTypes.json',
  'tables/ActiveSkills.json', 'tables/Characters.json', 'tables/Ascendancy.json', 'tables/Words.json',
  'tables/PassiveSkills.json', 'tables/Mods.json', 'meta.json'].map(n => `dictionary/${n}`);
const GENERATION_EVIDENCE = ['native-140-pairs.json', 'selected-literals.json', 'zh-CN-layered-meta.json', 'zh-CN-original-meta.json'].map(n => `evidence/${n}`);
const RETAINED_EVIDENCE = ['locale-decision.json', 'native-140-pairs.json', 'zh-CN-original-meta.json', 'zh-CN-original-stat-lines.json', 'zh-TW-receipt.json'].map(n => `evidence/${n}`);
const META_LIMIT = 1024 * 1024, ARCHIVE_LIMIT = 64 * 1024 * 1024;
const run = promisify(execFile);
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = b => createHash('sha256').update(b).digest('hex');
export const bytePin = b => ({ bytes: b.length, sha256: hash(b) });
const json = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const fields = (x, keys, label) => assert(object(x) && same(Object.keys(x).sort(), [...keys].sort()), `${label}: fields differ`);
const text = x => typeof x === 'string' && x.length > 0;
const fullrev = x => typeof x === 'string' && /^[a-f0-9]{40}$/u.test(x);
const sha = x => typeof x === 'string' && /^[a-f0-9]{64}$/u.test(x);
const sequence = (x, label) => assert(Number.isSafeInteger(x) && x > 0, `${label}: positive sequence required`);
function safePath(x) {
  assert(text(x) && x.split('/').every(s => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(s)), `invalid path: ${x}`);
}
function pin(x, label) {
  fields(x, ['bytes', 'sha256'], label);
  assert(Number.isSafeInteger(x.bytes) && x.bytes >= 0 && sha(x.sha256), `${label}: invalid byte pin`);
}
function gitPin(x, label) {
  fields(x, ['revision', 'path', 'bytes', 'sha256'], label);
  assert(fullrev(x.revision), `${label}: full revision required`); safePath(x.path);
  pin({ bytes: x.bytes, sha256: x.sha256 }, label);
}
const checkBytes = (b, p, label) => { pin(p, label); assert(same(bytePin(b), p), `${label}: byte pin mismatch`); };
function target(x) {
  fields(x, ['game', 'game_patch', 'realm'], 'target');
  assert(x.game === 'poe2' && x.realm === 'international' && text(x.game_patch), 'unsupported target');
}
function identity(x, label, repository = OWNER) {
  assert(object(x) && x.repository === repository && fullrev(x.revision), `${label}: owner or full revision differs`);
  if (Object.hasOwn(x, 'publication')) assert(x.publication === 'published', `${label}: unpublished package`);
}
function filePins(x, label) {
  assert(object(x) && Object.keys(x).length > 0, `${label}: empty files`);
  for (const [name, p] of Object.entries(x)) { safePath(name); pin(p, `${label}/${name}`); }
}
function archiveSpec(x, label, repository = OWNER) {
  fields(x, ['repository', 'revision', 'path', 'bytes', 'sha256', 'manifest', 'expanded_bytes'], label);
  identity(x, label, repository); safePath(x.path);
  pin({ bytes: x.bytes, sha256: x.sha256 }, label); pin(x.manifest, `${label}/manifest`);
  assert(Number.isSafeInteger(x.expanded_bytes) && x.expanded_bytes > 0, `${label}: invalid expanded size`);
}
function validateInputs(c) {
  const input = role => c[role].input;
  const l = input('language');
  fields(l, ['format', 'publication', 'repository', 'revision', 'path', 'manifest'], 'language');
  identity(l, 'language'); safePath(l.path); pin(l.manifest, 'language/manifest');
  assert(l.format === 'locale-git-files' && l.publication === 'published', 'language: unpublished or invalid format');
  archiveSpec(input('display_catalog'), 'display_catalog'); archiveSpec(input('reviewed_supplement'), 'reviewed_supplement');
  const lib = input('display_library'); fields(lib, ['repository', 'revision', 'files'], 'display_library');
  identity(lib, 'display_library'); filePins(lib.files, 'display_library');
  assert(same(Object.keys(lib.files).sort(), [...LIBRARY].sort()), 'display_library: incomplete closure');
  const w = input('workbench'); fields(w, ['repository', 'revision', 'file', 'bytes', 'sha256'], 'workbench');
  identity(w, 'workbench'); safePath(w.file); pin({ bytes: w.bytes, sha256: w.sha256 }, 'workbench');
  assert(w.file === 'src/translation-workbench.mjs', 'workbench: wrong entrypoint');
  const s = input('support_display');
  fields(s, ['publication', 'repository', 'revision', 'path', 'manifest', 'asset', 'catalog_sha256', 'source_data_version'], 'support_display');
  identity(s, 'support_display'); safePath(s.path); pin(s.manifest, 'support manifest'); pin(s.asset, 'support asset');
  assert(s.publication === 'published' && sha(s.catalog_sha256) && text(s.source_data_version), 'support_display: invalid declaration');
  const g = input('locale_generation');
  fields(g, ['schema', 'target', 'repository', 'revision', 'producer', 'input_manifest'], 'locale_generation');
  assert(g.schema === 'pobr-locale-generation-lock/v1', 'locale_generation: schema differs');
  identity(g, 'locale_generation'); target(g.target);
  fields(g.producer, ['entrypoint', 'files'], 'locale producer'); filePins(g.producer.files, 'locale producer');
  assert(g.producer.entrypoint === PRODUCER[0] && same(Object.keys(g.producer.files).sort(), [...PRODUCER].sort()), 'locale producer: incomplete closure');
  fields(g.input_manifest, ['path', 'bytes', 'sha256'], 'locale input manifest'); safePath(g.input_manifest.path);
  pin({ bytes: g.input_manifest.bytes, sha256: g.input_manifest.sha256 }, 'locale input manifest');
}

/** Parse retained bytes; duplicate keys and unknown/missing roles fail closed. */
export function validateDescriptor(bytes) {
  assert(bytes.length <= META_LIMIT, 'descriptor too large');
  const d = strictJson(bytes);
  fields(d, ['schema', 'owner', 'target', 'sequence', 'previous', 'scope', 'components', 'bindings', 'evidence'], 'descriptor');
  assert(d.schema === 'owned-data-publication/v2' && d.owner === OWNER, 'descriptor: schema or owner differs');
  target(d.target); sequence(d.sequence, 'descriptor');
  assert(same(d.scope, SCOPE), 'descriptor: unsupported scope');
  fields(d.components, ROLES, 'components');
  for (const [role, c] of Object.entries(d.components)) {
    fields(c, ['sequence', 'input'], role); sequence(c.sequence, role);
  }
  validateInputs(d.components);
  assert(same(d.components.locale_generation.input.target, d.target), 'locale_generation target differs');
  fields(d.bindings, ['display_source'], 'bindings'); archiveSpec(d.bindings.display_source, 'display_source', 'ackness/repoe');
  fields(d.evidence, ['catalog_validation'], 'evidence'); gitPin(d.evidence.catalog_validation, 'catalog validation');
  assert(d.evidence.catalog_validation.revision === d.components.display_catalog.input.revision
    && d.evidence.catalog_validation.path === path.posix.join(path.posix.dirname(d.components.display_catalog.input.path), 'validation.json'), 'catalog validation: publication differs');
  if (d.sequence === 1) {
    assert(d.previous === null && ROLES.every(r => d.components[r].sequence === 1), 'bootstrap: previous must be null and role sequences must be 1');
  } else gitPin(d.previous, 'previous');
  return d;
}
export function validateIndex(bytes) {
  assert(bytes.length <= META_LIMIT, 'index too large');
  const i = strictJson(bytes); fields(i, ['schema', 'channel', 'sequence', 'head'], 'index');
  assert(i.schema === 'owned-data-publication-index/v2', 'index: schema differs');
  fields(i.channel, ['game', 'realm'], 'channel');
  assert(i.channel.game === 'poe2' && i.channel.realm === 'international', 'index: channel differs');
  sequence(i.sequence, 'index'); gitPin(i.head, 'head');
  assert(i.head.path === `publication/releases/poe2-international/${i.sequence}.json`, 'head: descriptor path differs');
  return i;
}

// Git reads never resolve a branch, follow filesystem symlinks, fetch, or inflate tables.
function gitReader(repo) {
  const cache = new Map();
  const git = async args => (await run('git', ['--no-lazy-fetch', '--no-replace-objects', '-C', repo, ...args],
    { encoding: 'buffer', maxBuffer: ARCHIVE_LIMIT + META_LIMIT })).stdout;
  async function stat(revision, name) {
    assert(fullrev(revision), 'full revision required'); safePath(name);
    assert((await git(['cat-file', '-t', revision])).toString().trim() === 'commit', 'revision is not a commit');
    const line = (await git(['ls-tree', '-z', '-l', revision, '--', name])).toString();
    const match = /^(100644|100755) blob [a-f0-9]{40} +([0-9]+)\t([^\0]+)\0$/u.exec(line);
    assert(match && match[3] === name, `missing or non-regular Git file: ${name}`);
    return Number(match[2]);
  }
  async function read(revision, name, expected, limit = META_LIMIT) {
    const key = `${revision}:${name}`;
    if (!cache.has(key)) {
      const size = await stat(revision, name); assert(size <= limit, `Git file exceeds read budget: ${name}`);
      const b = await git(['show', key]); assert(b.length === size, `Git size differs: ${name}`); cache.set(key, b);
    }
    const b = cache.get(key); assert(b.length <= limit, `Git file exceeds read budget: ${name}`);
    if (expected) checkBytes(b, expected, name);
    return b;
  }
  return { stat, read };
}

// Read only small metadata members of an already hash-checked classic ZIP.
function zipMetadata(b, expanded) {
  let end = b.length - 22;
  while (end >= Math.max(0, b.length - 65557) && b.readUInt32LE(end) !== 0x06054b50) end--;
  assert(end >= 0 && end + 22 + b.readUInt16LE(end + 20) === b.length, 'invalid ZIP end');
  assert(b.readUInt32LE(end + 4) === 0 && b.readUInt16LE(end + 8) === b.readUInt16LE(end + 10), 'unsupported ZIP disks');
  const entries = new Map(), count = b.readUInt16LE(end + 10), start = b.readUInt32LE(end + 16);
  assert(count > 0 && count < 256 && start + b.readUInt32LE(end + 12) === end, 'invalid ZIP directory');
  let p = start, total = 0;
  for (let n = 0; n < count; n++) {
    assert(p + 46 <= end && b.readUInt32LE(p) === 0x02014b50, 'invalid ZIP member');
    const flags = b.readUInt16LE(p + 8), method = b.readUInt16LE(p + 10), compressed = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24);
    const nameSize = b.readUInt16LE(p + 28), extra = b.readUInt16LE(p + 30), comment = b.readUInt16LE(p + 32), offset = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nameSize).toString('utf8'); safePath(name);
    const mode = b.readUInt32LE(p + 38) >>> 16;
    assert(!entries.has(name) && !(flags & 1) && [0, 8].includes(method) && (!(mode & 0xf000) || (mode & 0xf000) === 0x8000), 'duplicate, encrypted or non-regular ZIP member');
    assert(offset + 30 <= start && b.readUInt32LE(offset) === 0x04034b50 && b.readUInt16LE(offset + 6) === flags && b.readUInt16LE(offset + 8) === method, 'ZIP local header differs');
    const localName = b.readUInt16LE(offset + 26), data = offset + 30 + localName + b.readUInt16LE(offset + 28);
    assert(b.subarray(offset + 30, offset + 30 + localName).toString('utf8') === name && data + compressed <= start, 'ZIP path or range differs');
    entries.set(name, { size, compressed, method, data }); total += size;
    p += 46 + nameSize + extra + comment;
  }
  assert(p === end && total === expanded, 'ZIP expanded size differs');
  return { entries, read(name, expected) {
    const e = entries.get(name); assert(e && e.size <= META_LIMIT, `missing or oversized ZIP metadata: ${name}`);
    const stored = b.subarray(e.data, e.data + e.compressed);
    const raw = e.method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: META_LIMIT });
    assert(raw.length === e.size, 'ZIP metadata size differs'); checkBytes(raw, expected, name);
    return strictJson(raw);
  } };
}

async function verifyDeclarations(d, reader) {
  const input = r => d.components[r].input;
  const load = async (s, name, expected) => strictJson(await reader.read(s.revision, name, expected));
  const manifest = async s => load(s, s.path, s.manifest);
  async function archive(s) {
    const b = await reader.read(s.revision, s.path, { bytes: s.bytes, sha256: s.sha256 }, ARCHIVE_LIMIT);
    const z = zipMetadata(b, s.expanded_bytes), m = z.read('manifest.json', s.manifest);
    filePins(m.files, 'archive manifest');
    assert(same([...z.entries.keys()].sort(), ['manifest.json', ...Object.keys(m.files)].sort()), 'archive inventory differs');
    for (const [name, expected] of Object.entries(m.files)) assert(z.entries.get(name)?.size === expected.bytes, 'archive member size differs');
    return { z, m };
  }
  const l = input('language'), lang = await manifest(l);
  assert(lang.schema === 'poe2-retained-locale-publication/v1' && same(lang.target, d.target), 'language target/schema differs');
  filePins(lang.files, 'language files');
  for (const [name, p] of Object.entries(lang.files)) {
    assert(/^(?:i18n\/(?:zh-CN|zh-TW)|evidence)\/[A-Za-z0-9._-]+\.json$/u.test(name), 'language inventory path differs');
    assert(await reader.stat(l.revision, path.posix.join(path.posix.dirname(l.path), name)) === p.bytes, 'language member missing or size differs');
  }
  const cn = ['_meta', 'base_items', 'classes', 'display_texts', 'mods', 'passive_names', 'rare_words', 'skills', 'stat_lines', 'words'];
  assert(cn.every(n => lang.files[`i18n/zh-CN/${n}.json`]) && ['base_items', 'mods', 'skills'].every(n => lang.files[`i18n/zh-TW/${n}.json`]), 'language: incomplete locale inventory');
  assert(RETAINED_EVIDENCE.every(n => lang.files[n]), 'language: missing retained source evidence');
  const { z: cz, m: catalog } = await archive(input('display_catalog'));
  assert(catalog.schema === 'poe2-native-catalog-manifest/v3' && catalog.status === 'candidate' && catalog.production_ready === false
    && same(catalog.target_identity, d.target) && ['game', 'game_patch', 'realm'].every(k => catalog[k] === d.target[k])
    && catalog.locale === 'zh-CN' && catalog.binding_policy === 'stable-key-pinned-fk-structure/v1', 'catalog target/schema/scope differs');
  assert(catalog.observed_client?.game_patch === null && catalog.observed_client?.realm === null
    && same(lang.observed_sc_client, { patch: null, realm: null }), 'observed client scope differs; no target inference allowed');
  const request = cz.read('request.json', catalog.files['request.json']);
  assert(request.schema === 'poe2-native-catalog-request/v3' && request.localized?.sha256 === d.bindings.display_source.manifest.sha256, 'source-catalog binding differs');
  const v = d.evidence.catalog_validation;
  const validation = await load(v, v.path, { bytes: v.bytes, sha256: v.sha256 });
  assert(validation.format === 'windows-fk-validation/v1' && validation.manifest_sha256 === input('display_catalog').manifest.sha256
    && same(validation.files, catalog.files) && validation.independent_fk_recomputed === true
    && same(validation.boundaries, { observed_patch: null, observed_realm: null, official_client_semantics_verified: false, production_ready: false }), 'catalog completed validation evidence differs');
  assert(lang.catalog_sha256 === catalog.files['catalog.json'].sha256, 'language-catalog binding differs');
  const lib = input('display_library');
  assert(same(Object.keys(catalog.producer).sort(), [...LIBRARY].sort()), 'catalog producer closure differs');
  for (const [name, p] of Object.entries(lib.files)) {
    assert(catalog.producer[name] === p.sha256, 'catalog-library producer binding differs'); await reader.read(lib.revision, name, p);
  }
  const s = input('reviewed_supplement'), { z: sz, m: supplement } = await archive(s);
  assert(supplement.schema === 'poe2-reviewed-native-supplements-manifest/v1' && supplement.status === 'candidate' && supplement.production_ready === false, 'supplement schema/scope differs');
  const runtime = sz.read('supplements.json', supplement.files['supplements.json']);
  assert(runtime.schema === 'poe2-reviewed-native-supplements/v1' && runtime.status === 'candidate' && runtime.production_ready === false
    && same(runtime.sources, [{ ...d.target, locale: 'zh-CN', catalog_sha256: lang.catalog_sha256, verification: catalog.files['verification.json'] }])
    && Array.isArray(runtime.records) && runtime.records.every(r => r.status === 'reviewed' && ['agent', 'human'].includes(r.origin) && text(r.review?.by) && text(r.review?.note)), 'supplement catalog/review binding differs');
  assert(object(lang.reviewed_supplement) && same(lang.reviewed_supplement, { revision: s.revision, path: s.path, bytes: s.bytes, sha256: s.sha256, records: runtime.records.length }), 'language-supplement binding differs');
  const w = input('workbench'); await reader.read(w.revision, w.file, { bytes: w.bytes, sha256: w.sha256 });
  assert(supplement.producer?.['translation-workbench.mjs'] === w.sha256, 'workbench producer binding differs');
  for (const [name, p] of Object.entries(lib.files)) assert(supplement.producer?.[path.posix.basename(name)] === p.sha256, 'supplement library binding differs');
  const support = input('support_display'), sm = await manifest(support);
  assert(sm.schema === 'poe2-support-display-publication/v1' && sm.locale === 'zh-CN'
    && same(sm.target, { game: d.target.game, version: d.target.game_patch, realm: d.target.realm })
    && sm.catalog_sha256 === support.catalog_sha256 && sm.provenance?.generation_data_version === support.source_data_version
    && same(sm.files, { 'supportDescriptions.zh-CN.json': support.asset }), 'support target/catalog/provenance binding differs');
  assert(await reader.stat(support.revision, path.posix.join(path.posix.dirname(support.path), 'supportDescriptions.zh-CN.json')) === support.asset.bytes, 'support asset missing or size differs');
  const g = input('locale_generation');
  for (const [name, p] of Object.entries(g.producer.files)) await reader.read(g.revision, name, p);
  const gm = await load(g, g.input_manifest.path, { bytes: g.input_manifest.bytes, sha256: g.input_manifest.sha256 });
  assert(gm.schema === 'poe2-locale-generation-input/v1' && gm.profile === 'retained-selected' && same(gm.target, d.target), 'generation target/profile differs');
  filePins(gm.expected_files, 'generation outputs');
  assert(same(Object.keys(gm.expected_files).sort(), [...cn.filter(n => n !== 'display_texts').map(n => `i18n/zh-CN/${n}.json`), 'generated/translation-audit.json'].sort()), 'generation: incomplete output inventory');
  for (const [name, p] of Object.entries(lang.files).filter(([n]) => n.startsWith('i18n/zh-CN/') && !n.endsWith('/display_texts.json'))) {
    assert(same(gm.expected_files[name], p), 'generation-language output binding differs');
  }
  assert(fullrev(gm.identity?.dictionary?.commit) && fullrev(gm.identity?.translation?.commit)
    && [gm.identity.dictionary.repository, gm.identity.translation.repository].every(r => typeof r === 'string' && /^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/u.test(r))
    && /^[0-9TZ]+$/u.test(gm.identity.translation.snapshot ?? '')
    && gm.identity.translation.mode === 'pinned' && gm.identity.translation.sha256 === gm.inputs?.['templates.json']?.sha256, 'generation source identity differs');
  assert(object(gm.inputs) && same(Object.keys(gm.inputs).sort(), [...DICTIONARY, 'templates.json', ...GENERATION_EVIDENCE].sort()), 'generation: incomplete input inventory');
  for (const [name, p] of Object.entries(gm.inputs)) {
    safePath(name); pin({ bytes: p.bytes, sha256: p.sha256 }, 'generation input');
    if (name.startsWith('evidence/')) {
      assert(p.source?.repository === `https://github.com/${OWNER}` && p.source.revision === 'producer-commit', 'generation evidence source differs');
      await reader.read(g.revision, p.source.path, { bytes: p.bytes, sha256: p.sha256 });
    } else {
      const id = name === 'templates.json' ? gm.identity.translation : gm.identity.dictionary;
      assert(text(p.source?.url) && p.source.url.startsWith(id.repository.replace('https://github.com/', 'https://raw.githubusercontent.com/') + `/${id.commit}/`), 'generation source URL is not pinned to identity');
    }
  }
}

function transition(next, previous, previousPin) {
  assert(next.sequence === previous.sequence + 1 && same(next.previous, previousPin), 'publication sequence or predecessor differs');
  assert(next.target.game === previous.target.game && next.target.realm === previous.target.realm, 'publication channel differs');
  for (const r of ROLES) {
    const a = next.components[r], b = previous.components[r];
    assert(a.sequence === b.sequence + (same(a.input, b.input) ? 0 : 1), `${r}: role sequence must advance only for changed input`);
  }
  assert(ROLES.some(r => !same(next.components[r].input, previous.components[r].input)), 'publication has no changed role input');
}
async function checkHead(head, reader) {
  gitPin(head, 'head');
  const seen = new Set(); let current = head, first;
  for (let n = 0; n < 1024; n++) {
    const key = JSON.stringify(current); assert(!seen.has(key), 'predecessor cycle'); seen.add(key);
    const raw = await reader.read(current.revision, current.path, { bytes: current.bytes, sha256: current.sha256 });
    const d = validateDescriptor(raw);
    assert(current.path === `publication/releases/poe2-international/${d.sequence}.json`, 'descriptor path/sequence differs');
    if (!first) first = d;
    await verifyDeclarations(d, reader);
    if (d.sequence === 1) return first;
    const pb = await reader.read(d.previous.revision, d.previous.path, { bytes: d.previous.bytes, sha256: d.previous.sha256 });
    const prev = validateDescriptor(pb); transition(d, prev, d.previous); current = d.previous;
  }
  throw new Error('predecessor chain exceeds 1024');
}

// Check every filesystem path segment; no FIFO, final/ancestor symlink, or escape.
async function localPath(repo, relative) {
  safePath(relative); const root = path.resolve(repo), parts = [...root.split(path.sep).filter(Boolean), ...relative.split('/')];
  let current = path.parse(root).root;
  for (let n = 0; n < parts.length; n++) {
    current = path.join(current, parts[n]);
    try {
      const s = await lstat(current);
      assert(!s.isSymbolicLink() && (n === parts.length - 1 ? s.isFile() : s.isDirectory()), 'non-regular or symlink publication path');
    } catch (e) { if (e.code === 'ENOENT' && n === parts.length - 1) return current; throw e; }
  }
  return current;
}
async function readIndex(repo, indexPath) {
  const file = await localPath(repo, indexPath);
  let fd;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const s = await fd.stat(); assert(s.isFile() && s.size <= META_LIMIT, 'invalid index file');
    const b = await fd.readFile(); assert(b.length === s.size, 'index changed while reading'); return b;
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; } finally { await fd?.close(); }
}
export async function checkPublication({ repo = '.', indexPath = 'publication/index.json' } = {}) {
  const b = await readIndex(repo, indexPath); assert(b, 'publication index missing');
  const i = validateIndex(b), d = await checkHead(i.head, gitReader(repo));
  assert(i.sequence === d.sequence, 'index/descriptor sequence differs');
  return { index: i, descriptor: d };
}

/** Register committed, available declarations; validation failures never replace the index. */
export async function registerPublication({ repo = '.', head, indexPath = 'publication/index.json' }) {
  const file = await localPath(repo, indexPath);
  // An exclusive local writer lock plus re-read protects concurrent registrations.
  const lock = `${file}.lock`; let fd;
  try { fd = await open(lock, 'wx'); } catch (e) { throw new Error(`publication writer lock: ${e.message}`); }
  let temporary;
  try {
    const before = await readIndex(repo, indexPath), reader = gitReader(repo), d = await checkHead(head, reader);
    if (before) {
      const old = validateIndex(before), previous = await checkHead(old.head, reader);
      assert(old.sequence === previous.sequence, 'existing index/descriptor sequence differs');
      if (d.sequence === old.sequence) {
        assert(same(head, old.head), 'same publication sequence has different content/pin');
        return { changed: false, index: old, descriptor: d };
      }
      transition(d, previous, old.head);
    } else assert(d.sequence === 1, 'bootstrap index requires sequence 1');
    const index = { schema: 'owned-data-publication-index/v2', channel: { game: d.target.game, realm: d.target.realm }, sequence: d.sequence, head };
    const bytes = json(index); validateIndex(bytes);
    temporary = `${file}.${randomUUID()}.tmp`;
    const out = await open(temporary, 'wx');
    try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
    assert(same(await readIndex(repo, indexPath), before), 'publication index changed during registration');
    await localPath(repo, indexPath); await rename(temporary, file); temporary = undefined;
    return { changed: true, index, descriptor: d };
  } finally {
    if (temporary) await unlink(temporary);
    await fd.close(); await unlink(lock);
  }
}

/** Copy full consumer declarations verbatim; derive evidence only from pinned Git. */
export async function bootstrapPublication({ repo = '.', buildLock, importsLock, localeGenerationLock }) {
  const b = strictJson(buildLock), i = strictJson(importsLock), g = strictJson(localeGenerationLock);
  assert(b.schema === 'pobr-build-data-lock/v2' && i.schema === 'pobr-data-import-lock/v1' && g.schema === 'pobr-locale-generation-lock/v1', 'bootstrap lock schema differs');
  assert(same(b.target, i.target) && same(b.target, g.target), 'bootstrap lock targets differ');
  const inputs = { language: b.packages?.language, display_catalog: i.packages?.translation, display_library: i.library,
    reviewed_supplement: i.packages?.supplement, workbench: i.workbench, support_display: b.support_display, locale_generation: g };
  const reader = gitReader(repo), c = inputs.display_catalog;
  identity(c, 'catalog'); safePath(c.path);
  const p = path.posix.join(path.posix.dirname(c.path), 'validation.json');
  const validation = await reader.read(c.revision, p);
  const d = { schema: 'owned-data-publication/v2', owner: OWNER, target: b.target, sequence: 1, previous: null, scope: SCOPE,
    components: Object.fromEntries(ROLES.map(r => [r, { sequence: 1, input: inputs[r] }])),
    bindings: { display_source: i.packages?.repoe }, evidence: { catalog_validation: { revision: c.revision, path: p, ...bytePin(validation) } } };
  validateDescriptor(json(d)); await verifyDeclarations(d, reader); return d;
}

async function main(args) {
  const command = args.shift(), options = {};
  assert(['bootstrap', 'check', 'register'].includes(command), 'usage: publication-index.mjs bootstrap|check|register [--key value]');
  const allowed = { bootstrap: ['repo', 'build-lock', 'imports-lock', 'locale-generation-lock', 'out'], check: ['repo', 'index'], register: ['repo', 'index', 'revision', 'path', 'bytes', 'sha256'] }[command];
  for (let n = 0; n < args.length; n += 2) {
    const key = args[n]?.slice(2);
    assert(args[n]?.startsWith('--') && allowed.includes(key) && !Object.hasOwn(options, key) && text(args[n + 1]), 'invalid or duplicate CLI option'); options[key] = args[n + 1];
  }
  const repo = options.repo ?? '.';
  if (command === 'check') { const r = await checkPublication({ repo, indexPath: options.index }); console.log(JSON.stringify({ status: 'valid-declarations', sequence: r.index.sequence, head: r.index.head })); }
  if (command === 'register') {
    assert(/^[1-9][0-9]*$/u.test(options.bytes ?? ''), 'integer --bytes required');
    const r = await registerPublication({ repo, indexPath: options.index, head: { revision: options.revision, path: options.path, bytes: Number(options.bytes), sha256: options.sha256 } });
    console.log(JSON.stringify({ status: r.changed ? 'registered' : 'unchanged', ...r.index }));
  }
  if (command === 'bootstrap') {
    assert(['build-lock', 'imports-lock', 'locale-generation-lock', 'out'].every(k => text(options[k])), 'bootstrap requires all three locks and --out');
    assert(options.out === 'publication/releases/poe2-international/1.json', 'bootstrap output must be the sequence 1 descriptor path');
    const readLock = async file => {
      const resolved = path.resolve(file), raw = await readIndex(path.dirname(resolved), path.basename(resolved));
      assert(raw, `missing lock: ${file}`); return raw;
    };
    const d = await bootstrapPublication({ repo, buildLock: await readLock(options['build-lock']), importsLock: await readLock(options['imports-lock']), localeGenerationLock: await readLock(options['locale-generation-lock']) });
    const file = await localPath(repo, options.out), out = await open(file, 'wx');
    // Output is a candidate descriptor, never a success index; do not overwrite it.
    try { await out.writeFile(json(d)); } catch (e) { await unlink(file); throw e; } finally { await out.close(); }
    console.log(JSON.stringify({ status: 'bootstrap-candidate', path: options.out, ...bytePin(json(d)) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
