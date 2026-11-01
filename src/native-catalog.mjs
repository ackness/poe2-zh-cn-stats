// Source-bound display text. This module pairs and queries text; it never renders
// CSD branches, evaluates numbers, constructs game DTOs, or converts locales.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { NAME_FIELDS, readNamePackage, keyNameRows } from './native-names.mjs';
import { strictJson } from './strict-json.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const locales = { 'Traditional Chinese': 'zh-TW', 'Simplified Chinese': 'zh-CN' };
const require = (condition, message) => { if (!condition) throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const sorted = list => [...list].sort();
const inside = (root, target) => target.startsWith(root + path.sep);

// Explicit display columns, not every string column (paths/AI scripts/IDs are
// not translations). The schema's localized flag is retained as evidence only:
// these actual locale resources have translated columns marked localized=false.
export const CATALOG_FIELDS = Object.freeze({
  BaseItemTypes: { Name: 'name', Inflection: 'inflection' },
  ActiveSkills: { DisplayedName: 'name', Description: 'description', ShortDescription: 'description', WebsiteDescription: 'description' },
  Mods: { Name: 'name' }, Words: { Text2: 'name', Inflection: 'inflection' },
  Characters: { Name: 'name', Description: 'description', TraitDescription: 'description' },
  Ascendancy: { Name: 'name', FlavourText: 'description' },
  PassiveSkills: { Name: 'name', FlavourText: 'description' },
  ItemClasses: { Name: 'name' }, AlternateQualityTypes: { Description: 'name' },
});
export const CONTEXT_FIELDS = Object.freeze({
  BaseItemTypes: ['ItemClass'], ActiveSkills: ['GrantedEffect'],
  Mods: ['Domain', 'GenerationType'], Words: ['Text', 'Wordlist'],
  Characters: ['IntegerId', 'BaseClass'], Ascendancy: ['ClassNo', 'Character'],
  PassiveSkills: ['PassiveSkillGraphId'], ItemClasses: [], AlternateQualityTypes: [],
});

/** Lexical metadata only. Unknown format strings remain raw; no format math. */
export function displayTemplate(text) {
  const placeholders = [];
  const rest = text.replace(/\{([0-9]*)(?::([^{}]*))?\}/gu, (token, index, format, offset) => {
    placeholders.push({ token_raw: token, index_raw: index, format_raw: format ?? null,
      sign_raw: /[+\-−]$/u.exec(text.slice(0, offset).trimEnd())?.[0] ?? '',
      utf16_span: [offset, offset + token.length] });
    return '';
  });
  const references = [];
  const literals = rest.replace(/\[([^\[\]\r\n]+)\]/gu, (token, inner) => {
    const parts = inner.split('|');
    references.push({ token_raw: token, key_raw: parts[0], display_raw: parts[1] ?? null,
      valid: parts.length <= 2 && parts[0].length > 0 });
    return '';
  });
  return { placeholders, references,
    literal_numbers: sorted(literals.match(/[+\-−]?\d+(?:\.\d+)?/gu) ?? []),
    hash_slots: (literals.match(/#/gu) ?? []).length,
    syntax_valid: !/[{}]/u.test(rest) && !/[\[\]]/u.test(literals) && references.every(r => r.valid) };
}

function classify(english, localized, hasEnglish, hasLocalized) {
  const templates = { english: typeof english === 'string' ? displayTemplate(english) : null,
    localized: typeof localized === 'string' ? displayTemplate(localized) : null };
  const en = templates.english, zh = templates.localized;
  const slots = t => sorted(t.placeholders.map(p => JSON.stringify([p.index_raw, p.format_raw, p.sign_raw])));
  const refs = t => sorted(t.references.map(r => r.key_raw));
  const reason = !hasEnglish ? 'missing-english-id' : !hasLocalized ? 'missing-localized-id'
    : !english?.trim() ? 'empty-english-text' : !localized?.trim() ? 'empty-localized-text'
    : english === localized ? 'unchanged-text'
    : !/\p{Script=Han}/u.test(localized) ? 'no-han-in-localized-text'
    : !en.syntax_valid || !zh.syntax_valid ? 'unresolved-template-syntax'
    : !same(slots(en), slots(zh)) || en.hash_slots !== zh.hash_slots ? 'placeholder-mismatch'
    : !same(refs(en), refs(zh)) ? 'reference-mismatch'
    : !same(en.literal_numbers, zh.literal_numbers) ? 'literal-number-mismatch' : null;
  return { status: reason ? 'unresolved' : 'translated', reason, templates };
}

function context(table, row) {
  if (!row) return null;
  return Object.fromEntries(CONTEXT_FIELDS[table].map(field => {
    require(Object.hasOwn(row.values, field), `Missing context column: ${table}.${field}`);
    return [field, row.values[field]];
  }));
}

function selectedTables(tables = Object.keys(CATALOG_FIELDS)) {
  require(Array.isArray(tables) && tables.length > 0 && new Set(tables).size === tables.length
    && tables.every(t => Object.hasOwn(CATALOG_FIELDS, t)), 'Invalid explicit catalog table scope');
  return Object.keys(CATALOG_FIELDS).filter(t => tables.includes(t));
}

export function pairDisplayCatalog(english, localized, language, tables) {
  require(Object.hasOwn(locales, language), 'Unsupported catalog language');
  const records = [], conflicts = [], coverage = {};
  const selected = selectedTables(tables);
  for (const table of selected) {
    const fields = CATALOG_FIELDS[table];
    require(english[table] && localized[table], `Missing catalog table: ${table}`);
    const keyField = NAME_FIELDS[table][0];
    const left = keyNameRows(english[table], keyField), right = keyNameRows(localized[table], keyField);
    coverage[table] = {};
    for (const [field, kind] of Object.entries(fields)) {
      const selected = [];
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        const en = left.get(id), zh = right.get(id);
        const enContext = context(table, en), zhContext = context(table, zh);
        if (table === 'Words' && en && zh) require(same(enContext, zhContext), `Words hash binding differs: ${id}`);
        const text = row => {
          if (!row) return null;
          const value = row.values[field];
          require(value === null || typeof value === 'string', `Invalid display column: ${table}.${field}/${id}`);
          return value;
        };
        const englishText = text(en), localizedText = text(zh);
        const classified = classify(englishText, localizedText, Boolean(en), Boolean(zh));
        const record = { table, key_field: keyField, id, field, kind,
          english: englishText, localized: localizedText,
          english_row: en?._row ?? null, localized_row: zh?._row ?? null,
          context: { english: enContext, localized: zhContext }, ...classified };
        records.push(record); selected.push(record);
      }
      const owners = new Map();
      for (const row of selected) if (row.english) {
        if (!owners.has(row.english)) owners.set(row.english, []);
        owners.get(row.english).push(row);
      }
      for (const [englishText, rows] of owners) {
        const translations = new Set(rows.filter(r => r.status === 'translated').map(r => r.localized));
        if (translations.size > 1 || translations.size && rows.some(r => r.status !== 'translated')) {
          conflicts.push({ table, field, english: englishText,
            reason: translations.size > 1 ? 'different-localized-text' : 'incomplete-homonym',
            alternatives: rows.map(r => ({ id: r.id, localized: r.localized, status: r.status, reason: r.reason, context: r.context })) });
        }
      }
      coverage[table][field] = { english_rows: left.size, localized_rows: right.size,
        records: selected.length, translated: selected.filter(r => r.status === 'translated').length,
        unresolved: selected.filter(r => r.status === 'unresolved').length };
    }
  }
  return { selected_tables: selected, records, conflicts, coverage };
}

function column(table, field) {
  const matches = table.columns?.filter(c => c.physical_fields?.includes(field));
  require(matches?.length === 1 && Number.isSafeInteger(matches[0].source_column)
    && matches[0].source_column >= 0 && table.physical_fields?.includes(field), `Missing/ambiguous source column: ${table.table}.${field}`);
  return matches[0];
}

export async function createNativeCatalog(config, out) {
  require(config?.schema === 'poe2-native-catalog-request/v1' && Object.hasOwn(locales, config.language), 'Invalid catalog request/language');
  const tables = selectedTables(config.tables);
  require(Array.isArray(config.english) && config.english.length > 0 && config.english.length <= 9, 'Explicit English packages required');
  const output = path.resolve(out), cache = path.join(ROOT, '.cache');
  require(inside(cache, output), 'Output must be a fresh candidate in this repository .cache');
  try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reads = new Map(), english = {}, owners = {}, sources = [];
  const target = await readNamePackage(config.localized, config.language, tables, reads);
  sources.push(target.provenance);
  for (const input of config.english) {
    require(Array.isArray(input.tables) && input.tables.length > 0
      && input.tables.every(t => tables.includes(t) && !Object.hasOwn(english, t))
      && new Set(input.tables).size === input.tables.length, 'Invalid/duplicate English table ownership');
    const source = await readNamePackage(input, 'English', input.tables, reads);
    for (const key of ['game', 'game_patch', 'realm']) require(source.identity[key] === target.identity[key], `Source identity differs: ${key}`);
    for (const key of ['revision', 'sha256', 'native_specification_sha256']) require(typeof source.schema?.[key] === 'string'
      && source.schema[key] === target.schema?.[key], `Source schema differs: ${key}`);
    for (const name of input.tables) owners[name] = source;
    Object.assign(english, source.tables); sources.push(source.provenance);
  }
  const paired = pairDisplayCatalog(english, target.tables, config.language, tables);
  const bindings = {};
  for (const name of tables) {
    bindings[name] = {};
    const fields = [NAME_FIELDS[name][0], ...CONTEXT_FIELDS[name], ...Object.keys(CATALOG_FIELDS[name])];
    for (const [side, source] of [['english', owners[name]], ['localized', target]]) {
      const table = source.tables[name];
      const columns = Object.fromEntries(fields.map(field => [field, column(table, field)]));
      for (const field of Object.keys(CATALOG_FIELDS[name])) require(columns[field].schema?.type === 'string', `Not a string display column: ${name}.${field}`);
      bindings[name][side] = { manifest_sha256: source.provenance.manifest_sha256,
        raw_resource: table.raw_resource, raw_fingerprint: source.identity.raw_resources[table.raw_resource], columns };
    }
  }
  const producer = {};
  for (const file of ['src/native-catalog.mjs', 'src/native-names.mjs', 'src/strict-json.mjs']) producer[file] = hash(await readFile(path.join(ROOT, file)));
  const result = { schema: 'poe2-native-catalog/v1', status: 'candidate', production_ready: false,
    game: target.identity.game, game_patch: target.identity.game_patch, realm: target.identity.realm,
    language: config.language, locale: locales[config.language], ...paired, bindings, sources, producer,
    policy: { identity: 'Exact table/key/field; Words HASH32 requires same-patch Text and Wordlist binding.',
      english_lookup: 'All matching identities, including unresolved ones, must agree; otherwise fall back to the requested English.',
      templates: 'Raw placeholder indices, formats, signs, multiplicity, references and literal numbers retained. Lexical agreement is not renderer or semantic approval.',
      context: 'Raw display disambiguation evidence only; foreign row numbers require the owning facts package to resolve.',
      applicability: 'Display only. No Chinese client numeric equivalence, source approval, CURRENT activation or locale conversion.' } };
  for (const [file, digest] of reads) require(hash(await readFile(file)) === digest, `Input changed: ${file}`);
  for (const file of reads.keys()) require(!inside(path.dirname(file), output), 'Output is inside a source package');
  await mkdir(path.dirname(output), { recursive: true });
  require(await realpath(path.dirname(output)) === path.dirname(output), 'Output parent contains symlink');
  await mkdir(output);
  const raw = json(result), request = json(config);
  await writeFile(path.join(output, 'catalog.json'), raw, { flag: 'wx' });
  await writeFile(path.join(output, 'request.json'), request, { flag: 'wx' });
  const manifest = { schema: 'poe2-native-catalog-manifest/v1', status: 'candidate', production_ready: false,
    game: result.game, game_patch: result.game_patch, realm: result.realm, language: result.language, locale: result.locale,
    files: { 'catalog.json': { bytes: Buffer.byteLength(raw), sha256: hash(raw) },
      'request.json': { bytes: Buffer.byteLength(request), sha256: hash(request) } }, producer };
  await writeFile(path.join(output, 'manifest.json'), json(manifest), { flag: 'wx' });
  return result;
}

/** Validate once, then query by exact identity or unambiguous text + context. */
export function createCatalogLookup(catalog, expected) {
  require(catalog?.schema === 'poe2-native-catalog/v1' && catalog.status === 'candidate' && catalog.production_ready === false
    && catalog.game === 'poe2' && locales[catalog.language] === catalog.locale, 'Invalid catalog envelope');
  for (const key of ['game_patch', 'realm', 'locale']) require(typeof expected?.[key] === 'string' && expected[key] === catalog[key], `Catalog identity differs: ${key}`);
  const tables = selectedTables(catalog.selected_tables);
  require(same(tables, catalog.selected_tables) && same(sorted(Object.keys(catalog.coverage ?? {})), sorted(tables)), 'Invalid catalog table inventory');
  const byIdentity = new Map(), byEnglish = new Map(), counts = {};
  require(Array.isArray(catalog.records), 'Missing catalog records');
  for (const row of catalog.records) {
    require(tables.includes(row.table) && Object.hasOwn(CATALOG_FIELDS[row.table], row.field)
      && row.key_field === NAME_FIELDS[row.table][0] && row.kind === CATALOG_FIELDS[row.table][row.field], 'Invalid catalog field identity');
    require(row.key_field === 'HASH32' ? Number.isSafeInteger(row.id) && row.id >= 0 && row.id <= 0xffffffff
      : typeof row.id === 'string' && row.id.length > 0, 'Invalid catalog key');
    require([row.english, row.localized].every(t => t === null || typeof t === 'string')
      && [row.english_row, row.localized_row].every(r => r === null || Number.isSafeInteger(r) && r >= 0)
      && (row.english_row !== null || row.localized_row !== null), 'Invalid catalog text/rows');
    const classified = classify(row.english, row.localized, row.english_row !== null, row.localized_row !== null);
    require(row.status === classified.status && row.reason === classified.reason && same(row.templates, classified.templates), 'Invalid catalog text status/templates');
    for (const [side, physical] of [['english', row.english_row], ['localized', row.localized_row]]) require(physical === null ? row.context?.[side] === null
      : row.context?.[side] && same(sorted(Object.keys(row.context[side])), sorted(CONTEXT_FIELDS[row.table])), 'Invalid catalog context');
    if (row.table === 'Words' && row.english_row !== null && row.localized_row !== null) require(same(row.context.english, row.context.localized), 'Words hash binding differs');
    const key = JSON.stringify([row.table, row.field, row.id]);
    require(!byIdentity.has(key), 'Duplicate catalog identity'); byIdentity.set(key, row);
    const textKey = JSON.stringify([row.table, row.field, row.english]);
    if (!byEnglish.has(textKey)) byEnglish.set(textKey, []);
    byEnglish.get(textKey).push(row);
    const countKey = JSON.stringify([row.table, row.field]);
    counts[countKey] ??= { english: new Set(), localized: new Set(), records: 0, translated: 0, unresolved: 0 };
    const count = counts[countKey]; count.records++; count[row.status]++;
    for (const [side, field] of [['english', 'english_row'], ['localized', 'localized_row']]) if (row[field] !== null) {
      require(!count[side].has(row[field]), 'Duplicate catalog physical row'); count[side].add(row[field]);
    }
  }
  for (const table of tables) for (const field of Object.keys(CATALOG_FIELDS[table])) {
    const actual = counts[JSON.stringify([table, field])] ?? { english: new Set(), localized: new Set(), records: 0, translated: 0, unresolved: 0 };
    const declared = catalog.coverage?.[table]?.[field];
    require(declared && same(declared, { english_rows: actual.english.size, localized_rows: actual.localized.size,
      records: actual.records, translated: actual.translated, unresolved: actual.unresolved })
      && ['english', 'localized'].every(side => [...actual[side]].every(r => r < actual[side].size)), 'Incomplete catalog coverage');
  }
  return query => {
    require(typeof query?.english === 'string' && Object.hasOwn(CATALOG_FIELDS, query.table)
      && Object.hasOwn(CATALOG_FIELDS[query.table], query.field), 'Explicit table/field/English query required');
    const fallback = (reason, rows = []) => ({ status: 'fallback', text: query.english, reason, ids: rows.map(r => r.id) });
    const exact = Object.hasOwn(query, 'id');
    let rows = exact ? [byIdentity.get(JSON.stringify([query.table, query.field, query.id]))].filter(Boolean)
      : byEnglish.get(JSON.stringify([query.table, query.field, query.english])) ?? [];
    if (!rows.length) return fallback('missing-identity-or-text');
    if (rows.some(r => r.english !== query.english)) return fallback('source-english-changed', rows);
    if (query.context) {
      require(Object.keys(query.context).every(k => CONTEXT_FIELDS[query.table].includes(k)), 'Unknown disambiguation context');
      rows = rows.filter(r => Object.entries(query.context).every(([k, v]) => same(r.context.english?.[k], v)));
      if (!rows.length) return fallback('context-mismatch');
    }
    if (rows.some(r => r.status !== 'translated')) return fallback(exact ? rows[0].reason : 'unresolved-homonym', rows);
    if (new Set(rows.map(r => r.localized)).size !== 1) return fallback('ambiguous-english', rows);
    return { status: 'translated', text: rows[0].localized, reason: null, ids: rows.map(r => r.id) };
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, file, outFlag, out] = process.argv.slice(2);
  require(flag === '--config' && outFlag === '--out' && out && process.argv.length === 6, 'Usage: native-catalog.mjs --config request.json --out .cache/fresh');
  const result = await createNativeCatalog(strictJson(await readFile(file)), out);
  console.log(JSON.stringify({ locale: result.locale, records: result.records.length,
    translated: result.records.filter(r => r.status === 'translated').length, conflicts: result.conflicts.length }));
}
