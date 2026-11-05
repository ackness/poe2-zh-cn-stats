import { normalizeText, slotCount } from './text.mjs';

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(path, reason) {
  throw new TypeError(`Malformed trade response at ${path}: ${reason}`);
}

function collect(response, locale, issues) {
  if (!isObject(response) || !Array.isArray(response.result)) {
    invalid(locale, 'expected an object with a result array');
  }
  const records = new Map();
  let skippedPseudo = 0;
  for (const [groupIndex, group] of response.result.entries()) {
    const path = `${locale}.result[${groupIndex}]`;
    if (!isObject(group)) invalid(path, 'expected a group object');
    if (typeof group.id !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(group.id)) {
      invalid(`${path}.id`, 'expected a category identifier');
    }
    if (typeof group.label !== 'string' || !normalizeText(group.label)) {
      invalid(`${path}.label`, 'expected a nonempty label');
    }
    if (!Array.isArray(group.entries)) invalid(`${path}.entries`, 'expected an array');
    for (const [index, entry] of group.entries.entries()) {
      const entryPath = `${path}.entries[${index}]`;
      if (!isObject(entry)) invalid(entryPath, 'expected an entry object');
      if (typeof entry.id !== 'string'
        || !/^[a-z][a-z0-9_]*\.[A-Za-z0-9_]+(?:\|[^|\s]+)*$/u.test(entry.id)
        || !entry.id.startsWith(`${group.id}.`)) {
        invalid(`${entryPath}.id`, 'expected a complete ID in its declared category');
      }
      if (typeof entry.text !== 'string' || !normalizeText(entry.text)) {
        invalid(`${entryPath}.text`, 'expected nonempty text');
      }
      // Display type may differ from category (rune is displayed as augment).
      if (entry.type !== undefined && (typeof entry.type !== 'string' || !normalizeText(entry.type))) {
        invalid(`${entryPath}.type`, 'expected a nonempty string when supplied');
      }
      // Validate even deliberately excluded records, so malformed data is never hidden.
      if (group.id === 'pseudo') {
        skippedPseudo += 1;
        continue;
      }
      let record = records.get(entry.id);
      if (!record) {
        record = { id: entry.id, category: group.id, texts: new Set() };
        records.set(entry.id, record);
      }
      record.texts.add(normalizeText(entry.text));
    }
  }
  if (skippedPseudo) issues.push({ code: 'pseudo-skipped', locale, count: skippedPseudo });
  return records;
}

function mismatch(english, chinese) {
  if (english === chinese) return 'untranslated-cn';
  // Symbol-only text is not accepted: it provides no evidence of localization.
  if (!/\p{Script=Han}/u.test(chinese)) return 'non-chinese-cn';
  if (slotCount(english) !== slotCount(chinese)) return 'placeholder-arity';
  return null;
}

/** Pair unique full-ID branches; neither array order nor stat-number alone is evidence. */
export function pairTrade(englishResponse, chineseResponse) {
  const issues = [];
  const english = collect(englishResponse, 'en', issues);
  const chinese = collect(chineseResponse, 'cn', issues);
  const entries = [];
  const byId = new Map();
  for (const id of [...english.keys()].sort(compare)) {
    const source = english.get(id);
    const target = chinese.get(id);
    const englishTexts = [...source.texts].sort(compare);
    const chineseTexts = target ? [...target.texts].sort(compare) : [];
    let reason = null;
    if (englishTexts.length !== 1) reason = 'ambiguous-en-branches';
    else if (chineseTexts.length === 0) reason = 'missing-cn';
    else if (chineseTexts.length !== 1) reason = 'ambiguous-cn-branches';
    else reason = mismatch(englishTexts[0], chineseTexts[0]);
    const records = englishTexts.map(text => ({
      id,
      category: source.category,
      english: text,
      chinese: reason ? null : chineseTexts[0],
      method: reason ? 'unresolved' : 'trade',
      reason,
      evidence: reason ? [] : [{ source: 'trade-cn', id, text: chineseTexts[0] }],
    }));
    entries.push(...records);
    byId.set(id, records);
  }

  for (const entry of entries) {
    if (entry.method !== 'unresolved' || entry.category !== 'fractured') continue;
    // Never replace an existing CN fractured payload, even if it is invalid or ambiguous.
    if (chinese.has(entry.id)) continue;
    const explicitId = `explicit.${entry.id.slice('fractured.'.length)}`;
    const candidates = byId.get(explicitId);
    if (candidates?.length !== 1) continue;
    const candidate = candidates[0];
    if (candidate.method !== 'trade' || candidate.english !== entry.english) continue;
    entry.chinese = candidate.chinese;
    entry.method = 'explicit-reuse';
    entry.reason = null;
    entry.evidence = [{ source: 'trade-cn', id: explicitId, text: candidate.chinese }];
  }

  for (const entry of entries) {
    if (entry.reason) {
      issues.push({ code: entry.reason, id: entry.id, english: entry.english,
        chineseTexts: [...(chinese.get(entry.id)?.texts ?? [])].sort(compare) });
    }
  }
  const cnOnly = [...chinese.values()]
    .filter(record => !english.has(record.id))
    .sort((a, b) => compare(a.id, b.id))
    .map(record => ({ id: record.id, category: record.category, texts: [...record.texts].sort(compare) }));
  issues.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { entries, issues, cnOnly };
}
