// pobr:supplement-lines — PoBR's i18n/<locale>/stat_lines.json from a pinned base member plus this
// project's reviewed curation/display-supplements.json (poe2-display-supplements/v1):
// 0. official (optional, zh-CN): China-client stat description text from pinned RePoE input packages,
//    newest first, applied over the base per English (src/pobr/official-lines.mjs); the result is the
//    base of steps 1 and 2, and a correction whose English that layer supplies is not applied
//    (superseded-by-official), except a format-only repair of official text;
// 1. corrections: each reviewed row {from, to} replaces the exact base pair `from` with `to`;
// 2. entries: each reviewed stat-line entry whose English is a current template of the pinned game
//    package (same stat ids) and that the base has no row for is appended as {src, en, origin}.
// Every row this producer adds or changes carries `origin` (agent | human); base rows stay
// byte-identical and carry none. Official (base) text always wins over an entry. With a base
// _meta.json it also writes _meta.json with a `supplements` block that pins only data, never code.
// Output: a fresh .cache candidate (stat_lines.json[, _meta.json], receipt.json); nothing is adopted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../release/stored-zip.mjs';
import { strictJson } from '../strict-json.mjs';
import { SCHEMA, statTemplates, validateSupplements } from './display-supplements.mjs';
import { OFFICIAL_REALMS, officialLayer, readOfficialSource, validateOfficialSpec } from './official-lines.mjs';
import { HEX64, parseRequiredArgs, pinOf, readPinned as readPinnedFile, sha256 as digest } from './pinned.mjs';

