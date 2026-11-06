// Official display text from client tables (`official_tables` of pobr:display-texts): a pinned RePoE
// input package (repoe-release-input/v1) holds a default (English) and a localized table package
// (repoe-native-tables/v1, repoe-localized-tables/v1) decoded from one client. Per scope
// `<Table>.<Field>` and id (the table's Id column), newest source first:
// - pair the localized row and the default row of the same package by Id;
// - adopt the localized value only if the source's default English equals the target English of the
//   pinned game package byte for byte, the value is nonempty, differs from the English and has Han;
// - write [targetEnglishRaw, localizedRaw]; markup stays raw (the consumer renders it).
// Ids that fail are omitted, never written as null: in PoBR null means "show English", which would
// block zh-TW from falling back to converted zh-CN. Every reason is counted for the receipt.
// Realm is recorded apart from language: official zh-CN is China-client text, zh-TW international.
import { createHash } from 'node:crypto';
import { readZip } from '../release/stored-zip.mjs';
import { strictJson } from '../strict-json.mjs';

export const INPUT_SCHEMA = 'repoe-release-input/v1';
export const GEM_DESCRIPTIONS_SCHEMA = 'repoe-gem-descriptions/v1';
export const NAME_SCOPE = 'MonsterVarieties.Name';
export const GEM_SCOPES = ['GemEffects.SupportText', 'ActiveSkills.Description'];
export const TABLE_SCOPES = [...GEM_SCOPES, NAME_SCOPE];
export const TABLE_REALMS = { 'zh-CN': 'china', 'zh-TW': 'international' };
const LANGUAGES = { 'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese' };
const FORMATS = { default: 'repoe-native-tables/v1', localized: 'repoe-localized-tables/v1' };
const SPEC_KEYS = ['repository', 'tag', 'asset', 'bytes', 'sha256', 'default', 'default_manifest_sha256', 'localized',
  'localized_manifest_sha256', 'scopes'];
const HEX64 = /^[0-9a-f]{64}$/u;
const DIRECTORY = /^(?:[A-Za-z0-9_.-]+\/)+$/u;
const require = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const han = text => /\p{Script=Han}/u.test(text);
// Brackets of the [A|B] / [A] markup must pair up: a new form in the English fails loudly instead of
// shipping, a localized value that breaks them is not adopted.
// Contract 1.3 allows exactly [A] and [A|B] with a non-empty key A, so [A|B|C], [] and [|B] are
// problems too (the consumer would show "B|C").
export function markupProblem(text) {
  let open = -1;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '[') {
      if (open >= 0) return 'nested-bracket';
      open = index;
    } else if (character === ']') {
      if (open < 0) return 'unmatched-bracket';
      const parts = text.slice(open + 1, index).split('|');
      if (parts.length > 2) return 'extra-separator';
      if (!parts[0]) return 'empty-key';
      open = -1;
    }
  }
  return open >= 0 ? 'unmatched-bracket' : null;
}

/**
 * The fields of one official table source (a recipe job entry; a request adds `file`). Returns the
 * spec. `keys` restricts the fields (the recipe form).
 */
export function validateTableSpec(spec, label, { exact = false } = {}) {
  require(object(spec) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(spec.repository ?? '') && typeof spec.tag === 'string' && spec.tag
    && /^[A-Za-z0-9_.-]+\.zip$/u.test(spec.asset ?? '') && Number.isSafeInteger(spec.bytes) && HEX64.test(spec.sha256 ?? '')
    && ['default', 'localized'].every(side => DIRECTORY.test(spec[side] ?? '')
      && spec[side].split('/').slice(0, -1).every(part => part !== '.' && part !== '..') && HEX64.test(spec[`${side}_manifest_sha256`] ?? ''))
    && spec.default !== spec.localized,
  `${label}: needs repository, tag, asset (*.zip), bytes, sha256, default and localized (directories ending in /) with their manifest_sha256`);
  require(Array.isArray(spec.scopes) && spec.scopes.length && new Set(spec.scopes).size === spec.scopes.length
    && spec.scopes.every(scope => TABLE_SCOPES.includes(scope)), `${label}: scopes lists distinct scopes of ${TABLE_SCOPES.join(', ')}`);
  if (exact) require(Object.keys(spec).every(key => SPEC_KEYS.includes(key)), `${label}: fields are ${SPEC_KEYS.join(', ')}`);
  return spec;
}

