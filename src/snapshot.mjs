import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { buildDictionary } from './dictionary.mjs';
import { extractPagePairs } from './poe2db.mjs';
import { readSnapshot, sha256 } from './sources.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';

export async function generateFiles(root, directory) {
  const { manifest, contents } = await readSnapshot(directory);
  const overridesRaw = await readFile(path.join(root, 'overrides.json'), 'utf8');
  const overrides = JSON.parse(overridesRaw);
  const pairs = [];
  const pages = [];
  const issues = [...manifest.errors];
  const sourceByKey = new Map(manifest.sources.map(source => [source.key, source]));
  for (const page of manifest.pages) {
    if (!page.en || !page.cn) {
      issues.push({ type: 'incomplete-page-pair', slug: page.slug });
      continue;
    }
    if (!contents.has(page.en) || !contents.has(page.cn)) throw new Error(`Missing source for ${page.slug}`);
    const result = extractPagePairs(contents.get(page.en), contents.get(page.cn), {
      enUrl: sourceByKey.get(page.en).url, cnUrl: sourceByKey.get(page.cn).url,
    });
    pairs.push(...result.pairs);
    pages.push({ slug: page.slug, pairs: result.pairs.length, issues: result.issues.length });
    issues.push(...result.issues.map(issue => ({ page: page.slug, ...issue })));
  }
  const result = buildDictionary({
    english: JSON.parse(contents.get('trade-en')),
    chinese: JSON.parse(contents.get('trade-cn')),
    supplementalPairs: pairs, overrides,
  });
  const meta = { schema_version: 1, snapshot: manifest.id, captured_at: manifest.captured_at,
    source_manifest: '../manifest.json', overrides_sha256: sha256(overridesRaw) };
  return new Map([
    ['dictionary.json', json({ ...meta, entries: result.entries })],
    ['pairs.json', json({ ...meta, pairs: result.pairs })],
    ['coverage.json', json({ ...meta, ...result.report, pages, source_issues: issues.length })],
    ['unresolved.json', json(result.unresolved)],
    ['conflicts.json', json(result.conflicts)],
    ['source-issues.json', json(issues)],
    ['poe2db-evidence.json', json(pairs)],
    ['overrides.json', overridesRaw],
  ]);
}

export async function writeGenerated(directory, files) {
  if (path.basename(path.dirname(directory)) !== '.cache' || !/^candidate-[0-9TZ]+$/.test(path.basename(directory))) {
    throw new Error('Generated artifacts may only be written to an unpublished candidate under .cache');
  }
  const output = path.join(directory, 'generated');
  await mkdir(output, { recursive: true });
  for (const [name, content] of files) {
    const temporary = path.join(output, `.${name}.${process.pid}`);
    await writeFile(temporary, content);
    await rename(temporary, path.join(output, name));
  }
}

export async function checkGenerated(root, directory) {
  const files = await generateFiles(root, directory);
  for (const [name, expected] of files) {
    const actual = await readFile(path.join(directory, 'generated', name), 'utf8');
    if (actual !== expected) throw new Error(`Generated data is stale or modified: ${name}; run npm run build`);
  }
  return JSON.parse(files.get('coverage.json'));
}

export function formatReport(report) {
  const t = report.totals;
  const lines = [
    `Snapshot: ${report.snapshot}`,
    `English text coverage: ${t.covered_english}/${t.distinct_english} (${t.text_coverage_percent}%)`,
    `Resolved ID/text entries: ${t.resolved_entries}/${t.entries}`,
    `Fully resolved IDs: ${t.fully_resolved_ids}/${t.ids}`,
    `Methods: ${JSON.stringify(report.methods)}`,
    `PoE2DB pages: ${report.pages.length}; evidence pairs: ${report.supplemental_candidates}`,
    `Conflicts: ${report.conflicts}; source diagnostics: ${report.source_issues}`,
    'Coverage is structural; unresolved entries and conflicts are intentionally retained.',
  ];
  return lines.join('\n');
}
