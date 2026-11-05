// The official layer of pobr:supplement-lines: China-client stat description text, read by the frozen
// native-localization reader (src/native-localization.mjs, called unchanged) from a pinned RePoE input
// package, applied over the historical base stat_lines.json per English before any supplement.
//
// Precedence for one English, top wins:
// 1. the official sources, newest first: the first source whose pairs supply an English decides it;
// 2. the historical base (older official China text; rows without origin);
// 3. this project's supplements (pobr:supplement-lines), which never override 1 or 2.
//
// Per English of a source (rows are {src: plain(Chinese), en: plain(English)}):
// - confirmed: the source's set of texts equals the base's;
// - revised (revised-partial when the sets share a text): the source's rows replace the base rows;
// - kept-pairing-incomplete: the base differs, but the frozen reader excluded a branch of that
//   English, so the source's set may be missing an alternative; the base stays;
// - added: the base lacks the English, it is a current template of the pinned game package and its
//   stat ids are among the template's;
// - skipped-not-game-template / skipped-other-stats: the base lacks the English and the game package
//   has no such template (or not with these stats); nothing is added;
// - skipped-unresolved-markup: a bracket is left in the English or a text after plain(); the base
//   (if any) stays.
// Base English no source supplies stays as it is (kept-historical).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildNativeLocalization, readNativeDescriptions } from '../native-localization.mjs';
import { readZip } from '../release/stored-zip.mjs';
import { strictJson } from '../strict-json.mjs';

export const INPUT_SCHEMA = 'repoe-release-input/v1';
export const CAPTURE_RECEIPT_SCHEMA = 'repoe-client-capture-receipt/v1';
// The source-lock evidence kind that pins RePoE's client:capture receipt.
const CAPTURE_EVIDENCE = 'client-capture-receipt';
// The frozen reader accepts exactly these four files in a directory.
export const NATIVE_FILES = ['descriptions.json', 'diagnostics.json', 'manifest.json', 'source-lock.json'];
// The reader pairs the implicit default (English) with Simplified Chinese only, and only the China
// client's Simplified Chinese is official zh-CN.
export const OFFICIAL_REALMS = { 'zh-CN': 'china' };
export const CLASSES = ['confirmed', 'revised', 'revised-partial', 'kept-pairing-incomplete', 'added',
  'skipped-not-game-template', 'skipped-other-stats', 'skipped-unresolved-markup'];
const HEX64 = /^[0-9a-f]{64}$/u;
const require = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pairKey = row => JSON.stringify([row.src, row.en]);

// The repository's display form of a CSD template (as src/pobr/native-selected-translations.mjs):
// `[A|B]` -> B, `[A]` -> A, a literal `\n` -> a line break. Placeholders stay as they are. Unlike
// that module, an empty label is allowed: the China client writes `[Flask|]` for a keyword link that
// shows no text (`…附加相当于[Flask|]药剂回复量…`), so it becomes the empty string.
export const plain = text => text.replace(/\[([^\]|]+)(?:\|([^\]]*))?\]/gu, (_, id, label) => label ?? id)
  .replace(/\\n/gu, '\n');
// A bracket left after plain() is a markup form this layer does not know; such an English never ships.
const unresolved = text => /[[\]]/u.test(text);

/**
 * One source's texts from the frozen reader's output: {texts: Map english -> Set chinese,
 * stats: Map english -> Set stat id, incomplete: Set english}. `incomplete` is every English of a
 * default branch the reader excluded, directly or with its whole record (its pairing in that record
 * is unknown).
 */
export function officialTexts(candidate, document) {
  const texts = new Map(), stats = new Map(), incomplete = new Set();
  for (const pair of candidate.pairs) {
    const en = plain(pair.default_template_raw), src = plain(pair.chinese_template_raw);
    if (!texts.has(en)) { texts.set(en, new Set()); stats.set(en, new Set()); }
    texts.get(en).add(src);
    for (const id of pair.stat_ids) stats.get(en).add(id);
  }
  for (const excluded of candidate.excluded) {
    if (excluded.default_refs) {
      for (const ref of excluded.default_refs) {
        const branch = document.files[ref.file]?.records[ref.record]?.groups[ref.group]?.branches[ref.branch];
        require(typeof branch?.template_raw === 'string', `excluded reference ${JSON.stringify(ref)} is not a branch`);
        incomplete.add(plain(branch.template_raw));
      }
      continue;
    }
    // A record excluded as a whole (nonunique-implicit-default, missing-simplified-chinese-group)
    // names no branch: every branch of its default groups is unpaired.
    const record = document.files[excluded.file]?.records[excluded.record];
    require(Array.isArray(record?.groups), `excluded record ${JSON.stringify([excluded.file, excluded.record])} is not a record`);
    for (const group of record.groups) {
      if (group.declared_language !== null) continue;
      for (const branch of group.branches) {
        require(typeof branch?.template_raw === 'string', `excluded record ${JSON.stringify([excluded.file, excluded.record])} has a branch without template_raw`);
        incomplete.add(plain(branch.template_raw));
      }
    }
  }
  return { texts, stats, incomplete };
}

