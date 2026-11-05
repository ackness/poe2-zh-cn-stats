// curation/display-supplements.json (poe2-display-supplements/v1): this project's own zh-CN text for
// what no official source supplies yet. Two inputs live here:
// - `entries`: stat-line templates outside the trade catalog and names with no catalog table
//   (MonsterVarieties.Name), keyed by entry_id = SHA-256 of the canonical identity;
// - `corrections`: declared, exact row edits of a pinned base stat_lines.json member (a wrong legacy
//   prefix, a literal backslash where a line break belongs), each with its basis and review.
// Every record names its origin (agent | human); nothing here is ever official. Only `reviewed`
// records ship. The producers (pobr:supplement-lines, pobr:display-texts) compute the lifecycle
// against their pinned inputs: official text always wins, a record is never relabelled or deleted.
import { createHash } from 'node:crypto';

export const SCHEMA = 'poe2-display-supplements/v1';
export const ORIGINS = ['agent', 'human'];
export const STATUSES = ['draft', 'reviewed', 'rejected'];
export const KINDS = ['stat-line', 'monster-name'];
export const BASES = ['official-same-id-branch', 'official-same-text', 'official-composed', 'official-terms',
  'poe1-official', 'community', 'own'];
// A correction repairs existing text; `format-repair` changes only layout characters.
export const CORRECTION_BASES = ['official-terms', 'official-same-text', 'format-repair'];
export const NAME_SCOPE = 'MonsterVarieties.Name';

const HEX64 = /^[0-9a-f]{64}$/u;
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const require = (ok, message) => { if (!ok) throw new Error(message); };
const keys = (value, required, optional, label) => {
  require(object(value), `${label}: expected an object`);
  const present = Object.keys(value);
  require(required.every(key => present.includes(key)) && present.every(key => required.includes(key) || optional.includes(key)),
    `${label}: fields must be ${required.join(', ')}${optional.length ? ` (optional ${optional.join(', ')})` : ''}`);
};

// Recursively key-sorted compact JSON; equals Python's json.dumps(sort_keys=True, ensure_ascii=False,
// separators=(',', ':')), which the inventory generator used for the batch keys.
export const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
export const entryId = identity => createHash('sha256').update(canonical(identity)).digest('hex');

// --- template form ---------------------------------------------------------------------------------

const TOKEN = /\{(0|[1-9]\d*)(?::([^{}]*))?\}/gu;
const numbers = text => (text.replace(TOKEN, ' ').match(/\d+(?:\.\d+)?/gu) ?? []).sort().join('|');
const tokens = text => [...text.matchAll(TOKEN)].map(match => match[0]).sort().join('|');

