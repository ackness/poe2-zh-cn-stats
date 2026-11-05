// Language-package helpers shared by release:build and release:regenerate: the declared member
// transforms of a poe2-locale-release-config/v2 package, and the per-package language index the
// build receipt carries (PoBR checks every data/<patch>/i18n/* member against the game package's
// snapshot manifest, so a new member such as an index.json would be rejected; the index stays out
// of the zip).
import { createHash } from 'node:crypto';
import { strictJson } from './strict-json.mjs';

const sha256 = raw => createHash('sha256').update(raw).digest('hex');
const pin = raw => ({ bytes: raw.length, sha256: sha256(raw) });
const encoded = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function require(condition, message) {
  if (!condition) throw new Error(message);
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const MEMBER = /^i18n\/([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\/([a-z0-9_]+\.json)$/u;

// --- transforms ----------------------------------------------------------------------------------

export const TRANSFORM_KINDS = ['rekey-by-english', 'json'];
export const CONFLICT_POLICY = 'most-common-then-first-row';

export function validateTransforms(transforms) {
  require(Array.isArray(transforms) && transforms.length > 0, 'A v2 release config declares at least one transform');
  const ids = new Set(), members = new Set();
  for (const transform of transforms) {
    require(object(transform) && /^[a-z0-9][a-z0-9-]*$/u.test(transform.id ?? '') && !ids.has(transform.id),
      `Invalid or duplicate transform id: ${transform?.id}`);
    ids.add(transform.id);
    require(TRANSFORM_KINDS.includes(transform.kind), `${transform.id}: unknown transform kind ${transform.kind}`);
    require(MEMBER.test(transform.member ?? '') && !members.has(transform.member), `${transform.id}: invalid or repeated member`);
    members.add(transform.member);
    if (transform.kind === 'rekey-by-english') {
      const keys = ['id', 'kind', 'member', 'records', 'table', 'conflicts'];
      require(Object.keys(transform).sort().join() === keys.sort().join(), `${transform.id}: expected fields ${keys}`);
      require(/^evidence\/.+\.json$/u.test(transform.records) && transform.table === transform.member.split('/').at(-1)
        && transform.conflicts === CONFLICT_POLICY, `${transform.id}: invalid records/table/conflicts`);
    } else {
      require(Object.keys(transform).sort().join() === 'id,kind,member,value' && object(transform.value),
        `${transform.id}: a json transform has id, kind, member and an object value`);
    }
  }
}

// A name table keyed by stable id (zh-TW mods.json: mod id -> name) re-keyed by the English text
// the pairing used (English affix name -> name), as zh-CN's table and PoBR's affix lookup are.
// The records are the pairing receipt (pobr-native-name-receipt/v1) that pins exactly these bytes.
// One English text can carry several translations (the client translates each mod row); the most
// common one wins, a tie goes to the translation of the lowest English row. Every choice is reported.
export function rekeyByEnglish(memberRaw, recordsRaw, table) {
  const receipt = strictJson(recordsRaw);
  require(receipt.schema === 'pobr-native-name-receipt/v1', 'The records are not a pobr-native-name-receipt/v1');
  const expected = receipt.files?.[table];
  require(expected && expected.bytes === memberRaw.length && expected.sha256 === sha256(memberRaw),
    `The name receipt does not pin these ${table} bytes`);
  const adopted = receipt.records?.[table]?.adopted;
  require(Array.isArray(adopted), `The name receipt has no adopted ${table} records`);
  const byId = new Map();
  for (const record of adopted) {
    require(typeof record?.id === 'string' && !byId.has(record.id) && typeof record.english === 'string' && record.english
      && typeof record.localized === 'string' && Number.isSafeInteger(record.english_row), `Invalid adopted ${table} record`);
    byId.set(record.id, record);
  }
  const member = strictJson(memberRaw);
  require(object(member), `${table} is not an object`);
  const ids = Object.keys(member);
  require(ids.length === byId.size && ids.every(id => byId.get(id)?.localized === member[id]),
    `${table} entries differ from the receipt's adopted records`);
  const groups = new Map();
  for (const id of ids) {
    const { english, localized, english_row: row } = byId.get(id);
    if (!groups.has(english)) groups.set(english, new Map());
    const texts = groups.get(english);
    const seen = texts.get(localized) ?? { count: 0, row };
    texts.set(localized, { count: seen.count + 1, row: Math.min(seen.row, row) });
  }
  const out = {}, conflicts = [];
  for (const english of [...groups.keys()].sort(compare)) {
    const ranked = [...groups.get(english)].sort(([, a], [, b]) => b.count - a.count || a.row - b.row);
    out[english] = ranked[0][0];
    if (ranked.length > 1) {
      conflicts.push({ english, chosen: ranked[0][0], alternatives: Object.fromEntries(ranked.map(([text, { count }]) => [text, count])) });
    }
  }
  return { raw: encoded(out), report: { ids: ids.length, english_keys: groups.size, conflicts } };
}

// Apply the transforms to `members` (Map 'i18n/<lang>/<file>' -> bytes) using `evidence`
// (Map 'evidence/<file>' -> bytes). A json transform adds a member; rekey replaces one.
export function applyTransforms(transforms, members, evidence) {
  validateTransforms(transforms);
  const result = new Map(members), reports = [];
  for (const transform of transforms) {
    const before = result.get(transform.member);
    let raw, report, inputs;
    if (transform.kind === 'rekey-by-english') {
      require(before, `${transform.id}: ${transform.member} is not in the base package`);
      const records = evidence.get(transform.records);
      require(records, `${transform.id}: ${transform.records} is not in the base publication`);
      ({ raw, report } = rekeyByEnglish(before, records, transform.table));
      inputs = { [transform.member]: pin(before), [transform.records]: pin(records) };
    } else {
      require(!before, `${transform.id}: ${transform.member} already exists; a json transform only adds a member`);
      raw = encoded(transform.value);
      report = {};
      inputs = {};
    }
    result.set(transform.member, raw);
    reports.push({ id: transform.id, kind: transform.kind, member: transform.member, inputs, output: pin(raw), report });
  }
  return { members: result, reports };
}

// --- index ---------------------------------------------------------------------------------------

function tableKeys(file, value) {
  if (file === 'stat_lines.json' && Array.isArray(value)) return value.map(pair => JSON.stringify([pair?.src, pair?.en]));
  if (file === 'display_texts.json' && object(value?.entries)) {
    return Object.entries(value.entries).filter(([, text]) => typeof text === 'string').map(([english]) => english);
  }
  if (file === 'classes.json' && object(value)) {
    return Object.entries(value).flatMap(([group, names]) => (object(names) ? Object.keys(names).map(name => `${group}/${name}`) : []));
  }
  return object(value) ? Object.keys(value) : null;
}

// {languages: {<lang>: {fallback, tables: {<file>: {entries[, fallback_keys_covered]}}}}: what each
// language publishes, the fallback chain its _meta.json declares (none when it has no _meta.json),
// and, for a table its first fallback language also has, how many of that table's keys it covers
// (a low number for a table the two languages key differently).
export function localeIndex(members) {
  const languages = {};
  for (const [name, raw] of [...members].sort(([a], [b]) => compare(a, b))) {
    const match = MEMBER.exec(name);
    if (!match) continue;
    const [, lang, file] = match;
    languages[lang] ??= { fallback: [], tables: {} };
    const value = strictJson(raw);
    if (file === '_meta.json') {
      const fallback = value?.fallback;
      if (Array.isArray(fallback) && fallback.every(code => typeof code === 'string')) languages[lang].fallback = fallback;
      continue;
    }
    const keys = tableKeys(file, value);
    languages[lang].tables[file] = { entries: keys ? keys.length : null, keys };
  }
  for (const entry of Object.values(languages)) {
    const fallback = languages[entry.fallback[0]];
    for (const [file, table] of Object.entries(entry.tables)) {
      const other = fallback?.tables[file]?.keys;
      if (other && table.keys) {
        const own = new Set(table.keys);
        table.fallback_keys_covered = other.filter(key => own.has(key)).length;
        table.fallback_entries = other.length;
      }
    }
  }
  for (const entry of Object.values(languages)) for (const table of Object.values(entry.tables)) delete table.keys;
  return { languages };
}