const emptyCounts = () => ({ official_english: 0, confirmed: 0, revised: 0, revised_partial: 0, kept_pairing_incomplete: 0,
  added: 0, skipped_not_game_template: 0, skipped_other_stats: 0, skipped_unresolved_markup: 0, shadowed: 0 });

/**
 * Pure core. base: [{src, en}] without origin; sources: officialTexts() results, newest first;
 * templates: Map english -> sorted stat ids of the pinned game package. Returns the new base
 * (rows without origin, sorted like the member), the English the official layer ships (`english`),
 * one decision per English any source supplies, and counts per source and in total.
 */
export function officialLayer(base, sources, templates) {
  const byEnglish = new Map();
  for (const row of base) {
    if (!byEnglish.has(row.en)) byEnglish.set(row.en, new Set());
    byEnglish.get(row.en).add(row.src);
  }
  const decided = new Map(), perSource = sources.map(emptyCounts);
  sources.forEach((source, index) => {
    const counts = perSource[index];
    for (const [en, set] of source.texts) {
      counts.official_english++;
      // An older source fills only English the newer sources lack.
      if (decided.has(en)) { counts.shadowed++; continue; }
      const official = [...set].sort(compare), baseTexts = byEnglish.get(en);
      let decision;
      if (unresolved(en) || official.some(unresolved)) decision = 'skipped-unresolved-markup';
      else if (baseTexts) {
        const same = baseTexts.size === set.size && [...set].every(text => baseTexts.has(text));
        if (same) decision = 'confirmed';
        else if (source.incomplete.has(en)) decision = 'kept-pairing-incomplete';
        else decision = [...set].some(text => baseTexts.has(text)) ? 'revised-partial' : 'revised';
      } else {
        const stats = templates.get(en);
        if (!stats) decision = 'skipped-not-game-template';
        else decision = [...source.stats.get(en)].every(id => stats.includes(id)) ? 'added' : 'skipped-other-stats';
      }
      counts[decision.replaceAll('-', '_')]++;
      if (decision === 'revised-partial') counts.revised++;
      decided.set(en, { english: en, decision, source: index, official,
        ...(baseTexts && decision !== 'confirmed' ? { base: [...baseTexts].sort(compare) } : {}) });
    }
  });
  const ships = decision => ['confirmed', 'revised', 'revised-partial', 'added'].includes(decision);
  const replaced = new Set([...decided.values()].filter(row => row.decision.startsWith('revised')).map(row => row.english));
  const rows = new Map(base.filter(row => !replaced.has(row.en)).map(row => [pairKey(row), row]));
  for (const row of decided.values()) {
    if (row.decision.startsWith('revised') || row.decision === 'added') {
      for (const src of row.official) rows.set(pairKey({ src, en: row.english }), { src, en: row.english });
    }
  }
  const lines = [...rows.values()].sort((a, b) => compare(a.src, b.src) || compare(a.en, b.en));
  const decisions = [...decided.values()].sort((a, b) => compare(a.english, b.english));
  const total = emptyCounts();
  for (const counts of perSource) for (const key of Object.keys(total)) total[key] += counts[key];
  delete total.shadowed;
  total.official_english = decided.size;
  total.kept_historical = [...byEnglish.keys()].filter(en => !decided.has(en)).length;
  return { lines, english: new Set(decisions.filter(row => ships(row.decision)).map(row => row.english)), decisions,
    counts: { sources: perSource, total } };
}

// --- pinned input packages -------------------------------------------------------------------------

/** The fields of one official source in a supplement-lines request or recipe job (besides the file). */
export function validateOfficialSpec(spec, label) {
  require(object(spec) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(spec.repository ?? '') && typeof spec.tag === 'string' && spec.tag
    && typeof spec.asset === 'string' && /^[A-Za-z0-9_.-]+\.zip$/u.test(spec.asset)
    && Number.isSafeInteger(spec.bytes) && HEX64.test(spec.sha256 ?? '')
    && typeof spec.member === 'string' && /^(?:[A-Za-z0-9_.-]+\/)+$/u.test(spec.member)
    && spec.member.split('/').slice(0, -1).every(part => part !== '.' && part !== '..') && HEX64.test(spec.manifest_sha256 ?? ''),
  `${label}: needs repository, tag, asset (*.zip), bytes, sha256, member (a directory ending in /) and manifest_sha256`);
  return spec;
}

/**
 * Read one pinned RePoE input package (repoe-release-input/v1: a zip with a root manifest.json that
 * pins every file) and the native descriptions package under `spec.member` through the frozen
 * reader. The member holds exactly the reader's four files, each equal to its root-manifest pin, and
 * its manifest.json equals `spec.manifest_sha256`. Returns {texts, source}: the source's texts and
 * its provenance for _meta.json. When the source lock's acquisition evidence pins a client:capture
 * receipt (kind client-capture-receipt) that the package carries, `source.client` copies its client
 * identity (capture.json SHA-256, index SHA-256, observed executables); the hash chain is the
 * frozen-verified lock evidence, so the receipt is found by its SHA-256, not by a path.
 */
