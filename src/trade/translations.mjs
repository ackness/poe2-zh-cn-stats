import { entryKey, normalizeText, slotCount } from './text.mjs';

// Optional supplement attribution (docs/trade-dictionary.md). Absent fields keep the
// historical meaning: a human-written, reviewed row. Only present fields are carried,
// so tables without them stay byte-identical.
export const MANUAL_ORIGINS = ['agent', 'human'];
export const MANUAL_STATUSES = ['draft', 'reviewed', 'rejected'];
export const MANUAL_BASES = ['official-same-id-branch', 'official-same-text', 'official-composed', 'official-terms',
  'official-same-stat-other-category', 'client-dictionary-same-line', 'poe1-official', 'community', 'own'];
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

function attribution(row) {
  const fields = {};
  if (row.manual_origin !== undefined) {
    if (!MANUAL_ORIGINS.includes(row.manual_origin)) throw new Error(`manual_origin must be agent or human: ${row.id}`);
    fields.manual_origin = row.manual_origin;
  }
  if (row.manual_basis !== undefined) {
    if (!MANUAL_BASES.includes(row.manual_basis)) throw new Error(`Unknown manual_basis: ${row.id}`);
    fields.manual_basis = row.manual_basis;
  }
  // A model id, a GitHub account, or a deterministic generator id; only its presence is checked.
  if (row.manual_author !== undefined) {
    if (!nonempty(row.manual_author)) throw new Error(`manual_author must be nonempty text: ${row.id}`);
    fields.manual_author = row.manual_author;
  }
  if (row.manual_status !== undefined) {
    if (!MANUAL_STATUSES.includes(row.manual_status)) throw new Error(`manual_status must be draft, reviewed or rejected: ${row.id}`);
    fields.manual_status = row.manual_status;
  }
  if (row.manual_review !== undefined) {
    const review = row.manual_review;
    if (review !== null && !(typeof review === 'object' && !Array.isArray(review)
        && JSON.stringify(Object.keys(review).sort()) === '["by","note"]' && nonempty(review.by) && nonempty(review.note))) {
      throw new Error(`manual_review must be null or {by, note}: ${row.id}`);
    }
    fields.manual_review = review;
  }
  // Agent work is never implicitly reviewed; a verdict names its reviewer.
  if (fields.manual_origin === 'agent' && (!fields.manual_status || !fields.manual_author)) {
    throw new Error(`An agent translation requires manual_status and manual_author: ${row.id}`);
  }
  if (['reviewed', 'rejected'].includes(fields.manual_status) && !fields.manual_review) {
    throw new Error(`A ${fields.manual_status} translation requires manual_review {by, note}: ${row.id}`);
  }
  return fields;
}

// The text a row contributes: absent status means reviewed; draft and rejected rows are kept, not applied.
const appliedChinese = fields => (fields.manual_status ?? 'reviewed') === 'reviewed' ? fields.manual_chinese : null;

function manualFields(row) {
  if (!row || typeof row.id !== 'string' || !/^[a-z_]+\.[^\s]+$/.test(row.id)
      || typeof row.english !== 'string' || !normalizeText(row.english)) {
    throw new Error('A translation row requires a full id and nonempty English text');
  }
  if (row.manual_chinese != null && typeof row.manual_chinese !== 'string') {
    throw new Error(`manual_chinese must be text or null: ${row.id}`);
  }
  const chinese = normalizeText(row.manual_chinese ?? '') || null;
  const note = row.manual_note ?? '';
  const url = row.manual_source_url === '' ? null : row.manual_source_url ?? null;
  if (typeof note !== 'string') throw new Error(`manual_note must be text: ${row.id}`);
  if (url !== null) {
    let valid = false;
    try { valid = typeof url === 'string' && new URL(url).protocol === 'https:'; } catch {}
    if (!valid) throw new Error(`manual_source_url must be an HTTPS URL or null: ${row.id}`);
  }
  const english = normalizeText(row.english);
  const extra = attribution(row);
  if (extra.manual_status === 'reviewed' && chinese === null) throw new Error(`A reviewed translation requires manual_chinese: ${row.id}`);
  if (chinese !== null && extra.manual_status !== 'rejected') {
    if (!/\p{Script=Han}/u.test(chinese) || chinese === english || !note.trim()) {
      throw new Error(`A manual translation requires Chinese text and a review note: ${row.id}`);
    }
    if (slotCount(english) !== slotCount(chinese)) throw new Error(`Manual translation placeholder mismatch: ${row.id}`);
  }
  return { id: row.id, english, manual_chinese: chinese, manual_note: note, manual_source_url: url, ...extra };
}

/** Mutates only unresolved entries. Derived table fields are never translation inputs. */
export function reconcileTranslations(entries, rows) {
  if (!Array.isArray(rows)) throw new Error('translations.json must be an array');
  const tracked = new Map();
  for (const row of rows) {
    const fields = manualFields(row);
    const key = entryKey(fields);
    if (tracked.has(key)) throw new Error(`Duplicate translation row: ${fields.id} / ${fields.english}`);
    tracked.set(key, fields);
  }
  const current = new Map(entries.map(entry => [entryKey(entry), entry]));
  for (const entry of entries) {
    if (entry.chinese === null && !tracked.has(entryKey(entry))) {
      tracked.set(entryKey(entry), manualFields(entry));
    }
  }
  const table = [];
  const conflicts = [];
  const counts = { pending: 0, manual: 0, automatic: 0, override: 0, retired: 0, manual_differences: 0 };
  for (const [key, fields] of tracked) {
    const entry = current.get(key);
    const applied = appliedChinese(fields);
    if (entry?.chinese === null && applied !== null) {
      entry.chinese = applied;
      entry.method = 'manual-fallback';
      entry.reason = null;
      // The origin travels with the text (templates.json copies evidence into provenance).
      entry.evidence = [{ source: 'manual-fallback', reason: fields.manual_note, url: fields.manual_source_url,
        origin: fields.manual_origin ?? 'human',
        ...(fields.manual_basis ? { basis: fields.manual_basis } : {}),
        ...(fields.manual_author ? { author: fields.manual_author } : {}),
        ...(fields.manual_review ? { review: fields.manual_review } : {}) }];
    }
    const status = !entry ? 'retired' : entry.chinese === null ? 'pending'
      : entry.method === 'manual-fallback' ? 'manual' : entry.method === 'manual' ? 'override' : 'automatic';
    const differs = entry?.chinese != null && applied !== null && entry.chinese !== applied;
    if (differs) {
      counts.manual_differences++;
      conflicts.push({ kind: 'manual-fallback-difference', id: fields.id, english: fields.english,
        retained: entry.chinese, retained_method: entry.method, manual_chinese: fields.manual_chinese });
    }
    counts[status]++;
    table.push({ ...fields, status, chinese: entry?.chinese ?? null, method: entry?.method ?? null,
      reason: entry ? entry.reason : 'not-in-current-catalog', manual_differs: differs,
      evidence: entry?.evidence ?? [] });
  }
  table.sort((a, b) => {
    const x = entryKey(a), y = entryKey(b);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { table, conflicts, counts };
}
