import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_FIELDS, createCatalogLookup } from '../../src/native-catalog.mjs';
import { strictJson } from '../../src/strict-json.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(base, '../..');
const sha = raw => createHash('sha256').update(raw).digest('hex');
const files = {};
assert.deepEqual((await readdir(path.join(base, 'catalog-a'))).sort(), (await readdir(path.join(base, 'catalog-b'))).sort());
for (const name of await readdir(path.join(base, 'catalog-a'))) {
  const a = await readFile(path.join(base, 'catalog-a', name));
  const b = await readFile(path.join(base, 'catalog-b', name));
  assert.ok(a.equals(b), `Fresh replay differs: ${name}`);
  files[name] = { bytes: a.length, sha256: sha(a) };
}
const manifest = strictJson(await readFile(path.join(base, 'catalog-a/manifest.json')));
for (const [name, pin] of Object.entries(manifest.files)) assert.deepEqual(files[name], pin);
for (const [name, pin] of Object.entries(manifest.producer)) assert.equal(sha(await readFile(path.join(root, name))), pin);
const catalog = strictJson(await readFile(path.join(base, 'catalog-a/catalog.json')));
assert.equal(catalog.observed_client.game_patch, null);
assert.equal(catalog.observed_client.realm, null);
assert.equal(catalog.sources[0].source_identity.game_patch, null);
assert.equal(catalog.sources[0].source_identity.realm, null);
assert.equal(catalog.production_ready, false);
const expected = { game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN' };
const lookup = createCatalogLookup(catalog, expected);
const counts = {}, reasons = {}, samples = [];
let exactQueries = 0, changedEnglishQueries = 0, textQueries = 0;
const seenText = new Set();
for (const row of catalog.records) {
  const english = row.english ?? row.candidates?.english?.[0]?.text ?? '';
  const q = { table: row.table, field: row.field, id: row.id, english };
  const result = lookup(q);
  exactQueries++;
  assert.equal(result.status, row.status === 'translated' ? 'translated' : 'fallback');
  assert.equal(result.text, row.status === 'translated' ? row.localized : english);
  if (row.status === 'unresolved') {
    assert.equal(result.reason, row.applicability.decision === 'rejected' ? 'target-binding-rejected' : row.reason);
    reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
  } else {
    const changed = lookup({ ...q, english: english + '\u0000' });
    assert.equal(changed.status, 'fallback');
    assert.equal(changed.reason, 'source-english-changed');
    changedEnglishQueries++;
    if (samples.length < 20) samples.push({ table: row.table, field: row.field, id: row.id, english, localized: row.localized });
  }
  const key = row.table + '.' + row.field;
  counts[key] ??= { records: 0, translated: 0, unresolved: 0, binding_rejected: 0 };
  counts[key].records++;
  counts[key][row.status]++;
  if (row.applicability.decision === 'rejected') counts[key].binding_rejected++;
  if (typeof row.english === 'string') {
    const identity = JSON.stringify([row.table, row.field, row.english]);
    if (!seenText.has(identity)) {
      const textResult = lookup({ table: row.table, field: row.field, english: row.english });
      assert.ok(['translated', 'fallback'].includes(textResult.status));
      if (textResult.status === 'fallback') assert.equal(textResult.text, row.english);
      seenText.add(identity); textQueries++;
    }
  }
}
const expectedFields = Object.entries(CATALOG_FIELDS).flatMap(([table, fields]) => Object.keys(fields).map(field => table + '.' + field)).sort();
assert.deepEqual(Object.keys(counts).sort(), expectedFields);
assert.equal(expectedFields.length, 18);
for (const [key, count] of Object.entries(counts)) {
  const [table, field] = key.split('.'), declared = catalog.coverage[table][field];
  for (const stat of ['records', 'translated', 'unresolved']) assert.equal(count[stat], declared[stat]);
}
assert.throws(() => createCatalogLookup(catalog, { ...expected, locale: 'zh-TW' }), /locale/);
const report = { schema: 'pobr-windows-catalog-validation/v1', runtime: { node: process.version, platform: process.platform, arch: process.arch, release: os.release() }, replay_byte_identical: true, files, source_manifest_sha256: catalog.sources[0].manifest_sha256, observed_patch: null, observed_realm: null, target_identity: expected, total_records: catalog.records.length, translated: catalog.records.filter(r => r.status === 'translated').length, unresolved: catalog.records.filter(r => r.status === 'unresolved').length, conflicts: catalog.conflicts.length, display_fields: counts, unresolved_reasons: reasons, queries: { exact: exactQueries, changed_english: changedEnglishQueries, unique_english: textQueries }, independent_binding_validation: 'Both actual CLI runs independently recomputed full source/default/target bindings', samples, production_ready: false };
await writeFile(path.join(base, 'catalog-validation.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ manifest: files['manifest.json'], catalog: files['catalog.json'], records: report.total_records, translated: report.translated, unresolved: report.unresolved, conflicts: report.conflicts, reasons, queries: report.queries, fields: counts }));
