// Project this library's verified catalog into PoBR's small display-only
// sidecar (i18n/<locale>/display_texts.json). Pairing and applicability stay in
// the catalog lookup; this projection never joins physical rows, converts a
// locale, renders numeric placeholders, or changes facts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAME_SCOPE, monsterTargets, validateOfficialNames, validateSupplements } from './display-supplements.mjs';
import { readZip } from '../release/stored-zip.mjs';
import { GEM_SCOPES, NAME_SCOPE as TABLE_NAME_SCOPE, gemTargets, pairOfficialTables, readOfficialTables, validateTableSpec } from './official-tables.mjs';

const requireValue = (value, message) => { if (!value) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = entries => Object.fromEntries([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const LIBRARY_FILES = ['src/native-catalog.mjs', 'src/native-names.mjs', 'src/strict-json.mjs'];
const BINDING_LIBRARY_FILES = [...LIBRARY_FILES, 'src/native-catalog-binding.mjs', 'src/native-localization.mjs'];
const FK_LIBRARY_FILES = [...BINDING_LIBRARY_FILES, 'src/native-catalog-fk-binding.mjs'];
// One optional closed module, pinned separately from the official catalog producer
// closure: it only adds reviewed-only supplement lookup, never a new official module.
const REVIEWED_MODULE = 'src/translation-workbench.mjs';
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// PoBR's exact-ID readers live in its web/src/lib/nativeDisplayNames.ts. Other
// fields can supply literal text, but do not need a second per-ID browser index.
// The file is the default for new candidates; a regeneration recipe pins its own
// projection in the request, so editing the file never changes a published member.
const PROJECTION_FILE = 'src/pobr/display-projection.json';
const PROJECTION_PATH = fileURLToPath(new URL('./display-projection.json', import.meta.url));
const defaultProjection = () => JSON.parse(fs.readFileSync(PROJECTION_PATH, 'utf8'));

// {scopes: ["<Table>.<Field>", ...], literals: "all-catalog-conflict-participants"}, nothing else.
export function validateProjection(projection) {
  requireValue(projection !== null && typeof projection === 'object' && !Array.isArray(projection)
    && JSON.stringify(Object.keys(projection).sort()) === '["literals","scopes"]'
    && projection.literals === 'all-catalog-conflict-participants'
    && Array.isArray(projection.scopes) && new Set(projection.scopes).size === projection.scopes.length
    && projection.scopes.every(scope => typeof scope === 'string' && /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/u.test(scope)),
  'Invalid runtime projection');
  return projection;
}
// Without an explicit closure, a v3 catalog runs this checkout's six modules,
// whose hashes still have to equal the manifest's producer closure. v1/v2
// manifests record no producer to compare, so they must name their library.
const localLibrary = () => ({ root: REPO_ROOT, files: Object.fromEntries(FK_LIBRARY_FILES.map(file =>
  [file, digest(fs.readFileSync(path.join(REPO_ROOT, file)))])) });
const strip = text => text.replace(/\[([^\[\]|]+)(?:\|([^\[\]]*))?\]/gu,
  (_, key, label) => label ?? key).trim();

// The origin of a shown value: the reviewed-supplement lookup returns official | agent | human;
// the plain catalog lookup returns none, which is official.
const originOf = result => result.status === 'translated' ? result.origin ?? 'official' : null;
const ours = origin => origin !== null && origin !== 'official';

// Names with no catalog table (MonsterVarieties.Name), both optional:
// - official: a RePoE-decoded official names file (validateOfficialNames);
// - names: a poe2-display-supplements/v1 document whose reviewed monster-name entries are ours;
// - game: {sha256, targets: Map id -> target English | null} from the pinned game package, required
//   with either; catalogIndexSha256: the catalog's observed client, for the official provenance check.
// Precedence per variety id: catalog row, then official name, then our reviewed entry.
// - tables: official client-table rows (official-tables.mjs) {scopes: Map scope -> Map id ->
//   [english, text]}; each scope it holds is owned by it: catalog rows of that scope still give literals
//   and decisions but no per-ID row. MonsterVarieties.Name rows are official names (as `official`).
export function projectDisplayTexts(catalog, lookup, catalogSha256, projection = defaultProjection(),
  { names = null, official = null, game = null, catalogIndexSha256 = null, packageTexts = null, tables = null } = {}) {
  validateProjection(projection);
  const runtimeScopes = new Set(projection.scopes);
  const owned = new Set(tables?.scopes.keys() ?? []);
  for (const scope of owned) requireValue(runtimeScopes.has(scope), `official_tables: ${scope} is not in projection.scopes`);
  requireValue(!(official && owned.has(NAME_SCOPE)), `${NAME_SCOPE} comes from official_names or official_tables, not both`);
  let ownedCatalogRows = 0;
  const scopes = new Map(), identities = new Set(), literalRows = new Map(), decisions = [];
  // Non-official values only; `origins` is written when it is not empty, so a projection without
  // supplements keeps its exact bytes.
  const originScopes = new Map();
  const markScope = (scope, id, origin) => {
    if (!origin || origin === 'official') return;
    if (!originScopes.has(scope)) originScopes.set(scope, new Map());
    originScopes.get(scope).set(id, origin);
  };
  const add = (english, localized, identity, origin = null) => {
    if (!literalRows.has(english)) literalRows.set(english, []);
    literalRows.get(english).push({ localized, identity, origin });
  };
  // Exact scope, identity, current English and the field's complete English context:
  // the supplement lookup requires the declared realm/locale/patch and all three,
  // and the official lookup's own context filter keeps the same row.
  const looked = catalog.records.map(row => [row, lookup({ game_patch: catalog.game_patch, realm: catalog.realm,
    locale: catalog.locale, table: row.table, field: row.field, id: row.id, english: row.english ?? '',
    context: row.context?.english ?? null })]);
  // The official text the package already has for an English string: packageTexts (stat_lines rows
  // without origin, passive_names) and every official catalog value. A supplement (ours, not
  // official) never fills an English that has one, so no renderer can show ours over the official
  // text; it is skipped as if it did not exist and listed in `skipped`.
  const officialCatalog = new Map();
  for (const [row, result] of looked) {
    if (result.status === 'translated' && !ours(originOf(result)) && row.english?.trim() && !officialCatalog.has(row.english)) {
      officialCatalog.set(row.english, { text: result.text, source: 'catalog' });
    }
  }
  // Adopted official table rows count too: our catalog value for the same English never ships as a
  // literal beside them.
  const officialTables = new Map();
  for (const rows of tables?.scopes.values() ?? []) {
    for (const [english, text] of rows.values()) if (!officialTables.has(english)) officialTables.set(english, { text, source: 'official-tables' });
  }
  const officialElsewhere = english => packageTexts?.get(english) ?? officialCatalog.get(english) ?? officialTables.get(english) ?? null;
  const skipped = [];
  for (const [row, result] of looked) {
    let localized = result.status === 'translated' ? result.text : null;
    let origin = originOf(result);
    const identity = [row.table, row.field, row.id];
    if (localized !== null && ours(origin)) {
      requireValue(packageTexts, 'Supplemented display texts need packageTexts (the package\'s official stat_lines and passive_names)');
      const hit = row.english?.trim() ? officialElsewhere(row.english) : null;
      if (hit) {
        skipped.push({ kind: 'catalog', identity, english: row.english, origin, text: localized, official: hit.text, source: hit.source });
        localized = null;
        origin = null;
      }
    }
    decisions.push({ identity, ...result, ...(localized === null && ours(originOf(result)) ? { skipped: 'official-elsewhere' } : {}) });
    const scope = `${row.table}.${row.field}`;
    const key = JSON.stringify([scope, String(row.id)]);
    requireValue(!identities.has(key), 'Duplicate projected display identity');
    identities.add(key);
    if (owned.has(scope)) ownedCatalogRows++;
    else if (runtimeScopes.has(scope)) {
      if (!scopes.has(scope)) scopes.set(scope, new Map());
      scopes.get(scope).set(String(row.id), [row.english, localized]);
      markScope(scope, String(row.id), origin);
    }
    // A rejected v2 group can have no single English value. Every candidate
    // still owns its literal and display alias, blocking other IDs and old
    // dictionaries from silently supplying a translation for that ambiguity.
    for (const english of new Set((row.candidates?.english ?? []).map(candidate => candidate.text))) {
      if (typeof english !== 'string' || !english.trim() || english === row.english) continue;
      add(english, null, identity);
      const alias = strip(english);
      if (alias && alias !== english) add(alias, null, identity);
    }
    if (!row.english?.trim()) continue;
    // Whole literal text only. A caller rendering numeric/implicit slots must
    // use the shared CSD renderer, never substitute captured display numbers here.
    if (!row.templates.english?.syntax_valid || row.templates.english.placeholders.length
      || row.templates.english.hash_slots) continue;
    add(row.english, localized, identity, origin);
    // The ordinary Web display removes reference markup. Preserve the raw key
    // too, and consider collisions introduced by stripping rather than choosing
    // a row, a table, or the last translation.
    const english = strip(row.english);
    if (english && english !== row.english) add(english, localized === null ? null : strip(localized), identity, origin);
  }
  const conflicts = [], entries = new Map(), originEntries = new Map();
  for (const [english, rows] of literalRows) {
    const values = new Set(rows.map(row => row.localized));
    const text = values.size === 1 && !values.has(null) ? rows[0].localized : null;
    entries.set(english, text);
    if (rows.length > 1 && text === null) conflicts.push({ english, rows: rows.map(({ origin, ...row }) => row) });
    // A literal is ours only when no official row supplies the same text.
    const origins = new Set(rows.map(row => row.origin));
    if (text !== null && !origins.has('official')) originEntries.set(english, origins.has('agent') ? 'agent' : 'human');
  }
  // Official table rows: never null, never marked (an omitted id lets PoBR fall back).
  for (const scope of owned) if (scope !== NAME_SCOPE) {
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    for (const [id, row] of tables.scopes.get(scope)) scopes.get(scope).set(id, row);
  }
  const tableNames = owned.has(NAME_SCOPE) ? { format: 'official-tables', locale: catalog.locale, game_patch: catalog.game_patch,
    client: {}, provenance: { accepted_by: 'official-tables' },
    names: new Map([...tables.scopes.get(NAME_SCOPE)].map(([id, [english, text]]) => [id, { english, text }])) } : null;
  const nameDecisions = names || official || tableNames
    ? projectNames({ names, official, tableNames, game, catalogIndexSha256, packageTexts, officialElsewhere, skipped },
      catalog, runtimeScopes, identities, scopes, markScope) : null;
  const sidecar = { schema: 'pobr-native-display-texts/v1', game_patch: catalog.game_patch,
    realm: catalog.realm, locale: catalog.locale, catalog_sha256: catalogSha256,
    entries: sorted(entries), scopes: sorted([...scopes].map(([key, rows]) => [key, sorted(rows)])) };
  if (originEntries.size || originScopes.size) {
    sidecar.origins = { entries: sorted(originEntries),
      scopes: sorted([...originScopes].map(([key, rows]) => [key, sorted(rows)])) };
  }
  return { sidecar, decisions, conflicts, skipped, ...(nameDecisions ? { names: nameDecisions } : {}),
    ...(tables ? { owned_catalog_rows: ownedCatalogRows } : {}) };
}

// MonsterVarieties.Name rows from the official names file and our reviewed monster-name entries,
// decided per id against the target English of the pinned game package:
// - a catalog row with the id always wins;
// - an official name (nonempty, not its English) ships when its English equals the target English;
//   otherwise it belongs to another game version and is not applied (recorded);
// - our entry ships when no official name or catalog row applies and its English equals the target
//   English; it is `superseded` when official text ships, `retired` when the target English differs
//   or the id is not in the game package, and `official-elsewhere` (skipped) when the package already
//   has official text for its English (stat_lines, passive_names, a catalog value or an official name).
function projectNames({ names, official, tableNames = null, game, catalogIndexSha256, packageTexts, officialElsewhere, skipped },
  catalog, runtimeScopes, identities, scopes, markScope) {
  requireValue(game?.targets instanceof Map, 'Monster names need the pinned game package (target English)');
  if (names) validateSupplements(names);
  // Official table names were already paired against the same target English (official-tables.mjs).
  const officialNames = official ? validateOfficialNames(official, catalog, catalogIndexSha256) : tableNames;
  const reviewed = new Map(), entries = [];
  for (const entry of names?.entries ?? []) {
    const { identity } = entry;
    if (identity.kind !== 'monster-name') continue;
    const decision = { entry_id: entry.entry_id, english: identity.english, origin: entry.origin };
    entries.push(decision);
    if (identity.realm !== catalog.realm || identity.locale !== catalog.locale) { decision.lifecycle = 'other-target'; continue; }
    if (entry.status !== 'reviewed') { decision.lifecycle = entry.status; continue; }
    if (entry.based_on.game_package.sha256 !== game.sha256) decision.needs_review = 'based_on differs from the pinned game package';
    decision.ids = entry.ids.map(id => {
      requireValue(!reviewed.has(id), `Two reviewed monster names for ${id}`);
      reviewed.set(id, { entry, decision });
      return { id };
    });
  }
  if (officialNames || reviewed.size) requireValue(runtimeScopes.has(NAME_SCOPE), `Monster names need ${NAME_SCOPE} in projection.scopes`);
  const row = (id, english, text) => {
    if (!scopes.has(NAME_SCOPE)) scopes.set(NAME_SCOPE, new Map());
    scopes.get(NAME_SCOPE).set(id, [english, text]);
  };
  // Official table names own the scope: a catalog row of it ships nothing, so it decides nothing.
  const catalogRow = id => !tableNames && identities.has(JSON.stringify([NAME_SCOPE, id]));
  const counts = { official: 0, supplemented: 0, superseded: 0, retired: 0, 'official-elsewhere': 0 };
  const officialByEnglish = new Map();
  const notApplied = { 'catalog-row': [], untranslated: [], 'not-in-game': 0, 'ambiguous-target': [], 'english-differs': [] };
  const shipped = new Set();
  for (const [id, { english, text }] of officialNames?.names ?? []) {
    const target = game.targets.get(id);
    if (catalogRow(id)) notApplied['catalog-row'].push(id);
    else if (!text || !text.trim() || text === english) notApplied.untranslated.push(id);
    else if (target === undefined) notApplied['not-in-game']++;
    else if (target === null) notApplied['ambiguous-target'].push(id);
    else if (target !== english) notApplied['english-differs'].push({ id, official_english: english, target_english: target });
    else {
      row(id, english, text);
      shipped.add(id);
      if (!officialByEnglish.has(english)) officialByEnglish.set(english, { text, source: 'official-names' });
      counts.official++;
    }
  }
  if (reviewed.size) requireValue(packageTexts, 'Monster names need packageTexts (the package\'s official stat_lines and passive_names)');
  for (const [id, { entry, decision }] of reviewed) {
    const item = decision.ids.find(row => row.id === id);
    const target = game.targets.get(id);
    const elsewhere = officialElsewhere(entry.identity.english) ?? officialByEnglish.get(entry.identity.english) ?? null;
    // Catalog first; then our English must be the game's (else retired, even when an official name ships);
    // then an official name for the same English supersedes ours.
    if (catalogRow(id)) Object.assign(item, { lifecycle: 'superseded', by: 'catalog' });
    else if (target !== entry.identity.english) Object.assign(item, { lifecycle: 'retired',
      reason: target === undefined ? 'not-in-game' : target === null ? 'ambiguous-target' : 'english-differs', target_english: target ?? null });
    else if (shipped.has(id)) Object.assign(item, { lifecycle: 'superseded', by: 'official-names',
      official: scopes.get(NAME_SCOPE).get(id)[1], supplement_differs: scopes.get(NAME_SCOPE).get(id)[1] !== entry.text });
    else if (elsewhere) {
      Object.assign(item, { lifecycle: 'official-elsewhere', official: elsewhere.text, source: elsewhere.source });
      skipped.push({ kind: 'name', identity: ['MonsterVarieties', 'Name', id], english: entry.identity.english, origin: entry.origin,
        text: entry.text, official: elsewhere.text, source: elsewhere.source });
    } else {
      row(id, entry.identity.english, entry.text);
      markScope(NAME_SCOPE, id, entry.origin);
      item.lifecycle = 'supplemented';
    }
    counts[item.lifecycle]++;
  }
  for (const decision of entries) if (decision.ids) {
    const states = new Set(decision.ids.map(row => row.lifecycle));
    decision.lifecycle = ['supplemented', 'superseded', 'official-elsewhere', 'retired'].find(state => states.has(state));
  }
  return { counts, entries, game_package_sha256: game.sha256,
    official: officialNames ? { format: officialNames.format, locale: officialNames.locale, game_patch: officialNames.game_patch,
      client: officialNames.client, provenance: officialNames.provenance, names: officialNames.names.size, not_applied: notApplied } : null };
}

function readPinned(file, pin, reads) {
  requireValue(pin && /^[a-f0-9]{64}$/u.test(pin.sha256), 'Missing external SHA256');
  requireValue(pin.bytes === undefined || (Number.isSafeInteger(pin.bytes) && pin.bytes >= 0), 'Invalid declared input size');
  const absolute = path.resolve(file);
  requireValue(fs.realpathSync(absolute) === absolute, 'Input path contains a symlink');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    requireValue(stat.isFile(), 'Input must be a regular file');
    requireValue(pin.bytes === undefined || stat.size === pin.bytes, 'Input size differs from manifest');
    const raw = fs.readFileSync(fd);
    requireValue(raw.length === stat.size, 'Input size changed while reading');
    requireValue(digest(raw) === pin.sha256, `Input SHA256 mismatch: ${absolute}`);
    reads.set(absolute, { sha256: pin.sha256, bytes: raw.length });
    return raw;
  } finally { fs.closeSync(fd); }
}

// The pinned catalog (and its optional reviewed supplement) of a display request.
async function readCatalog(request, reads) {
  const manifest = JSON.parse(readPinned(request.catalog.manifest, request.catalog, reads));
  const version = new Map([
    ['poe2-native-catalog-manifest/v1', 'poe2-native-catalog/v1'],
    ['poe2-native-catalog-manifest/v2', 'poe2-native-catalog/v2'],
    ['poe2-native-catalog-manifest/v3', 'poe2-native-catalog/v3'],
  ]).get(manifest.schema);
  requireValue(version && manifest.status === 'candidate'
    && manifest.production_ready === false && manifest.game === 'poe2', 'Invalid catalog manifest');
  for (const field of ['game_patch', 'realm', 'locale']) requireValue(manifest[field] === request[field], `Catalog ${field} mismatch`);
  const fk = version === 'poe2-native-catalog/v3';
  requireValue(request.library || fk, 'v1/v2 catalogs require an explicit library closure');
  const library = request.library ?? localLibrary();
  const supplement = request.supplement;
  requireValue(!supplement || fk, 'Reviewed supplements require a v3 catalog');
  const payloads = ['catalog.json', 'request.json', ...(fk ? ['verification.json'] : [])];
  requireValue(JSON.stringify(Object.keys(manifest.files).sort()) === JSON.stringify(payloads.sort()), 'Unexpected catalog files');
  const bytes = readPinned(path.join(path.dirname(request.catalog.manifest), 'catalog.json'), manifest.files['catalog.json'], reads);
  readPinned(path.join(path.dirname(request.catalog.manifest), 'request.json'), manifest.files['request.json'], reads);
  // Execute only the exact already-reviewed library implementation, including its
  // local imports. The external request pins this closed module inventory too.
  const verification = fk ? readPinned(path.join(path.dirname(request.catalog.manifest), 'verification.json'),
    manifest.files['verification.json'], reads) : undefined;
  const libraries = fk ? [FK_LIBRARY_FILES] : version === 'poe2-native-catalog/v1'
    ? [LIBRARY_FILES, BINDING_LIBRARY_FILES, FK_LIBRARY_FILES] : [BINDING_LIBRARY_FILES, FK_LIBRARY_FILES];
  const libraryFiles = libraries.find(files => JSON.stringify(Object.keys(library.files).sort())
    === JSON.stringify([...files].sort()));
  requireValue(libraryFiles, 'Invalid library closure');
  if (fk) requireValue(JSON.stringify(sorted(Object.entries(manifest.producer ?? {})))
    === JSON.stringify(sorted(Object.entries(library.files))), 'Library producer closure mismatch');
  for (const file of libraryFiles) readPinned(path.join(library.root, file),
    { sha256: library.files[file] }, reads);
  // A reviewed supplement adds one separately pinned module and a compact package.
  // Its manifest producer must match the official module hashes exactly, plus that
  // module; nothing here joins the official catalog producer closure.
  let reviewed;
  if (supplement) {
    const module = supplement.module;
    requireValue(module?.file === REVIEWED_MODULE && /^[a-f0-9]{40}$/u.test(module.revision ?? '')
      && Number.isSafeInteger(module.bytes) && module.bytes >= 0,
      'Invalid supplement module pin');
    requireValue(Number.isSafeInteger(supplement.bytes) && supplement.bytes >= 0,
      'Invalid supplement manifest pin');
    readPinned(path.join(library.root, REVIEWED_MODULE), module, reads);
    const supplementManifest = JSON.parse(readPinned(supplement.manifest, supplement, reads));
    requireValue(supplementManifest.schema === 'poe2-reviewed-native-supplements-manifest/v1'
      && supplementManifest.status === 'candidate' && supplementManifest.production_ready === false
      && JSON.stringify(Object.keys(supplementManifest.files ?? {}).sort())
      === JSON.stringify(['request.json', 'supplements.json']), 'Invalid supplement manifest');
    const directory = path.dirname(supplement.manifest);
    readPinned(path.join(directory, 'request.json'), supplementManifest.files['request.json'], reads);
    const runtimeBytes = readPinned(path.join(directory, 'supplements.json'),
      supplementManifest.files['supplements.json'], reads);
    const producer = { ...Object.fromEntries(libraryFiles.map(file =>
      [path.basename(file), library.files[file]])), [path.basename(REVIEWED_MODULE)]: module.sha256 };
    requireValue(JSON.stringify(sorted(Object.entries(supplementManifest.producer ?? {})))
      === JSON.stringify(sorted(Object.entries(producer))), 'Supplement producer closure mismatch');
    reviewed = { module, runtimeBytes, runtimeSha256: supplementManifest.files['supplements.json'].sha256,
      manifest: { bytes: supplement.bytes, sha256: supplement.sha256 } };
  }
  const { strictJson } = await import(pathToFileURL(path.join(library.root, 'src/strict-json.mjs')));
  const catalog = strictJson(bytes);
  requireValue(catalog.schema === version, 'Catalog schema differs from manifest');
  if (fk) requireValue(catalog.fk_verification?.file === 'verification.json'
    && catalog.fk_verification.bytes === manifest.files['verification.json'].bytes
    && catalog.fk_verification.sha256 === manifest.files['verification.json'].sha256,
  'Catalog verification pin differs from manifest');
  // The supplement library validates the same original catalog/verification bytes
  // and keeps the official lookup as its fallback, so it is built only once here.
  const lookup = reviewed
    ? (await import(pathToFileURL(path.join(library.root, REVIEWED_MODULE)))).createReviewedSupplementLookup(
      [{ bytes, sha256: manifest.files['catalog.json'].sha256, verification }],
      { bytes: reviewed.runtimeBytes, sha256: reviewed.runtimeSha256 })
    : (await import(pathToFileURL(path.join(library.root, 'src/native-catalog.mjs')))).createCatalogLookup(
      catalog, { ...request, verification });
  if (reviewed) {
    const runtime = strictJson(reviewed.runtimeBytes);
    requireValue(runtime.schema === 'poe2-reviewed-native-supplements/v1' && runtime.status === 'candidate'
      && runtime.production_ready === false && Array.isArray(runtime.sources) && Array.isArray(runtime.records),
    'Invalid reviewed supplement runtime');
    reviewed.records = runtime.records.length;
    reviewed.sources = runtime.sources;
  }
  return { manifest, catalog, lookup, library, reviewed, strictJson };
}

export async function createDisplayTexts(request, out) {
  requireValue(request.schema === 'pobr-native-display-texts-request/v1', 'Invalid display request');
  const reads = new Map();
  // Official client-table sources (official-tables.mjs), newest first.
  const tableSpecs = request.official_tables;
  if (tableSpecs !== undefined) {
    requireValue(Array.isArray(tableSpecs) && tableSpecs.length, 'official_tables lists the official table sources, newest first');
    tableSpecs.forEach((spec, index) => validateTableSpec(spec, `official_tables[${index}]`));
    requireValue(new Set(tableSpecs.map(spec => spec.sha256)).size === tableSpecs.length, 'official_tables repeats a source');
  }
  // A locale with no catalog (zh-TW): no literal entries, per-ID scopes only from official_tables;
  // catalog_sha256 is then the newest localized tables manifest (PoBR checks only its shape).
  const catalogLess = request.catalog === undefined;
  let manifest = null, catalog, lookup, library = null, reviewed, strictJson;
  if (catalogLess) {
    requireValue(tableSpecs && request.supplement === undefined && request.library === undefined,
      'A display request without a catalog needs official_tables and takes no supplement or library');
    for (const field of ['game_patch', 'realm', 'locale']) requireValue(typeof request[field] === 'string' && request[field], `Invalid request ${field}`);
    ({ strictJson } = await import('../strict-json.mjs'));
    catalog = { game_patch: request.game_patch, realm: request.realm, locale: request.locale, records: [] };
    lookup = () => { throw new Error('No catalog lookup without a catalog'); };
  } else ({ manifest, catalog, lookup, library, reviewed, strictJson } = await readCatalog(request, reads));
  // The receipt names where the projection came from: the request (which the
  // receipt embeds verbatim) or this checkout's default file, pinned by its bytes.
  let projection = request.projection, projectionSource = { source: 'request' };
  if (projection === undefined) {
    const raw = fs.readFileSync(PROJECTION_PATH);
    readPinned(PROJECTION_PATH, { bytes: raw.length, sha256: digest(raw) }, reads);
    projection = JSON.parse(raw);
    projectionSource = { source: 'file', file: PROJECTION_FILE, bytes: raw.length, sha256: digest(raw) };
  }
  validateProjection(projection);
  // Optional pinned names with no catalog table: our curation/display-supplements.json (`names`)
  // and a RePoE-decoded official MonsterVarieties.Name file (`official_names`).
  const pinnedJson = key => {
    if (request[key] === undefined) return null;
    requireValue(request[key] && typeof request[key].file === 'string' && Number.isSafeInteger(request[key].bytes),
      `Invalid ${key} pin: {file, bytes, sha256}`);
    return strictJson(readPinned(request[key].file, request[key], reads));
  };
  const names = pinnedJson('names'), official = pinnedJson('official_names');
  const tableScopes = new Set(tableSpecs?.flatMap(spec => spec.scopes) ?? []);
  // The target English of each id: the pinned game package (`game_package`, a RePoE Release asset
  // pobr-game-<patch>.zip), required with either names input and with official_tables: monster
  // names from overlay/minions.json and spectres.json, gem descriptions from gem_descriptions.json.
  let game = null, targets = null;
  if (names || official || tableSpecs) {
    const spec = request.game_package;
    requireValue(spec && typeof spec.file === 'string' && Number.isSafeInteger(spec.bytes)
      && spec.asset === `pobr-game-${request.game_patch}.zip`,
    `Monster names and official tables need game_package {file, bytes, sha256, asset: pobr-game-${request.game_patch}.zip}`);
    const archive = readZip(readPinned(spec.file, spec, reads));
    const member = name => {
      const raw = archive.get(`data/${request.game_patch}/overlay/${name}`)?.raw;
      requireValue(raw, `game_package: data/${request.game_patch}/overlay/${name} is missing`);
      return strictJson(raw);
    };
    const monsters = names || official || tableScopes.has(TABLE_NAME_SCOPE) ? monsterTargets(member('minions.json'), member('spectres.json')) : null;
    game = { sha256: spec.sha256, targets: monsters ?? new Map() };
    targets = new Map([...(GEM_SCOPES.some(scope => tableScopes.has(scope)) ? gemTargets(member('gem_descriptions.json'), request.game_patch) : []),
      ...(monsters ? [[TABLE_NAME_SCOPE, monsters]] : [])]);
  }
  // Official table rows, paired against those targets; each source is a pinned RePoE input zip.
  let tables = null;
  if (tableSpecs) {
    const sources = tableSpecs.map((spec, index) => {
      requireValue(typeof spec.file === 'string', `official_tables[${index}]: needs file`);
      return readOfficialTables(readPinned(spec.file, spec, reads), spec, request.locale);
    });
    // The sidecar realm is the package target (international for the zh-CN package too); the text's
    // realm is checked per source (readOfficialTables). Each source must be of the target patch.
    for (const source of sources) requireValue(source.source.localized.source_identity.game_patch === request.game_patch,
      `official_tables: ${source.source.asset} is game_patch ${source.source.localized.source_identity.game_patch}, not ${request.game_patch}`);
    const paired = pairOfficialTables(sources, targets);
    tables = { scopes: paired.scopes, receipt: { sources: sources.map((source, index) => ({ ...source.source, counts: paired.counts[index] })),
      adopted: Object.fromEntries([...paired.scopes].map(([scope, rows]) => [scope, rows.size])), missing: paired.missing } };
  }
  // The official texts of the same package (`package_texts`: its stat_lines.json base without our
  // rows and its passive_names.json); required as soon as any supplement would ship.
  let packageTexts = null;
  if (request.package_texts !== undefined) {
    const spec = request.package_texts;
    requireValue(spec && JSON.stringify(Object.keys(spec).sort()) === '["passive_names","stat_lines"]',
      'package_texts pins {stat_lines, passive_names}');
    const read = key => {
      requireValue(typeof spec[key]?.file === 'string' && Number.isSafeInteger(spec[key].bytes), `Invalid package_texts.${key} pin`);
      return strictJson(readPinned(spec[key].file, spec[key], reads));
    };
    const lines = read('stat_lines'), passives = read('passive_names');
    requireValue(Array.isArray(lines) && lines.every(row => typeof row?.src === 'string' && typeof row.en === 'string')
      && passives && typeof passives === 'object' && !Array.isArray(passives)
      && Object.values(passives).every(text => typeof text === 'string'), 'package_texts: stat_lines [{src, en}], passive_names {english: text}');
    packageTexts = new Map();
    for (const row of lines) if (!row.origin && row.src.trim() && !packageTexts.has(row.en)) packageTexts.set(row.en, { text: row.src, source: 'stat_lines' });
    for (const [english, text] of Object.entries(passives)) {
      if (text.trim() && !packageTexts.has(english)) packageTexts.set(english, { text, source: 'passive_names' });
    }
  }
  const catalogSha256 = catalogLess ? tableSpecs[0].localized_manifest_sha256 : manifest.files['catalog.json'].sha256;
  const projected = projectDisplayTexts(catalog, lookup, catalogSha256, projection,
    { names, official, game, catalogIndexSha256: manifest?.observed_client?.index_sha256 ?? null, packageTexts, tables });
  for (const [file, pin] of [...reads]) readPinned(file, pin, reads);
  const output = path.resolve(out), cache = path.join(REPO_ROOT, '.cache');
  requireValue(output.startsWith(cache + path.sep) && !fs.existsSync(output), 'Output must be a fresh repository cache candidate');
  requireValue(fs.realpathSync(path.dirname(output)) === path.dirname(output), 'Output parent contains a symlink');
  fs.mkdirSync(output);
  const raw = JSON.stringify(projected.sidecar) + '\n';
  fs.writeFileSync(path.join(output, 'display_texts.json'), raw, { flag: 'wx' });
  const receipt = { schema: 'pobr-native-display-texts-receipt/v1', adoption: 'not-adopted', request, library,
    inputs: Object.fromEntries(reads), files: { 'display_texts.json': { bytes: Buffer.byteLength(raw), sha256: digest(raw) } },
    implementation_sha256: digest(fs.readFileSync(fileURLToPath(import.meta.url))),
    decisions: projected.decisions, conflicts: projected.conflicts,
    runtime_scopes: [...projection.scopes].sort(),
    projection: { ...projectionSource, scopes: projection.scopes, literals: projection.literals },
    ...(reviewed ? { supplement: { manifest: reviewed.manifest, module: reviewed.module,
      runtime: { bytes: reviewed.runtimeBytes.length, sha256: reviewed.runtimeSha256 },
      catalog_sha256: manifest.files['catalog.json'].sha256, sources: reviewed.sources,
      records: reviewed.records } } : {}),
    ...(projected.names ? { names: projected.names } : {}),
    ...(tables ? { official_tables: { ...tables.receipt, owned_catalog_rows: projected.owned_catalog_rows,
      ...(catalogLess ? { catalog: 'none: catalog_sha256 is the newest localized tables manifest' } : {}) } } : {}),
    ...(packageTexts ? { official_elsewhere: { skipped: projected.skipped.length, rows: projected.skipped } } : {}),
    scope: 'Only declared runtime scopes retain browser per-ID indexes. Every source record still participates in exact library decisions and applicable literal collision checks, including unresolved records and markup aliases. Null blocks stale compatibility text. Other scoped metadata stays in the translation library. No cross-locale conversion, placeholder rendering, calculation, source approval or CURRENT adoption.' };
  fs.writeFileSync(path.join(output, 'receipt.json'), serialize(receipt), { flag: 'wx' });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, file, outFlag, out] = process.argv.slice(2);
  requireValue(flag === '--request' && outFlag === '--out' && out && process.argv.length === 6, 'Usage: --request file.json --out .cache/fresh');
  const receipt = await createDisplayTexts(JSON.parse(fs.readFileSync(file, 'utf8')), out);
  console.log(JSON.stringify({ files: receipt.files, records: receipt.decisions.length, conflicts: receipt.conflicts.length }));
}
