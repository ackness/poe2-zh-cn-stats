// Offline display-name pairing from explicitly pinned RePoE physical facts.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const locales = { 'Traditional Chinese': 'zh-TW', 'Simplified Chinese': 'zh-CN' };
export const NAME_FIELDS = Object.freeze({
  BaseItemTypes: ['Id', 'Name'], ActiveSkills: ['Id', 'DisplayedName'],
  Mods: ['Id', 'Name'], Words: ['HASH32', 'Text2'], Characters: ['Id', 'Name'],
  Ascendancy: ['Id', 'Name'], PassiveSkills: ['Id', 'Name'],
  ItemClasses: ['Id', 'Name'], AlternateQualityTypes: ['Id', 'Description'],
});
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const inside = (root, target) => target.startsWith(root + path.sep);

async function pinned(file, pin, reads, maxBytes) {
  const stat = await lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maxBytes, `Invalid bounded file: ${file}`);
  requireValue(/^[a-f0-9]{64}$/.test(pin?.sha256) && (pin.bytes === undefined || stat.size === pin.bytes), `Invalid byte pin: ${file}`);
  const raw = await readFile(file);
  requireValue(raw.length <= maxBytes && sha(raw) === pin.sha256, `Fingerprint mismatch: ${file}`);
  reads.set(file, sha(raw));
  return JSON.parse(raw.toString('utf8'));
}

async function readPackage(input, language, names, reads) {
  const file = path.resolve(input.manifest);
  const root = await realpath(path.dirname(file));
  requireValue(await realpath(file) === path.join(root, 'manifest.json'), 'Manifest must be the package manifest.json');
  const manifest = await pinned(file, { sha256: input.sha256 }, reads, 2 * 1024 * 1024);
  const formats = language === 'English' ? ['repoe-native-facts/v4', 'repoe-native-tables/v1'] : ['repoe-localized-tables/v1'];
  requireValue(formats.includes(manifest.format) && manifest.status === 'partial-candidate' && manifest.production_ready === false, 'Unsupported facts format/status');
  const identity = manifest.source_identity;
  requireValue(identity?.game === 'poe2' && /^\d+(?:\.\d+){2,5}$/.test(identity.game_patch)
    && ['international', 'china'].includes(identity.realm)
    && (identity.language ?? 'English') === language, 'Invalid facts language/game identity');
  const payload = async name => {
    const target = path.join(root, name);
    requireValue(inside(root, await realpath(target)) && await realpath(target) === target, 'Payload escapes package or is a symlink');
    return pinned(target, manifest.files[name], reads, 128 * 1024 * 1024);
  };
  const combined = manifest.format === 'repoe-native-facts/v4' ? null : await payload('tables.json');
  const tables = {};
  for (const name of names) {
    const table = combined ? combined[name] : await payload(`tables/${name}.json`);
    requireValue(table?.table === name && Array.isArray(table.rows), `Missing physical table: ${name}`);
    const resource = `Data/Balance/${language === 'English' ? '' : language + '/'}${name}.datc64`;
    const rawPin = identity.raw_resources?.[resource];
    requireValue(table.raw_resource === resource && /^[a-f0-9]{64}$/.test(rawPin?.sha256)
      && Number.isSafeInteger(rawPin.bytes) && rawPin.bytes > 0, `Wrong raw resource: ${name}`);
    tables[name] = table;
  }
  return { tables, identity, schema: manifest.schema, provenance: { manifest_sha256: input.sha256,
    source_identity: identity, schema: manifest.schema } };
}

function keyed(table, keyField) {
  const map = new Map();
  table.rows.forEach((row, index) => {
    const id = row.values?.[keyField];
    const validKey = keyField === 'HASH32' ? Number.isSafeInteger(id) && id >= 0 && id <= 0xffffffff
      : typeof id === 'string' && id.length > 0;
    requireValue(row._row === index && validKey && !map.has(id), `Invalid/duplicate source identity: ${table.table}/${index}`);
    map.set(id, row);
  });
  return map;
}

