// Offline validation of the actual pinned candidate, including independent FK replay.
import assert from 'node:assert/strict';
import { readFile, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createCatalogLookup, CATALOG_FIELDS } from '../../src/native-catalog.mjs';
import { verifyFkBindings } from '../../src/native-catalog-fk-binding.mjs';
import { strictJson } from '../../src/strict-json.mjs';

const [candidate, reportPath] = process.argv.slice(2);
assert(candidate && reportPath, 'Usage: validate.mjs CANDIDATE REPORT');
const sha = raw => createHash('sha256').update(raw).digest('hex');
const size = value => Buffer.byteLength(JSON.stringify(value));
const start = performance.now(), root = path.resolve(candidate);
const manifestRaw = await readFile(path.join(root, 'manifest.json')), manifest = strictJson(manifestRaw), bytes = {};
for (const [file, pin] of Object.entries(manifest.files)) {
  const stat = await lstat(path.join(root, file)); assert(stat.isFile() && !stat.isSymbolicLink());
  const raw = await readFile(path.join(root, file)); assert.equal(stat.size, pin.bytes); assert.equal(raw.length, pin.bytes); assert.equal(sha(raw), pin.sha256);
  bytes[file] = raw;
}
const catalog = strictJson(bytes['catalog.json']), expected = { game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN', verification: bytes['verification.json'] };
assert.throws(() => createCatalogLookup(catalog, { ...expected, verification: undefined }), /sidecar/u);
const damaged = Buffer.from(bytes['verification.json']); damaged[0] ^= 1;
assert.throws(() => createCatalogLookup(catalog, { ...expected, verification: damaged }), /sidecar/u);
const lookup = createCatalogLookup(catalog, expected);
let exact = 0, translated = 0, rejected = 0, changedEnglish = 0;
const uniqueEnglish = new Map();
for (const row of catalog.records) {
  const query = { table: row.table, field: row.field, id: row.id, english: row.english ?? '' };
  const result = lookup(query); exact++;
  if (row.status === 'translated') { assert.equal(result.text, row.localized); assert.equal(result.status, 'translated'); translated++;
    const stale = lookup({ ...query, english: row.english + ' __changed__' }); assert.equal(stale.status, 'fallback'); changedEnglish++; }
  if (row.applicability.decision === 'rejected') { assert.equal(result.status, 'fallback'); rejected++; }
  if (typeof row.english !== 'string') continue;
  const key = JSON.stringify([row.table, row.field, row.english]);
  if (!uniqueEnglish.has(key)) uniqueEnglish.set(key, []); uniqueEnglish.get(key).push(row);
}
let textQueries = 0;
for (const rows of uniqueEnglish.values()) if (rows.length === 1 && rows[0].status === 'translated') {
  const row = rows[0], result = lookup({ table: row.table, field: row.field, english: row.english, context: row.context.english });
  assert.equal(result.text, row.localized); textQueries++;
}
const input = strictJson(bytes['verification.json']), observed = input.observed, retained = observed.retained;
const verificationSizes = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, size(v)]));
observed.retained = { ...retained, 'tables.json': observed.tables, 'default-tables.json': observed.defaultTables, 'target_binding.json': observed.binding };
const selection = retained['fk-dependencies.json'].roles.target.ModType, originalSha = selection.namespace.payload_sha256;
selection.namespace.payload_sha256 = '0'.repeat(64);
assert.throws(() => verifyFkBindings(observed, input.owners, catalog.selected_tables, CATALOG_FIELDS), /pin differs/u);
selection.namespace.payload_sha256 = originalSha;
const originalPackage = selection.package; selection.package = 'target-Stats';
assert.throws(() => verifyFkBindings(observed, input.owners, catalog.selected_tables, CATALOG_FIELDS), /pointer|namespace|pin/u);
selection.package = originalPackage;
const originalFields = observed.defaultTables.Characters.physical_fields;
observed.defaultTables.Characters.physical_fields = [...originalFields];
[observed.defaultTables.Characters.physical_fields[64], observed.defaultTables.Characters.physical_fields[65]] = [originalFields[65], originalFields[64]];
assert.throws(() => verifyFkBindings(observed, input.owners, catalog.selected_tables, CATALOG_FIELDS), /schema|column/u);
observed.defaultTables.Characters.physical_fields = originalFields;
const mod = observed.binding.tables.Mods.records.find(r => r.id === 'MapPowerfulWorkAround');
assert.equal(mod.decision, 'rejected'); assert.deepEqual(mod.differing_fields.target_nontext, ['Stat1Min', 'Stat1Max', 'Stat2Min', 'Stat2Max', 'Stat3Min', 'Stat3Max']);
const components = Object.fromEntries(['candidates', 'applicability', 'context', 'templates'].map(key => [key, catalog.records.reduce((sum, row) => sum + (Object.hasOwn(row, key) ? size({ [key]: row[key] }) - 2 : 0), 0)]));
const binding = observed.binding, witnessBytes = Object.values(binding.tables).flatMap(t => t.records).reduce((n, r) => n + size(r.fk_witnesses), 0);
const report = { format: 'windows-fk-validation/v1', runtime: { node: process.version, platform: process.platform, arch: process.arch },
  seconds: (performance.now() - start) / 1000, peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
  manifest_sha256: sha(manifestRaw), files: manifest.files, independent_fk_recomputed: true,
  queries: { exact, translated, rejected, changedEnglish, uniqueEnglish: textQueries },
  negative_checks: ['missing-sidecar', 'damaged-sidecar', 'same-key-wrong-dependency-pin', 'wrong-package-namespace', 'wrong-Key3-physical-column', 'actual-Mods-numeric-change-remains-rejected'],
  size_breakdown: { accounting: 'UTF-8 compact JSON component bytes; component totals exclude containing-array commas. No fields omitted from declared full-structure validation.',
    catalog_top_level: Object.fromEntries(Object.entries(catalog).map(([k, v]) => [k, size(v)])), record_components: components,
    verification_top_level: verificationSizes,
    source_default_rows: size(observed.defaultTables), source_localized_rows: size(observed.tables), target_primary_rows: size(Object.fromEntries(Object.entries(input.owners).map(([n, o]) => [n, o.tables[n]]))),
    dependency_source_tables: size(retained['fk-source-tables.json']), dependency_target_payloads: Object.fromEntries(['ItemVisualIdentity', 'ModType', 'Stats'].map(n => [n, size(retained['fk-target-' + n + '.json'])])),
    full_binding: size(binding), closure_nodes_shared: size(binding.closures), per_record_fk_witnesses: witnessBytes,
    retained_input_documents: Object.fromEntries(Object.entries(retained).map(([k, v]) => [k, size(v)])) },
  boundaries: { observed_patch: null, observed_realm: null, official_client_semantics_verified: false, production_ready: false } };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ seconds: report.seconds, peak_rss_bytes: report.peak_rss_bytes, queries: report.queries, files: report.files }));