// One table package of the input archive: exactly manifest.json plus the files it pins, each equal to
// the root manifest's pin; the manifest equals its pinned SHA-256 and has the expected format.
function tablePackage(archive, rootFiles, directory, manifestSha256, side, asset) {
  const manifestRaw = archive.get(`${directory}manifest.json`)?.raw;
  require(manifestRaw && digest(manifestRaw) === manifestSha256, `${asset}: ${directory}manifest.json differs from the pinned ${side}_manifest_sha256`);
  const manifest = strictJson(manifestRaw);
  require(object(manifest) && manifest.format === FORMATS[side] && object(manifest.files) && object(manifest.source_identity),
    `${asset}: ${directory} is not a ${FORMATS[side]} package`);
  const expected = ['manifest.json', ...Object.keys(manifest.files)].map(name => directory + name).sort();
  const present = [...archive.keys()].filter(name => name.startsWith(directory)).sort();
  require(JSON.stringify(present) === JSON.stringify(expected) && Object.keys(manifest.files).includes('tables.json'),
    `${asset}: ${directory} must hold manifest.json and exactly the files it pins (with tables.json)`);
  for (const name of present) {
    const raw = archive.get(name).raw, local = name.slice(directory.length);
    require(object(rootFiles[name]) && rootFiles[name].bytes === raw.length && rootFiles[name].sha256 === digest(raw),
      `${asset}: ${name} differs from its root manifest pin`);
    if (local !== 'manifest.json') require(manifest.files[local].bytes === raw.length && manifest.files[local].sha256 === digest(raw),
      `${asset}: ${name} differs from its ${directory}manifest.json pin`);
  }
  return { manifest, manifestSha256, tables: strictJson(archive.get(`${directory}tables.json`).raw) };
}

// Map id -> field value (string or null) of one table; an Id seen twice maps to undefined (ambiguous).
function column(tables, table, field, label) {
  const body = tables[table];
  require(object(body) && Array.isArray(body.rows), `${label}: no ${table} table`);
  const values = new Map();
  for (const row of body.rows) {
    const { Id: id } = row?.values ?? {};
    require(typeof id === 'string' && Object.hasOwn(row.values, field), `${label}: ${table} rows need Id and ${field}`);
    const value = row.values[field];
    values.set(id, values.has(id) ? undefined : typeof value === 'string' ? value : null);
  }
  return values;
}

/**
 * Read one pinned input package. Returns {source (provenance for the receipt), scopes: Map scope ->
 * {english: Map id -> value, localized: Map id -> value}}. The localized package must be the
 * locale's language and realm (zh-CN: china; zh-TW: international); the default package the same realm.
 */
export function readOfficialTables(zipRaw, spec, locale) {
  const realm = TABLE_REALMS[locale];
  require(realm, `official_tables: no official table source for ${locale}`);
  const archive = readZip(zipRaw, name => name === 'manifest.json' || name.startsWith(spec.default) || name.startsWith(spec.localized));
  const rootRaw = archive.get('manifest.json')?.raw;
  require(rootRaw, `${spec.asset}: no root manifest.json`);
  const root = strictJson(rootRaw);
  require(object(root) && root.schema === INPUT_SCHEMA && object(root.files), `${spec.asset}: expected a ${INPUT_SCHEMA} manifest`);
  const english = tablePackage(archive, root.files, spec.default, spec.default_manifest_sha256, 'default', spec.asset);
  const localized = tablePackage(archive, root.files, spec.localized, spec.localized_manifest_sha256, 'localized', spec.asset);
  const identity = localized.manifest.source_identity;
  require(identity.language === LANGUAGES[locale], `${spec.asset}: ${spec.localized} is ${identity.language}, not ${LANGUAGES[locale]}`);
  require(identity.realm === realm, `${spec.asset}: ${spec.localized} is realm ${identity.realm}; official ${locale} needs realm ${realm}`);
  require(english.manifest.source_identity.realm === realm && english.manifest.source_identity.language == null,
    `${spec.asset}: ${spec.default} must be the default (English) tables of the same realm`);
  // Both sides are decoded from one client capture: the same patch and the same source lock. Rows are
  // paired by Id, so a localized package of another version would pair with the wrong English.
  require(HEX64.test(identity.source_lock_sha256 ?? '') && english.manifest.source_identity.source_lock_sha256 === identity.source_lock_sha256
    && typeof identity.game_patch === 'string' && english.manifest.source_identity.game_patch === identity.game_patch
    && (!object(root.target) || root.target.game_patch === undefined || root.target.game_patch === identity.game_patch),
  `${spec.asset}: ${spec.default} and ${spec.localized} must share one game_patch and source_lock_sha256 (one client capture)`);
  const scopes = new Map();
  for (const scope of spec.scopes) {
    const [table, field] = scope.split('.');
    scopes.set(scope, { english: column(english.tables, table, field, `${spec.asset} ${spec.default}`),
      localized: column(localized.tables, table, field, `${spec.asset} ${spec.localized}`) });
  }
  const side = (directory, pkg) => ({ member: directory, manifest_sha256: pkg.manifestSha256, format: pkg.manifest.format,
    source_identity: { realm: pkg.manifest.source_identity.realm, game_patch: pkg.manifest.source_identity.game_patch,
      source: pkg.manifest.source_identity.source, ...(pkg.manifest.source_identity.language ? { language: pkg.manifest.source_identity.language } : {}),
      source_lock_sha256: pkg.manifest.source_identity.source_lock_sha256, acquisition: pkg.manifest.source_identity.acquisition } });
  return {
    source: { realm, repository: spec.repository, tag: spec.tag, asset: spec.asset, bytes: spec.bytes, sha256: spec.sha256,
      ...(object(root.target) ? { package_target: root.target } : {}),
      default: side(spec.default, english), localized: side(spec.localized, localized), scopes: [...spec.scopes] },
    scopes,
  };
}