export const REQUEST_SCHEMA = 'pobr-supplement-lines-request/v1';
export const RECEIPT_SCHEMA = 'pobr-supplement-lines-receipt/v1';
const IMPLEMENTATION = ['supplement-lines.mjs', 'display-supplements.mjs', 'official-lines.mjs', 'pinned.mjs'];
// The one correction basis that still applies over official text: it changes only the layout of that
// text (a stray backslash where a line break belongs), never its wording.
const FORMAT_REPAIR = 'official-typo-format-fix';
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = (ok, message) => { if (!ok) throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pairKey = row => JSON.stringify([row.src, row.en]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const descriptionsMember = patch => `data/${patch}/overlay/stat_descriptions.json`;

function count(map, ...parts) {
  let node = map;
  for (const key of parts.slice(0, -1)) node = node[key] ??= {};
  node[parts.at(-1)] = (node[parts.at(-1)] ?? 0) + 1;
}

/**
 * Pure core. base: [{src, en}] (sorted, distinct); supplements: a validated display-supplements
 * document; templates: Map english -> sorted stat ids; target: {game_patch, realm, locale};
 * game: {sha256, stat_descriptions_sha256} of the pinned package (for needs-review flags);
 * official: the Set of English the current official layer supplies (officialLayer().english), when
 * `base` is that layer's output.
 */
export function supplementLines(base, supplements, templates, target, game, official = null) {
  validateSupplements(supplements);
  // A base is a layer without our marks: an output of this producer is never a base (its edits are
  // cumulative, so apply them to that output's own base instead).
  require(Array.isArray(base) && base.every(row => object(row) && typeof row.src === 'string' && typeof row.en === 'string'
    && Object.keys(row).length === 2), 'base stat_lines.json must be an array of {src, en} without origin');
  const rows = new Map(), rowsByEn = new Map();
  const addRow = (key, row) => {
    rows.set(key, row);
    let bucket = rowsByEn.get(row.en);
    if (!bucket) rowsByEn.set(row.en, bucket = new Map());
    bucket.set(key, row);
  };
  const deleteRow = (key, en) => {
    rows.delete(key);
    const bucket = rowsByEn.get(en);
    if (!bucket) return;
    bucket.delete(key);
    if (!bucket.size) rowsByEn.delete(en);
  };
  for (const row of base) addRow(pairKey(row), row);
  require(rows.size === base.length, 'base stat_lines.json repeats a pair');
  const corrections = [], entries = [], counts = {};
  for (const correction of supplements.corrections) {
    const applies = correction.locale === target.locale && correction.status === 'reviewed';
    for (const { from, to } of correction.rows) {
      const fromKey = pairKey(from), toKey = pairKey(to);
      let decision;
      if (!applies) decision = correction.locale === target.locale ? correction.status : 'other-locale';
      else if (official && (official.has(from.en) || official.has(to.en)) && !rows.has(toKey)
        && correction.basis !== FORMAT_REPAIR) {
        // The current official text decides this English; our edit of it is kept in curation, never shipped.
        decision = 'superseded-by-official';
      } else if (official && (official.has(from.en) || official.has(to.en)) && rows.has(toKey)) {
        // The current official text already has the corrected pair (a revised-partial English can hold
        // both `from` and `to`): nothing to apply, and official rows are never replaced by ours.
        decision = 'already-in-base';
      } else if (rows.has(fromKey) && to.en !== from.en && rowsByEn.has(to.en)) {
        // A correction of the English key gives way to a row the base already has for that English,
        // as an entry does; it never adds a second row for one English.
        decision = 'superseded';
      } else if (rows.has(fromKey)) {
        require(!rows.has(toKey), `${correction.correction_id}: ${JSON.stringify(to.en)} already has the corrected pair`);
        deleteRow(fromKey, from.en);
        addRow(toKey, { src: to.src, en: to.en, origin: correction.origin });
        decision = 'applied';
      } else if (rows.has(toKey)) decision = 'already-in-base';
      // The base no longer has the pair: its text changed upstream (the base wins) or the line is gone.
      else decision = rowsByEn.has(from.en) ? 'superseded' : 'retired';
      count(counts, 'corrections', decision);
      corrections.push({ correction_id: correction.correction_id, from, to, decision });
    }
  }
  // English the base itself supplies (rows without origin) and English only our corrections supply.
  const english = new Set(), corrected = new Set();
  for (const row of rows.values()) (row.origin ? corrected : english).add(row.en);
  const added = new Map();
  for (const entry of supplements.entries) {
    const { identity } = entry;
    if (identity.kind !== 'stat-line') continue;
    const decision = { entry_id: entry.entry_id, english: identity.english, origin: entry.origin, status: entry.status };
    const stats = templates.get(identity.english);
    const current = stats && JSON.stringify(stats) === JSON.stringify(identity.stats);
    if (identity.locale !== target.locale || identity.realm !== target.realm) decision.lifecycle = 'other-target';
    else if (!current) decision.lifecycle = 'retired';
    else if (entry.status !== 'reviewed') decision.lifecycle = entry.status;
    else if (english.has(identity.english)) {
      // Base text wins; the supplement is kept in curation and recorded, never shipped over it.
      const shipped = [...(rowsByEn.get(identity.english)?.values() ?? [])].map(row => row.src).sort(compare);
      Object.assign(decision, { lifecycle: 'official', supplement_differs: !shipped.includes(entry.text), base: shipped });
    } else if (corrected.has(identity.english)) {
      // One of our own corrected rows already supplies this English; the entry is not shipped beside it.
      const shipped = [...(rowsByEn.get(identity.english)?.values() ?? [])].map(row => row.src).sort(compare);
      Object.assign(decision, { lifecycle: 'covered-by-correction', supplement_differs: !shipped.includes(entry.text), correction: shipped });
    } else {
      require(!added.has(identity.english), `Two reviewed entries supplement ${JSON.stringify(identity.english)}`);
      added.set(identity.english, { src: entry.text, en: identity.english, origin: entry.origin });
      decision.lifecycle = 'supplemented';
    }
    if (current && (entry.based_on.game_package.sha256 !== game.sha256
      || entry.based_on.stat_descriptions_sha256 !== game.stat_descriptions_sha256)) decision.needs_review = 'based_on differs from the pinned game package';
    count(counts, 'entries', decision.lifecycle);
    entries.push(decision);
  }
  for (const row of added.values()) {
    const key = pairKey(row);
    require(!rows.has(key), 'duplicate supplemented pair');
    addRow(key, row);
  }
  const lines = [...rows.values()].sort((a, b) => compare(a.src, b.src) || compare(a.en, b.en));
  const origins = {};
  for (const row of lines) if (row.origin) count(origins, row.origin);
  return { lines, corrections, entries, counts: { ...counts, rows: lines.length, base_rows: base.length, with_origin: origins } };
}

// The `supplements` block of _meta.json. Data pins and counts only: an implementation hash here
// would make every later code edit change a published member.
export function metaBlock({ edits, base, game, result, official = false }) {
  const corrected = result.corrections.filter(row => row.decision === 'applied');
  const byId = rows => [...new Set(rows.map(row => row.correction_id))].map(id => ({ correction_id: id,
    rows: rows.filter(row => row.correction_id === id).length }));
  const superseded = result.corrections.filter(row => row.decision === 'superseded-by-official');
  return {
    schema: SCHEMA,
    edits: { bytes: edits.bytes, sha256: edits.sha256 },
    base_stat_lines: { bytes: base.bytes, sha256: base.sha256 },
    game_package: { repository: game.repository, tag: game.tag, asset: game.asset, bytes: game.bytes, sha256: game.sha256,
      stat_descriptions_sha256: game.stat_descriptions_sha256 },
    producer: 'pobr:supplement-lines',
    stat_lines: {
      corrected: byId(corrected),
      ...(official ? { superseded_by_official: byId(superseded) } : {}),
      supplemented: result.entries.filter(entry => entry.lifecycle === 'supplemented').length,
      with_origin: result.counts.with_origin,
    },
    origin: 'A stat_lines.json row with an origin field (agent or human) is this project\'s supplement or correction, never official text.',
  };
}

// The `official` block of _meta.json: which official sources the stat lines were checked against, in
// precedence order (newest first), with their pins and counts. Rows stay {src, en}; which source
// decided each English is in the receipt only.
export function officialBlock(locale, sources, layer) {
  return {
    locale,
    precedence: 'official sources in order (the first that supplies an English decides it), then the base, then supplements',
    sources: sources.map((source, index) => ({ ...source, counts: layer.counts.sources[index] })),
    counts: layer.counts.total,
  };
}

function readPinned(spec, label, reads) {
  require(object(spec) && typeof spec.file === 'string' && HEX64.test(spec.sha256 ?? '') && Number.isSafeInteger(spec.bytes),
    `${label}: needs {file, bytes, sha256}`);
  const raw = readPinnedFile(spec.file, spec.sha256, { bytes: spec.bytes, label });
  reads[label] = pinOf(raw);
  return raw;
}

export function validateRequest(request) {
  require(object(request) && request.schema === REQUEST_SCHEMA, `expected a ${REQUEST_SCHEMA} request`);
  const allowed = ['schema', 'target', 'base', 'meta', 'game_package', 'edits', 'official'];
  require(Object.keys(request).every(key => allowed.includes(key)), `request: fields are ${allowed.join(', ')}`);
  const { target } = request;
  require(object(target) && target.game === 'poe2' && typeof target.game_patch === 'string' && target.game_patch
    && typeof target.realm === 'string' && typeof target.locale === 'string', 'request.target needs game poe2, game_patch, realm, locale');
  const game = request.game_package;
  require(object(game) && typeof game.repository === 'string' && typeof game.tag === 'string'
    && game.asset === `pobr-game-${target.game_patch}.zip`, `request.game_package needs repository, tag and asset pobr-game-${target.game_patch}.zip`);
  if (request.official !== undefined) {
    require(OFFICIAL_REALMS[target.locale], `request.official: no official stat-line source for ${target.locale}`);
    require(Array.isArray(request.official) && request.official.length, 'request.official lists the official sources, newest first');
    request.official.forEach((spec, index) => validateOfficialSpec(spec, `request.official[${index}]`));
    require(new Set(request.official.map(spec => spec.sha256)).size === request.official.length, 'request.official repeats a source');
    // Its provenance belongs in _meta.json next to the supplements block.
    require(request.meta, 'request.official needs the base meta (the official block is written to _meta.json)');
  }
  return request;
}

export async function createSupplementLines(request, out) {
  validateRequest(request);
  const reads = {};
  const baseRaw = readPinned(request.base, 'base', reads);
  const metaRaw = request.meta ? readPinned(request.meta, 'meta', reads) : null;
  const editsRaw = readPinned(request.edits, 'edits', reads);
  const zipRaw = readPinned(request.game_package, 'game_package', reads);
  const member = descriptionsMember(request.target.game_patch);
  const descriptions = readZip(zipRaw, name => name === member).get(member)?.raw;
  require(descriptions, `game_package: ${member} is not in the archive`);
  const game = { ...request.game_package, ...pinOf(zipRaw), stat_descriptions_sha256: digest(descriptions) };
  delete game.file;
  const output = path.resolve(out), cache = path.join(REPO_ROOT, '.cache');
  require(output.startsWith(cache + path.sep) && !fs.existsSync(output), 'Output must be a fresh repository cache candidate');
  require(fs.realpathSync(path.dirname(output)) === path.dirname(output), 'Output parent contains a symlink');
  const templates = statTemplates(JSON.parse(descriptions));
  let base = strictJson(baseRaw), layer = null, official = null;
  if (request.official) {
    const sources = [];
    for (const [index, spec] of request.official.entries()) {
      const label = `official[${index}]`;
      const read = await readOfficialSource(readPinned(spec, label, reads), spec, request.target.locale);
      sources.push(read);
    }
    layer = officialLayer(base, sources.map(read => read.texts), templates);
    official = officialBlock(request.target.locale, sources.map(read => read.source), layer);
    base = layer.lines;
  }
  const result = supplementLines(base, strictJson(editsRaw), templates, request.target, game, layer?.english ?? null);
  fs.mkdirSync(output);
  const files = {};
  const write = (name, text) => {
    fs.writeFileSync(path.join(output, name), text, { flag: 'wx' });
    files[name] = pinOf(Buffer.from(text));
  };
  // Same serialization as the base member (two-space JSON and a final newline).
  write('stat_lines.json', JSON.stringify(result.lines, null, 2) + '\n');
  if (metaRaw) {
    const meta = strictJson(metaRaw);
    require(object(meta) && !Object.hasOwn(meta, 'supplements') && !Object.hasOwn(meta, 'official'),
      'meta: base _meta.json already has a supplements or official block');
    write('_meta.json', JSON.stringify({ ...meta, ...(official ? { official } : {}),
      supplements: metaBlock({ edits: reads.edits, base: reads.base, game, result, official: Boolean(official) }) }, null, 2) + '\n');
  }
  const receipt = {
    schema: RECEIPT_SCHEMA, adoption: 'not-adopted', request, inputs: reads,
    game_package: { ...game, member }, files,
    implementation: Object.fromEntries(IMPLEMENTATION.map(file =>
      [`src/pobr/${file}`, digest(fs.readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url))))])),
    counts: result.counts, corrections: result.corrections, entries: result.entries,
    ...(official ? { official: { ...official, decisions: layer.decisions.map(row => row.decision === 'confirmed'
      ? { english: row.english, decision: row.decision, source: row.source } : row) } } : {}),
    scope: 'Base rows are kept byte for byte unless the official layer revises their English or a reviewed correction names the exact pair; every added or corrected row of ours carries origin. Official text (the official layer, then the base) wins over a supplement. No conversion to other locales, no calculation, no CURRENT adoption.',
  };
  write('receipt.json', JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { request: file, out } = parseRequiredArgs(process.argv.slice(2), ['request', 'out'], {
    invalidMessage: 'Usage: --request file.json --out .cache/fresh',
    missingMessage: 'Usage: --request file.json --out .cache/fresh',
  });
  createSupplementLines(JSON.parse(fs.readFileSync(file, 'utf8')), out).then(receipt => {
    console.log(JSON.stringify({ files: receipt.files, counts: receipt.counts, ...(receipt.official ? { official: receipt.official.counts } : {}) }));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
