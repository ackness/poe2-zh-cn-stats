import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildDictionary } from './dictionary.mjs';
import { extractPagePairs } from './poe2db.mjs';
import { readSnapshot, sha256, activateSnapshot } from './sources.mjs';
import { buildTemplateExport } from './template-export.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';

export async function generateFiles(root, directory) {
  const { manifest, contents } = await readSnapshot(directory);
  const overridesRaw = await readFile(path.join(root, 'overrides.json'), 'utf8');
  const overrides = JSON.parse(overridesRaw);
  const translations = JSON.parse(await readFile(path.join(root, 'translations.json'), 'utf8'));
  const curatedRaw = await readFile(path.join(root, 'curated.json'), 'utf8');
  const curated = JSON.parse(curatedRaw);
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
    supplementalPairs: pairs, overrides, translations,
  });
  const meta = { schema_version: 1, snapshot: manifest.id, captured_at: manifest.captured_at,
    source_manifest: '../manifest.json', overrides_sha256: sha256(overridesRaw),
    translation_table_sha256: sha256(json(result.translations)),
    curated_sha256: sha256(curatedRaw) };
  return new Map([
    ['dictionary.json', json({ ...meta, entries: result.entries })],
    ['pairs.json', json({ ...meta, pairs: result.pairs })],
    ['coverage.json', json({ ...meta, ...result.report, pages, source_issues: issues.length })],
    ['unresolved.json', json(result.unresolved)],
    ['conflicts.json', json(result.conflicts)],
    ['source-issues.json', json(issues)],
    ['poe2db-evidence.json', json(pairs)],
    ['overrides.json', overridesRaw],
    ['translations.json', json(result.translations)],
    ['curated.json', curatedRaw],
    ['templates.json', json({ ...buildTemplateExport({ snapshot: manifest.id, entries: result.entries, curated }),
      source_manifest: '../manifest.json', curated_sha256: meta.curated_sha256 })],
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

// The root table is an editable working copy; the published snapshot retains
// its exact reconciled table. Never overwrite edits detected during publication.
export async function activateGenerated(root, directory) {
  const tablePath = path.join(root, 'translations.json');
  const before = await readFile(tablePath, 'utf8');
  const report = await checkGenerated(root, directory);
  const table = await readFile(path.join(directory, 'generated', 'translations.json'), 'utf8');
  if (await readFile(tablePath, 'utf8') !== before) throw new Error('Translation table changed; rebuild before activation');
  const temporary = path.join(root, `.translations-${process.pid}.json`);
  try {
    await writeFile(temporary, table);
    await activateSnapshot(root, directory, report.snapshot);
    if (await readFile(tablePath, 'utf8') !== before) {
      throw new Error('Snapshot activated, but newer translation edits were preserved; run npm run build to apply them');
    }
    await rename(temporary, tablePath);
    return report;
  } finally {
    await rm(temporary, { force: true });
  }
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
    `Translation worklist: ${JSON.stringify(report.translation_worklist)}`,
    'Coverage is structural; unresolved entries and conflicts are intentionally retained.',
  ];
  return lines.join('\n');
}
