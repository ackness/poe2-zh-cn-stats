import { pairTrade } from './trade.mjs';
import { entryKey, normalizeText, slotCount } from './text.mjs';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = values => [...values].sort(compare);
const percent = (n, d) => d ? Math.round(n / d * 10000) / 100 : 0;
const localized = value => typeof value === 'string' && /\p{Script=Han}/u.test(value);

function tally(entries) {
  const texts = new Set(entries.map(e => e.english));
  const resolved = entries.filter(e => e.chinese !== null);
  const resolvedTexts = new Set(resolved.map(e => e.english));
  const ids = new Set(entries.map(e => e.id));
  const unresolvedIds = new Set(entries.filter(e => e.chinese === null).map(e => e.id));
  return {
    entries: entries.length, resolved_entries: resolved.length,
    ids: ids.size, fully_resolved_ids: ids.size - unresolvedIds.size,
    distinct_english: texts.size, covered_english: resolvedTexts.size,
    text_coverage_percent: percent(resolvedTexts.size, texts.size),
  };
}

/** Official translations win. Supplemental candidates must agree; ambiguity is data. */
export function buildDictionary({ english, chinese, supplementalPairs = [], overrides = [] }) {
  const trade = pairTrade(english, chinese);
  const entries = trade.entries;
  if (!entries.length) throw new Error('Refusing to generate an empty dictionary');
  const stages = {
    trade_only: tally(entries.map(e => e.method === 'explicit-reuse' ? { ...e, chinese: null } : e)),
    explicit_reuse: tally(entries),
  };
  const candidates = new Map();
  const conflicts = [];
  for (const pair of supplementalPairs) {
    if (!pair || typeof pair.english !== 'string' || !localized(pair.chinese) || !pair.proof?.enUrl || !pair.proof?.cnUrl) {
      throw new Error('Supplemental pair lacks localized text or source proof');
    }
    const en = normalizeText(pair.english);
    const cn = normalizeText(pair.chinese);
    if (!en || en === cn || slotCount(en) !== slotCount(cn)) {
      conflicts.push({ kind: 'invalid-supplemental-template', english: en, chinese: cn, proof: pair.proof });
      continue;
    }
    if (!candidates.has(en)) candidates.set(en, new Map());
    const translations = candidates.get(en);
    if (!translations.has(cn)) translations.set(cn, []);
    translations.get(cn).push(pair.proof);
  }
  const cnById = new Map();
  for (const group of chinese.result) for (const row of group.entries) {
    if (!cnById.has(row.id)) cnById.set(row.id, new Set());
    cnById.get(row.id).add(normalizeText(row.text));
  }
  for (const entry of entries) {
    const translations = candidates.get(entry.english);
    if (!translations) continue;
    const options = sorted(translations.keys());
    if (entry.chinese !== null) {
      if (options.some(cn => cn !== entry.chinese)) conflicts.push({
        kind: 'official-supplemental-difference', id: entry.id, english: entry.english,
        retained: entry.chinese, candidates: options,
      });
      continue;
    }
    if (options.length !== 1) {
      conflicts.push({ kind: 'supplemental-ambiguity', id: entry.id, english: entry.english, candidates: options });
      continue;
    }
    const cn = options[0];
    const official = cnById.get(entry.id);
    // A page may select a duplicate official branch, but may not contradict
    // existing official CN branches just because the official join was ambiguous.
    if (official && !official.has(cn)) {
      conflicts.push({ kind: 'supplemental-not-in-official-branches', id: entry.id,
        english: entry.english, official: sorted(official), candidate: cn });
      continue;
    }
    entry.chinese = cn;
    entry.method = 'poe2db';
    entry.reason = null;
    entry.evidence = translations.get(cn).map(proof => ({ source: 'poe2db', ...proof }));
  }
  stages.poe2db = tally(entries);

  if (!Array.isArray(overrides)) throw new Error('overrides.json must be an array');
  const indexed = new Map(entries.map(entry => [entryKey(entry), entry]));
  const applied = new Set();
  for (const override of overrides) {
    if (!override || typeof override.id !== 'string' || typeof override.english !== 'string'
        || !localized(override.chinese) || typeof override.reason !== 'string' || !override.reason.trim()
        || typeof override.source_url !== 'string' || !/^https:\/\//.test(override.source_url)) {
      throw new Error('An override requires id, english, Chinese text, reason and an HTTPS source_url');
    }
    const key = entryKey(override);
    const entry = indexed.get(key);
    if (!entry) throw new Error(`Stale override has no current English entry: ${override.id}`);
    if (applied.has(key)) throw new Error(`Duplicate override: ${override.id}`);
    applied.add(key);
    const cn = normalizeText(override.chinese);
    if (slotCount(entry.english) !== slotCount(cn)) throw new Error(`Override placeholder mismatch: ${override.id}`);
    if (entry.chinese !== null && entry.chinese !== cn) conflicts.push({
      kind: 'reviewed-override', id: entry.id, english: entry.english, previous: entry.chinese, replacement: cn,
    });
    entry.chinese = cn;
    entry.method = 'manual';
    entry.reason = null;
    entry.evidence = [{ source: 'manual', url: override.source_url, reason: override.reason }];
  }
  stages.manual = tally(entries);
  const methods = {};
  const reasons = {};
  const categories = {};
  const pairMap = new Map();
  for (const entry of entries) {
    methods[entry.method] = (methods[entry.method] ?? 0) + 1;
    if (entry.reason) reasons[entry.reason] = (reasons[entry.reason] ?? 0) + 1;
    if (!categories[entry.category]) categories[entry.category] = [];
    categories[entry.category].push(entry);
    if (entry.chinese === null) continue;
    const key = JSON.stringify([entry.english, entry.chinese]);
    if (!pairMap.has(key)) pairMap.set(key, { english: entry.english, chinese: entry.chinese, ids: [], methods: [] });
    const pair = pairMap.get(key);
    pair.ids.push(entry.id);
    pair.methods.push(entry.method);
  }
  const pairs = [...pairMap.values()].map(pair => ({ ...pair,
    ids: sorted(new Set(pair.ids)), methods: sorted(new Set(pair.methods)),
  })).sort((a, b) => compare(JSON.stringify([a.english, a.chinese]), JSON.stringify([b.english, b.chinese])));
  const textVariants = new Map();
  for (const pair of pairs) {
    if (!textVariants.has(pair.english)) textVariants.set(pair.english, []);
    textVariants.get(pair.english).push(pair.chinese);
  }
  const report = {
    scope: 'Current English trade2 catalog, excluding pseudo; structural translation coverage, not numerical game-mechanic coverage.',
    totals: tally(entries), stages, methods, unresolved_reasons: reasons,
    categories: Object.fromEntries(Object.entries(categories).map(([key, rows]) => [key, tally(rows)])),
    distinct_bilingual_pairs: pairs.length,
    ambiguous_text_translations: [...textVariants].filter(([, values]) => values.length > 1)
      .map(([english, translations]) => ({ english, translations })),
    cn_only: trade.cnOnly,
    trade_issues: trade.issues,
    supplemental_candidates: supplementalPairs.length,
    conflicts: conflicts.length,
  };
  conflicts.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return { entries, pairs, report, unresolved: entries.filter(e => e.chinese === null), conflicts };
}