export function pairNames(english, localized, language) {
  requireValue(Object.hasOwn(locales, language), 'Unsupported localized language');
  const entries = [], excluded = [], coverage = {};
  for (const name of Object.keys(NAME_FIELDS)) {
    const [keyField, field] = NAME_FIELDS[name];
    requireValue(english[name] && localized[name], `Missing required name table: ${name}`);
    const en = keyed(english[name], keyField), zh = keyed(localized[name], keyField);
    let paired = 0;
    for (const [id, row] of en) {
      const translated = zh.get(id);
      if (name === 'Words' && translated) {
        requireValue(typeof row.values.Text === 'string' && Number.isSafeInteger(row.values.Wordlist)
          && row.values.Text === translated.values.Text && row.values.Wordlist === translated.values.Wordlist,
        `Words hash binding differs: ${id}`);
      }
      const left = row.values[field], right = translated?.values[field];
      requireValue(left === null || typeof left === 'string', `Invalid English text: ${name}/${id}`);
      if (translated) requireValue(right === null || typeof right === 'string', `Invalid localized text: ${name}/${id}`);
      const reason = !translated ? 'missing-localized-id' : !left ? 'empty-english-text'
        : !right ? 'empty-localized-text' : left === right ? 'unchanged-text' : null;
      const evidence = { english_row: row._row, localized_row: translated?._row ?? null };
      if (reason) excluded.push({ table: name, key_field: keyField, id, field, reason, english: left, localized: right ?? null, ...evidence });
      else {
        entries.push({ table: name, key_field: keyField, id, field, english: left, localized: right, ...evidence });
        paired++;
      }
    }
    for (const [id, row] of zh) if (!en.has(id)) excluded.push({ table: name, key_field: keyField, id, field,
      reason: 'missing-english-id', english: null, localized: row.values[field], english_row: null, localized_row: row._row });
    coverage[name] = { english_rows: en.size, localized_rows: zh.size, paired };
  }
  // English-only lookups cannot select an arbitrary translated homonym.
  const owners = new Map();
  for (const entry of entries) {
    const key = JSON.stringify([entry.table, entry.field, entry.english]);
    if (!owners.has(key)) owners.set(key, new Map());
    const alternatives = owners.get(key);
    if (!alternatives.has(entry.localized)) alternatives.set(entry.localized, []);
    alternatives.get(entry.localized).push(entry.id);
  }
  const conflicts = [...owners].filter(([, alternatives]) => alternatives.size > 1).map(([key, alternatives]) => ({
    table: JSON.parse(key)[0], field: JSON.parse(key)[1], english: JSON.parse(key)[2],
    alternatives: [...alternatives].map(([localized, ids]) => ({ localized, ids })),
  }));
  return { entries, excluded, conflicts, coverage };
}

export async function createNativeNames(config, out) {
  requireValue(config?.schema === 'poe2-native-name-request/v1' && Object.hasOwn(locales, config.language), 'Invalid name request/language');
  requireValue(Array.isArray(config.english) && config.english.length > 0 && config.english.length <= 9, 'Explicit English packages required');
  const output = path.resolve(out), cache = path.join(ROOT, '.cache');
  requireValue(inside(cache, output), 'Output must be a fresh candidate in this repository .cache');
  try { await lstat(output); throw new Error('Output already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const reads = new Map(), english = {}, sources = [];
  const target = await readPackage(config.localized, config.language, Object.keys(NAME_FIELDS), reads);
  sources.push(target.provenance);
  for (const input of config.english) {
    requireValue(Array.isArray(input.tables) && input.tables.length > 0
      && input.tables.every(name => Object.hasOwn(NAME_FIELDS, name) && !Object.hasOwn(english, name))
      && new Set(input.tables).size === input.tables.length, 'Invalid/duplicate English table ownership');
    const source = await readPackage(input, 'English', input.tables, reads);
    for (const key of ['game', 'game_patch', 'realm']) requireValue(source.identity[key] === target.identity[key], `Source identity differs: ${key}`);
    for (const key of ['revision', 'sha256', 'native_specification_sha256']) {
      requireValue(typeof source.schema?.[key] === 'string' && source.schema[key] === target.schema?.[key], `Source schema differs: ${key}`);
    }
    Object.assign(english, source.tables); sources.push(source.provenance);
  }
  const paired = pairNames(english, target.tables, config.language);
  const result = { schema: 'poe2-native-names/v1', status: 'candidate', production_ready: false,
    game: target.identity.game, game_patch: target.identity.game_patch, realm: target.identity.realm,
    language: config.language, locale: locales[config.language], ...paired, sources,
    producer: { 'src/native-names.mjs': sha(await readFile(fileURLToPath(import.meta.url))) },
    limits: ['Display text only; no numeric or release applicability inference.',
      'Exact declared key joins; Words uses unique HASH32 plus matching Text and Wordlist within this patch. Physical rows are provenance only.',
      'Unchanged, missing and empty strings are excluded, not fabricated translations.',
      'Conflicting English names require stable table/key identity; no first-match fallback.',
      'No cross-locale conversion, CURRENT activation or source-status promotion.'] };
  for (const [file, digest] of reads) requireValue(sha(await readFile(file)) === digest, `Input changed: ${file}`);
  for (const file of reads.keys()) requireValue(!inside(path.dirname(file), output), 'Output is inside a source package');
  await mkdir(path.dirname(output), { recursive: true });
  requireValue(await realpath(path.dirname(output)) === path.dirname(output), 'Output parent contains symlink');
  await mkdir(output);
  await writeFile(path.join(output, 'names.json'), json(result), { flag: 'wx' });
  await writeFile(path.join(output, 'request.json'), json(config), { flag: 'wx' });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [flag, configPath, outFlag, output] = process.argv.slice(2);
  if (flag !== '--config' || outFlag !== '--out' || !output || process.argv.length !== 6) throw new Error('Usage: native-names.mjs --config request.json --out .cache/candidate');
  const result = await createNativeNames(JSON.parse(await readFile(configPath, 'utf8')), output);
  console.log(JSON.stringify({ locale: result.locale, entries: result.entries.length, excluded: result.excluded.length, conflicts: result.conflicts.length }));
}
