import { entryKey, normalizeText, slotCount } from './text.mjs';

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
  if (chinese !== null) {
    if (!/\p{Script=Han}/u.test(chinese) || chinese === english || !note.trim()) {
      throw new Error(`A manual translation requires Chinese text and a review note: ${row.id}`);
    }
    if (slotCount(english) !== slotCount(chinese)) throw new Error(`Manual translation placeholder mismatch: ${row.id}`);
  }
  return { id: row.id, english, manual_chinese: chinese, manual_note: note, manual_source_url: url };
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
    if (entry?.chinese === null && fields.manual_chinese !== null) {
      entry.chinese = fields.manual_chinese;
      entry.method = 'manual-fallback';
      entry.reason = null;
      entry.evidence = [{ source: 'manual-fallback', reason: fields.manual_note, url: fields.manual_source_url }];
    }
    const status = !entry ? 'retired' : entry.chinese === null ? 'pending'
      : entry.method === 'manual-fallback' ? 'manual' : entry.method === 'manual' ? 'override' : 'automatic';
    const differs = entry?.chinese != null && fields.manual_chinese !== null && entry.chinese !== fields.manual_chinese;
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
