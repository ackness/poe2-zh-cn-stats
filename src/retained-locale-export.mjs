#!/usr/bin/env node
// Replay an accepted publication without rewriting any dictionary bytes.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = (bytes, expected, label) => {
  if (!expected || !Number.isSafeInteger(expected.bytes) || expected.bytes !== bytes.length || !/^[a-f0-9]{64}$/.test(expected.sha256) || digest(bytes) !== expected.sha256) throw new Error(`${label}: byte pin mismatch`);
};
const names = {
  'zh-CN': ['_meta.json', 'base_items.json', 'classes.json', 'display_texts.json', 'mods.json', 'passive_names.json', 'rare_words.json', 'skills.json', 'stat_lines.json', 'words.json'],
  'zh-TW': ['base_items.json', 'mods.json', 'skills.json'],
};

export async function exportRetainedLocale({ publication, manifestSha256, target, locale, catalog, reviewedSupplement, out }) {
  if (!names[locale]) throw new Error('unsupported locale');
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 || '')) throw new Error('manifest SHA-256 required');
  const manifestBytes = await readFile(path.join(publication, 'manifest.json'));
  if (digest(manifestBytes) !== manifestSha256) throw new Error('manifest SHA-256 mismatch');
  const m = JSON.parse(manifestBytes);
  if (m.schema !== 'poe2-retained-locale-publication/v1' || !target || ['game', 'game_patch', 'realm'].some(k => !target[k] || m.target?.[k] !== target[k])) throw new Error('target or schema mismatch');
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files)) throw new Error('invalid file inventory');
  const contents = new Map();
  for (const [name, expected] of Object.entries(m.files)) {
    if (!/^(?:i18n\/(?:zh-CN|zh-TW)|evidence)\/[a-zA-Z0-9._-]+\.json$/.test(name)) throw new Error('invalid inventory path');
    const b = await readFile(path.join(publication, name));
    pin(b, expected, name);
    contents.set(name, b);
  }
  for (const name of names[locale]) if (!contents.has(`i18n/${locale}/${name}`)) throw new Error(`missing ${locale}/${name}`);
  if (locale === 'zh-CN') {
    if (!catalog || !reviewedSupplement) throw new Error('catalog and reviewed supplement required for zh-CN');
    if (digest(await readFile(catalog)) !== m.catalog_sha256) throw new Error('catalog SHA-256 mismatch');
    pin(await readFile(reviewedSupplement), m.reviewed_supplement, 'reviewed supplement');
    const display = JSON.parse(contents.get('i18n/zh-CN/display_texts.json'));
    if (display.schema !== 'pobr-native-display-texts/v1' || display.locale !== locale || display.game_patch !== target.game_patch || display.realm !== target.realm || display.catalog_sha256 !== m.catalog_sha256) throw new Error('display identity mismatch');
  }
  await mkdir(out);
  try {
    const dir = path.join(out, 'i18n', locale);
    await mkdir(dir, { recursive: true });
    for (const name of names[locale]) await writeFile(path.join(dir, name), contents.get(`i18n/${locale}/${name}`), { flag: 'wx' });
  } catch (err) { await rm(out, { recursive: true, force: true }); throw err; }
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--publication','--manifest-sha256','--game','--patch','--realm','--locale','--catalog','--reviewed-supplement','--out'].includes(key) || !args[i + 1] || options[key]) throw new Error('invalid or duplicate option');
    options[key] = args[i + 1];
  }
  if (!options['--publication'] || !options['--out']) throw new Error('publication and out required');
  await exportRetainedLocale({ publication: options['--publication'], manifestSha256: options['--manifest-sha256'], target: { game: options['--game'], game_patch: options['--patch'], realm: options['--realm'] }, locale: options['--locale'], catalog: options['--catalog'], reviewedSupplement: options['--reviewed-supplement'], out: options['--out'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