export async function readOfficialSource(zipRaw, spec, locale) {
  const realm = OFFICIAL_REALMS[locale];
  require(realm, `official: no official stat-line source for ${locale}`);
  const prefix = spec.member;
  const archive = readZip(zipRaw, name => name === 'manifest.json' || name.startsWith(prefix));
  const rootRaw = archive.get('manifest.json')?.raw;
  require(rootRaw, `${spec.asset}: no root manifest.json`);
  const root = strictJson(rootRaw);
  require(object(root) && root.schema === INPUT_SCHEMA && object(root.files), `${spec.asset}: expected a ${INPUT_SCHEMA} manifest`);
  const listed = Object.keys(root.files).filter(name => name.startsWith(prefix)).sort();
  const present = [...archive.keys()].filter(name => name.startsWith(prefix)).sort();
  require(JSON.stringify(listed) === JSON.stringify(present)
    && JSON.stringify(listed) === JSON.stringify(NATIVE_FILES.map(name => prefix + name)),
  `${spec.asset}: ${prefix} must hold exactly ${NATIVE_FILES.join(', ')} (listed: ${listed.join(', ')})`);
  for (const name of listed) {
    const raw = archive.get(name).raw, expected = root.files[name];
    require(object(expected) && expected.bytes === raw.length && expected.sha256 === digest(raw), `${spec.asset}: ${name} differs from its manifest pin`);
  }
  require(digest(archive.get(`${prefix}manifest.json`).raw) === spec.manifest_sha256,
    `${spec.asset}: ${prefix}manifest.json differs from the pinned manifest_sha256`);
  const directory = mkdtempSync(path.join(tmpdir(), 'pobr-official-lines-'));
  let read, candidate;
  try {
    for (const name of NATIVE_FILES) writeFileSync(path.join(directory, name), archive.get(prefix + name).raw, { flag: 'wx' });
    archive.clear();
    read = await readNativeDescriptions(directory, spec.manifest_sha256);
    candidate = buildNativeLocalization(read);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const identity = read.manifest.source_identity;
  require(identity.realm === realm, `${spec.asset}: ${prefix} is realm ${identity.realm}; official ${locale} needs realm ${realm}`);
  const client = captureClient(zipRaw, root, identity, spec.asset);
  const texts = officialTexts(candidate, read.document);
  const reasons = {};
  for (const row of candidate.excluded) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  return {
    texts,
    source: {
      realm: identity.realm, repository: spec.repository, tag: spec.tag, asset: spec.asset, bytes: spec.bytes, sha256: spec.sha256,
      member: prefix, manifest_sha256: spec.manifest_sha256,
      ...(object(root.target) ? { package_target: root.target } : {}),
      source_identity: { game: identity.game, game_patch: identity.game_patch, source: identity.source,
        source_lock_sha256: identity.source_lock_sha256, selected_source_sha256: identity.selected_source_sha256,
        acquisition: identity.acquisition },
      ...(client ? { client } : {}),
      reader: { pairs: candidate.summary.pairs, excluded: candidate.summary.excluded,
        excluded_by_reason: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => compare(a, b))) },
    },
  };
}

// The client identity of a client:capture receipt that the lock evidence pins and the package carries.
function captureClient(zipRaw, root, identity, asset) {
  const pinned = (identity.acquisition?.evidence ?? []).filter(item => item?.kind === CAPTURE_EVIDENCE).map(item => item.sha256);
  if (!pinned.length) return null;
  require(pinned.length === 1 && HEX64.test(pinned[0]), `${asset}: the source lock pins more than one ${CAPTURE_EVIDENCE}`);
  const paths = Object.entries(root.files).filter(([, fp]) => fp?.sha256 === pinned[0]).map(([name]) => name).sort();
  if (!paths.length) return null;
  const raw = readZip(zipRaw, name => name === paths[0]).get(paths[0])?.raw;
  require(raw && digest(raw) === pinned[0], `${asset}: ${paths[0]} differs from the pinned capture receipt`);
  // Not strictJson: the receipt's index framing has a 64-bit directory hash beyond the exact JSON
  // number range. Its bytes are pinned by the lock evidence; only string fields are read from it.
  const receipt = JSON.parse(raw.toString('utf8'));
  require(object(receipt) && receipt.schema === CAPTURE_RECEIPT_SCHEMA && object(receipt.observed_client)
    && Array.isArray(receipt.observed_client.executables), `${asset}: ${paths[0]} is not a ${CAPTURE_RECEIPT_SCHEMA}`);
  const observed = receipt.observed_client;
  return {
    capture_receipt: { path: paths[0], sha256: pinned[0] },
    capture_json_sha256: receipt.capture?.capture_json?.sha256 ?? null,
    client_index_sha256: observed.index?.sha256 ?? receipt.index?.sha256 ?? null,
    executables: observed.executables.map(item => ({ name: item.name, file_version: item.file_version, sha256: item.sha256 })),
    declared: { game_patch: receipt.game_patch, realm: receipt.realm, not_verified: receipt.declared_not_verified ?? [] },
  };
}
