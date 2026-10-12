import { normalizeText, slotCount } from './text.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const localized = value => nonempty(value) && /\p{Script=Han}/u.test(value);
const sorted = values => [...values].sort(compare);
// Ignore formatting and numeric-vs-string capture syntax only for collision
// detection. Never rewrite reviewed text or erase signs, constants or conditions.
const identity = text => normalizeText(text).toLowerCase().replace(/\s/gu, '')
  .replace(/\{(\d+):d\}/g, '{$1}');
const pairKey = (en, src) => JSON.stringify([identity(en), identity(src)]);
const sortRecords = records => records.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));

function sourceUrl(value) {
  try {
    const url = new URL(value);
    return typeof value === 'string' && url.protocol === 'https:' && Boolean(url.hostname)
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function placeholders(text, label) {
  const slots = new Map();
  const rest = text.replace(/\{(0|[1-9]\d*)(:d)?\}/g, (_, index, format) => {
    const kind = format ? 'number' : 'capture';
    if (slots.has(index) && slots.get(index) !== kind) throw new Error(`Mixed placeholder formats: ${label}`);
    slots.set(index, kind);
    return '';
  });
  if (/[{}#]/u.test(rest)) throw new Error(`Unsupported braces or placeholder: ${label}`);
  const indexes = [...slots.keys()].map(Number).sort((a, b) => a - b);
  if (indexes.some((index, position) => index !== position)) throw new Error(`Non-contiguous placeholder index set: ${label}`);
  return JSON.stringify(indexes.map(index => [index, slots.get(String(index))]));
}

function validateCurated(curated) {
  if (!object(curated) || curated.schema_version !== 1
      || !Array.isArray(curated.templates) || !Array.isArray(curated.words)) {
    throw new Error('curated.json requires schema_version 1, templates and words arrays');
  }
  const ids = new Set();
  const pairs = new Set();
  const chineseByEnglish = new Map();
  for (const row of curated.templates) {
    if (!object(row) || !nonempty(row.id) || !/^[a-z0-9][a-z0-9._-]*$/u.test(row.id)
        || !nonempty(row.en) || !localized(row.src) || !nonempty(row.note) || !sourceUrl(row.source_url)) {
      throw new Error('Malformed curated template: requires id, en, Chinese src, note and HTTPS source_url');
    }
    if (ids.has(row.id)) throw new Error(`Duplicate curated template ID: ${row.id}`);
    ids.add(row.id);
    if (placeholders(row.src, row.id) !== placeholders(row.en, row.id)) {
      throw new Error(`Curated placeholder index set or format mismatch: ${row.id}`);
    }
    const key = pairKey(row.en, row.src);
    if (pairs.has(key)) throw new Error(`Duplicate curated template pair: ${row.id}`);
    pairs.add(key);
    const english = identity(row.en);
    const chinese = identity(row.src);
    if (chineseByEnglish.has(english) && chineseByEnglish.get(english) !== chinese) {
      throw new Error(`Conflicting curated English translation: ${row.id}`);
    }
    chineseByEnglish.set(english, chinese);
  }
  const words = new Set();
  for (const row of curated.words) {
    if (!object(row) || !nonempty(row.english) || !/^[A-Z][a-zA-Z']*$/u.test(row.english) || !localized(row.chinese)
        || !nonempty(row.note) || !sourceUrl(row.source_url)
        || /[{}#]/u.test(row.english + row.chinese)) {
      throw new Error('Malformed curated word: requires one capitalized ASCII english word, Chinese chinese, note and HTTPS source_url without placeholders');
    }
    const key = identity(row.english);
    if (words.has(key)) throw new Error(`Duplicate curated word: ${row.english}`);
    words.add(key);
  }
}

function numericLiterals(text) {
  return sorted(text.match(/[+-]?\d+(?:\.\d+)?/g) ?? []).join('|');
}

function automaticReason(entry) {
  if (entry.chinese === null) return 'unresolved';
  if (!localized(entry.chinese)) return 'non-chinese';
  if (/[{}]/u.test(entry.english + entry.chinese)) return 'unsupported-braces';
  const enSlots = slotCount(entry.english);
  if (enSlots !== slotCount(entry.chinese)) return 'placeholder-arity';
  if (enSlots > 1) return 'multiple-slots';
  if (numericLiterals(entry.english) !== numericLiterals(entry.chinese)) return 'literal-number-mismatch';
  const sign = text => text.match(/([+-])\s*#/u)?.[1] ?? '';
  if (sign(entry.english) !== sign(entry.chinese)) return 'placeholder-sign-mismatch';
  return null;
}

function addMapping(map, from, to) {
  if (!map.has(from)) map.set(from, new Set());
  map.get(from).add(to);
}

/** Pure build-time adapter: dictionary entries retain their full IDs and evidence.
 * Reviewed curated aliases survive verbatim. Automatic records require a unique
 * translation in both directions and never manufacture reduced/negative forms.
 * Words are reviewed rare-name fallback patches: consumers apply them with ??=
 * to rareWords, not to skill, base-item, or other independently sourced names.
 */
export function buildPobrExport({ snapshot, entries, curated }) {
  if (!nonempty(snapshot) || !Array.isArray(entries)) throw new Error('PoBR export requires snapshot and dictionary entries');
  validateCurated(curated);
  const templates = curated.templates.map(({ id, src, en, note, source_url }) => ({
    src, en, kind: 'curated', provenance: { id, note, source_url },
  }));
  const words = curated.words.map(({ english, chinese, note, source_url }) => ({ english, chinese, note, source_url }));
  const excluded = [];
  const candidates = new Map();
  const enToCn = new Map();
  const cnToEn = new Map();
  const curatedPairs = new Set();
  for (const template of templates) {
    addMapping(enToCn, identity(template.en), identity(template.src));
    addMapping(cnToEn, identity(template.src), identity(template.en));
    curatedPairs.add(pairKey(template.en, template.src));
  }
  for (const entry of entries) {
    if (!object(entry) || !nonempty(entry.id) || !nonempty(entry.english)
        || (entry.chinese !== null && !nonempty(entry.chinese))
        || !nonempty(entry.method) || !Array.isArray(entry.evidence)
        || (entry.chinese !== null && !entry.evidence.length)) {
      throw new Error('Malformed PoBR dictionary entry: requires full id, text, method and evidence');
    }
    const provenance = { id: entry.id, english: entry.english, chinese: entry.chinese,
      method: entry.method, evidence: entry.evidence };
    // Even an ineligible branch can demonstrate a conflict with an otherwise
    // exportable pair; filtering it first would accidentally resolve ambiguity.
    if (entry.chinese !== null) {
      addMapping(enToCn, identity(entry.english.replaceAll('#', '{0:d}')),
        identity(entry.chinese.replaceAll('#', '{0:d}')));
      addMapping(cnToEn, identity(entry.chinese.replaceAll('#', '{0:d}')),
        identity(entry.english.replaceAll('#', '{0:d}')));
    }
    const reason = automaticReason(entry);
    if (reason) {
      excluded.push({ reason, provenance });
      continue;
    }
    const en = normalizeText(entry.english).replace('#', '{0:d}');
    const src = normalizeText(entry.chinese).replace('#', '{0:d}');
    const key = pairKey(en, src);
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push({ en, src, provenance });
  }
  for (const [key, records] of candidates) {
    // Stable representative and attribution regardless of catalog order; all
    // contributing full ID/text branches remain available in provenance.
    records.sort((a, b) => compare(a.src, b.src) || compare(a.en, b.en));
    const { en, src } = records[0];
    const provenance = { entries: sortRecords([...new Map(records.map(record =>
      [JSON.stringify(record.provenance), record.provenance])).values()]) };
    const reasons = [];
    if (enToCn.get(identity(en)).size > 1) reasons.push('ambiguous-en-to-cn');
    if (cnToEn.get(identity(src)).size > 1) reasons.push('ambiguous-cn-to-en');
    if (curatedPairs.has(key)) reasons.push('curated-precedence');
    if (reasons.length) excluded.push({ reasons, src, en, provenance });
    else templates.push({ src, en, kind: 'trade', provenance });
  }
  templates.sort((a, b) => compare(a.src, b.src) || compare(a.en, b.en));
  words.sort((a, b) => compare(a.english, b.english));
  sortRecords(excluded);
  return { schema_version: 1, snapshot, templates, words, excluded };
}