// A shipped template must keep the English form exactly: the same placeholder tokens (`{0}`,
// `{0:+d}` spelled alike, so the same indexes; game templates such as `Skills fire {1} additional
// Projectiles` need not start at 0), the same literal numbers outside them and the same number of
// lines. Returns the first problem or null.
export function templateProblem(english, text) {
  if (typeof text !== 'string' || !/\p{Script=Han}/u.test(text)) return 'not-chinese';
  if (text !== text.trim() || /\\/u.test(text) || /\r/u.test(text)) return 'stray-whitespace-or-backslash';
  if (/[{}#]/u.test(text.replace(TOKEN, '')) || /[{}#]/u.test(english.replace(TOKEN, ''))) return 'unsupported-braces';
  if (tokens(english) !== tokens(text)) return 'placeholder-mismatch';
  if (numbers(english) !== numbers(text)) return 'literal-number-mismatch';
  if (english.split('\n').length !== text.split('\n').length) return 'line-count-mismatch';
  return null;
}

// --- validation ------------------------------------------------------------------------------------

function review(value, status, label) {
  if (status === 'draft') require(value === null || value === undefined, `${label}: a draft has review null`);
  else {
    keys(value, ['by', 'note'], [], `${label}.review`);
    require(nonempty(value.by) && nonempty(value.note), `${label}: a ${status} record names its reviewer (review.by) and a note`);
  }
}

function attribution(record, label, bases) {
  require(ORIGINS.includes(record.origin), `${label}: origin must be agent or human`);
  require(bases.includes(record.basis), `${label}: basis must be one of ${bases.join(', ')}`);
  require(nonempty(record.author) && nonempty(record.note), `${label}: author and note are required`);
  require(STATUSES.includes(record.status), `${label}: status must be draft, reviewed or rejected`);
  review(record.review, record.status, label);
}

function validateIdentity(identity, label) {
  const kind = identity?.kind;
  require(KINDS.includes(kind), `${label}: identity.kind must be one of ${KINDS.join(', ')}`);
  keys(identity, kind === 'stat-line' ? ['game', 'realm', 'locale', 'kind', 'english', 'stats']
    : ['game', 'realm', 'locale', 'kind', 'table', 'field', 'english'], [], `${label}.identity`);
  require(identity.game === 'poe2' && nonempty(identity.realm) && nonempty(identity.locale) && nonempty(identity.english)
    && identity.english === identity.english.trim(), `${label}: identity needs game poe2, realm, locale and trimmed English`);
  if (kind === 'stat-line') {
    require(Array.isArray(identity.stats) && identity.stats.length && identity.stats.every(nonempty)
      && identity.stats.every((stat, index) => index === 0 || identity.stats[index - 1] < stat),
    `${label}: identity.stats lists the template's stat ids, sorted and distinct`);
  } else {
    require(`${identity.table}.${identity.field}` === NAME_SCOPE, `${label}: a monster-name identity is ${NAME_SCOPE}`);
  }
}

function validateBasedOn(value, label) {
  keys(value, ['game_patch', 'game_package', 'stat_descriptions_sha256'], [], `${label}.based_on`);
  keys(value.game_package, ['repository', 'tag', 'sha256'], [], `${label}.based_on.game_package`);
  require(nonempty(value.game_patch) && nonempty(value.game_package.repository) && nonempty(value.game_package.tag)
    && HEX64.test(value.game_package.sha256) && HEX64.test(value.stat_descriptions_sha256),
  `${label}: based_on pins the game patch, game package (repository, tag, sha256) and its stat descriptions`);
}

function validateEntry(entry, label) {
  keys(entry, ['entry_id', 'identity', 'ids', 'based_on', 'text', 'origin', 'basis', 'author', 'note', 'status', 'review'],
    ['confidence'], label);
  validateIdentity(entry.identity, label);
  require(entry.entry_id === entryId(entry.identity), `${label}: entry_id must be the SHA-256 of the canonical identity`);
  validateBasedOn(entry.based_on, label);
  attribution(entry, label, BASES);
  require(entry.confidence === undefined || ['high', 'medium', 'low'].includes(entry.confidence), `${label}: confidence is high, medium or low`);
  if (entry.identity.kind === 'stat-line') require(entry.ids === null, `${label}: a stat-line has ids null`);
  else require(Array.isArray(entry.ids) && entry.ids.length && entry.ids.every(nonempty) && new Set(entry.ids).size === entry.ids.length,
    `${label}: a monster-name lists the distinct MonsterVarieties ids it names`);
  require(entry.text === null ? entry.status !== 'reviewed' : nonempty(entry.text), `${label}: text is nonempty (null only when not reviewed)`);
  if (entry.status === 'reviewed') {
    const problem = entry.identity.kind === 'stat-line' ? templateProblem(entry.identity.english, entry.text)
      : !/\p{Script=Han}/u.test(entry.text) || entry.text !== entry.text.trim() || /[\n{}#\\]/u.test(entry.text) ? 'not-a-name' : null;
    require(!problem, `${label}: reviewed text fails the form check (${problem})`);
  }
}

function validateCorrection(correction, label) {
  keys(correction, ['correction_id', 'locale', 'member', 'rows', 'origin', 'basis', 'author', 'note', 'evidence', 'status', 'review'], [], label);
  require(SLUG.test(correction.correction_id ?? ''), `${label}: correction_id is a lowercase slug`);
  require(nonempty(correction.locale) && correction.member === 'stat_lines.json', `${label}: a correction edits <locale> stat_lines.json`);
  attribution(correction, label, CORRECTION_BASES);
  require(Array.isArray(correction.evidence) && correction.evidence.length && correction.evidence.every(nonempty),
    `${label}: evidence lists what the basis rests on`);
  require(Array.isArray(correction.rows) && correction.rows.length, `${label}: rows lists the exact {from, to} pairs`);
  for (const [index, row] of correction.rows.entries()) {
    const where = `${label}.rows[${index}]`;
    keys(row, ['from', 'to'], [], where);
    for (const side of ['from', 'to']) {
      keys(row[side], ['src', 'en'], [], `${where}.${side}`);
      require(nonempty(row[side].src) && nonempty(row[side].en), `${where}.${side}: src and en are nonempty`);
    }
    require(row.from.src !== row.to.src || row.from.en !== row.to.en, `${where}: from and to are the same pair`);
    if (correction.status === 'reviewed') {
      const problem = templateProblem(row.to.en, row.to.src);
      require(!problem, `${where}: the corrected pair fails the form check (${problem})`);
    }
  }
}

// Throws unless `doc` is a valid file; returns it. Ids are unique; a pair is corrected at most once.
export function validateSupplements(doc) {
  keys(doc, ['schema', 'entries', 'corrections'], [], 'display-supplements');
  require(doc.schema === SCHEMA && Array.isArray(doc.entries) && Array.isArray(doc.corrections),
    `display-supplements: expected schema ${SCHEMA} with entries and corrections arrays`);
  const ids = new Set();
  for (const [index, entry] of doc.entries.entries()) {
    validateEntry(entry, `entries[${index}]`);
    require(!ids.has(entry.entry_id), `entries[${index}]: duplicate entry_id ${entry.entry_id}`);
    ids.add(entry.entry_id);
  }
  const correctionIds = new Set(), pairs = new Set();
  for (const [index, correction] of doc.corrections.entries()) {
    validateCorrection(correction, `corrections[${index}]`);
    require(!correctionIds.has(correction.correction_id), `corrections[${index}]: duplicate correction_id`);
    correctionIds.add(correction.correction_id);
    for (const row of correction.rows) {
      const key = JSON.stringify([correction.locale, row.from.src, row.from.en]);
      require(!pairs.has(key), `corrections[${index}]: ${row.from.en} is corrected twice`);
      pairs.add(key);
    }
  }
  return doc;
}

// --- game package ----------------------------------------------------------------------------------

// English template -> sorted stat ids, over every scope's descriptors and compound descriptors of a
// game package's overlay/stat_descriptions.json (the identity rule of the inventory).
export function statTemplates(descriptions) {
  require(object(descriptions?.scopes), 'stat_descriptions.json: expected scopes');
  const templates = new Map();
  for (const body of Object.values(descriptions.scopes)) {
    for (const part of ['descriptors', 'compound']) {
      for (const [key, descriptor] of Object.entries(body?.[part] ?? {})) {
        const stats = descriptor.member_stats ?? [key];
        for (const branch of descriptor.branches ?? [descriptor]) {
          if (!nonempty(branch?.template)) continue;
          if (!templates.has(branch.template)) templates.set(branch.template, new Set());
          for (const stat of stats) templates.get(branch.template).add(stat);
        }
      }
    }
  }
  return new Map([...templates].map(([english, stats]) => [english, [...stats].sort()]));
}

// --- official names ----------------------------------------------------------------------------

// A RePoE-decoded MonsterVarieties.Name table of one client (the shape RePoE's monster-names
// research files use): {format, localized: {language, game_patch, realm, …} | locale, client identity
// (index_identity or observed_client with at least one SHA-256), names: {<variety id>: {english,
// <zh_cn|zh_tw>}}}. The text field is the locale with '-' -> '_', lowercased. Returns the parts the
// projection uses; throws unless the file is for `target` (locale, game_patch when declared).
const LANGUAGES = { 'Simplified Chinese': 'zh-CN', 'Traditional Chinese': 'zh-TW' };
export function validateOfficialNames(doc, target) {
  require(object(doc) && nonempty(doc.format) && object(doc.names), 'official names: expected {format, names, …}');
  const locale = doc.locale ?? LANGUAGES[doc.localized?.language];
  require(locale === target.locale, `official names: locale ${locale} differs from ${target.locale}`);
  const patch = doc.game_patch ?? doc.localized?.game_patch;
  require(patch === undefined || patch === target.game_patch, `official names: game_patch ${patch} differs from ${target.game_patch}`);
  const client = doc.index_identity ?? doc.observed_client;
  const hashes = object(client) ? Object.entries(client).filter(([key, value]) => /sha256$/u.test(key) && HEX64.test(value ?? '')) : [];
  require(hashes.length, 'official names: the client identity (index_identity or observed_client with a SHA-256) is required');
  const field = locale.toLowerCase().replace('-', '_');
  const names = new Map();
  for (const [id, row] of Object.entries(doc.names)) {
    keys(row, ['english', field], [], `official names[${id}]`);
    require(nonempty(id) && typeof row.english === 'string' && (row[field] === null || typeof row[field] === 'string'),
      `official names[${id}]: english is text, ${field} is text or null`);
    names.set(id, { english: row.english, text: row[field] });
  }
  return { format: doc.format, locale, game_patch: patch ?? null, realm: doc.realm ?? doc.localized?.realm ?? null,
    client: Object.fromEntries(hashes), names };
}