// The target English of the gem scopes: overlay/gem_descriptions.json of the game package.
export function gemTargets(doc, gamePatch) {
  require(object(doc) && object(doc._meta) && doc._meta.schema === GEM_DESCRIPTIONS_SCHEMA && object(doc.scopes),
    `game_package: gem_descriptions.json is not ${GEM_DESCRIPTIONS_SCHEMA}`);
  require(doc._meta.game_patch === undefined || doc._meta.game_patch === gamePatch, `gem_descriptions.json is for ${doc._meta.game_patch}`);
  const targets = new Map();
  for (const scope of GEM_SCOPES) {
    const rows = doc.scopes[scope];
    require(object(rows) && Object.values(rows).every(value => typeof value === 'string'), `gem_descriptions.json: ${scope} maps id -> English`);
    targets.set(scope, new Map(Object.entries(rows)));
  }
  return targets;
}

const emptyCounts = () => ({ adopted: 0, shadowed: 0, 'not-in-game': 0, 'ambiguous-target': 0, 'ambiguous-id': 0, 'no-default-row': 0,
  'english-differs': 0, untranslated: 0, 'no-han': 0, 'broken-markup': 0 });

/**
 * Pure core. sources: readOfficialTables() results, newest first; targets: Map scope -> Map id ->
 * target English (null when ambiguous). Returns {scopes: Map scope -> Map id -> [english, localized]},
 * per-source counts per scope, the target ids no source adopted, and the decided source of each id.
 * Throws on unpaired markup in the target English of a row it would adopt; a localized value with
 * unpaired markup is omitted ('broken-markup').
 */
export function pairOfficialTables(sources, targets) {
  const scopes = new Map(), counts = sources.map(() => ({})), missing = {};
  for (const scope of new Set(sources.flatMap(source => [...source.scopes.keys()]))) {
    const rows = new Map(), target = targets.get(scope);
    require(target instanceof Map, `official_tables: no target English for ${scope}`);
    sources.forEach((source, index) => {
      const pair = source.scopes.get(scope);
      if (!pair) return;
      const tally = counts[index][scope] = emptyCounts();
      for (const [id, text] of pair.localized) {
        const english = target.get(id), own = pair.english.get(id);
        let reason;
        if (rows.has(id)) reason = 'shadowed';
        else if (english === undefined) reason = 'not-in-game';
        else if (english === null) reason = 'ambiguous-target';
        else if (!pair.english.has(id)) reason = 'no-default-row';
        else if (text === undefined || own === undefined) reason = 'ambiguous-id';
        else if (own !== english) reason = 'english-differs';
        else if (typeof text !== 'string' || !text.trim() || text === english) reason = 'untranslated';
        else if (!han(text)) reason = 'no-han';
        else {
          // Broken markup in the target English is a new form or a producer bug: fail loudly. A
          // localized value with broken markup (client typos such as the zh-TW herald_of_blood
          // "[BloodLoss|失血影響。" and frost_darts "[Projectile|Projectiles|投射物]") is omitted like
          // any other unusable row.
          const problem = markupProblem(english);
          require(!problem, `official_tables: ${scope} ${id} has ${problem} markup in its English: ${JSON.stringify(english)}`);
          if (markupProblem(text)) reason = 'broken-markup';
          else {
            rows.set(id, [english, text]);
            reason = 'adopted';
          }
        }
        tally[reason]++;
      }
    });
    // A scope official_tables owns but fills with nothing would silently drop every catalog row of it.
    require(rows.size > 0, `official_tables: ${scope} adopts no row (wrong package, scope or game package?)`);
    scopes.set(scope, new Map([...rows].sort(([a], [b]) => compare(a, b))));
    missing[scope] = [...target.keys()].filter(id => target.get(id) !== null && !rows.has(id)).length;
  }
  return { scopes, counts, missing };
}
