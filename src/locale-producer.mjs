#!/usr/bin/env node
// Offline legacy dictionary projection and explicit selected-literal composition.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { strictJson } from './strict-json.mjs';
import { mergeTranslations, validateBundle } from './legacy-translation-merge.mjs';

export const DICTIONARY_FILES = ['lookup/stat_lines.json', 'lookup/en_to_cn.json',
  'tables/BaseItemTypes.json', 'tables/ActiveSkills.json', 'tables/Characters.json',
  'tables/Ascendancy.json', 'tables/Words.json', 'tables/PassiveSkills.json',
  'tables/Mods.json', 'meta.json'];
const hash = b => createHash('sha256').update(b).digest('hex');
const pin = b => ({ bytes: b.length, sha256: hash(b) });
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const equal = isDeepStrictEqual;
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const pairKey = p => JSON.stringify([p.src, p.en]);
const sortPairs = pairs => pairs.sort((a, b) => compare(a.src, b.src) || compare(a.en, b.en));
const validPair = p => p && typeof p.src === 'string' && p.src.length > 0 && typeof p.en === 'string' && p.en.length > 0;

function nameSidecar(table, column, byId = false) {
  assert(Array.isArray(table?.entries), 'invalid dictionary table');
  const out = {};
  for (const entry of table.entries) {
    const cell = entry?.columns?.[column]?.[0];
    if (byId ? (typeof entry?.id === 'string' && cell?.zh) : (cell?.en && cell?.zh)) {
      out[byId ? entry.id : cell.en] = cell.zh;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => compare(a, b)));
}

/** Project supplied, already authenticated dictionary and template objects. */
export function projectLegacy(dictionary, bundle, identity) {
  validateBundle(bundle, identity.translation.snapshot);
  const read = name => { assert(Object.hasOwn(dictionary, name), `missing dictionary ${name}`); return dictionary[name]; };
  const baseItems = nameSidecar(read('tables/BaseItemTypes.json'), 'Name', true);
  const skills = nameSidecar(read('tables/ActiveSkills.json'), 'DisplayedName', true);
  const words = { ...nameSidecar(read('tables/ActiveSkills.json'), 'DisplayedName'), ...nameSidecar(read('tables/Words.json'), 'Text2') };
  const passiveNames = nameSidecar(read('tables/PassiveSkills.json'), 'Name');
  const mods = nameSidecar(read('tables/Mods.json'), 'Name');
  const classes = { classes: nameSidecar(read('tables/Characters.json'), 'Name'), ascendancies: nameSidecar(read('tables/Ascendancy.json'), 'Name') };
  const rareWords = {};
  for (const [en, zh] of Object.entries(read('lookup/en_to_cn.json'))) {
    if (/^[A-Z][a-zA-Z']*$/.test(en) && typeof zh === 'string' && zh.length <= 8 && /^[一-鿿]+$/.test(zh)) rareWords[en] = zh;
  }
  const wordPatches = bundle.words.map(({ english, chinese }) => {
    rareWords[english] ??= chinese;
    return { english, proposed: chinese, retained: rareWords[english] };
  });
  const rareWordsSorted = Object.fromEntries(Object.entries(rareWords).sort(([a], [b]) => compare(a, b)));
  const seen = new Set(), legacy = [];
  const lines = read('lookup/stat_lines.json');
  assert(Array.isArray(lines), 'invalid dictionary stat lines');
  for (const block of lines) {
    assert(Array.isArray(block?.forms), 'invalid dictionary stat forms');
    for (const form of block.forms) {
      if (!form.zh || !form.en) continue;
      const src = form.zh.trim(), en = form.en.trim(), k = `${src}\x00${en}`;
      if (!seen.has(k)) { seen.add(k); legacy.push({ src, en }); }
    }
  }
  const merged = mergeTranslations(legacy, bundle);
  const counts = { base_items: Object.keys(baseItems).length, skills: Object.keys(skills).length,
    stat_lines: merged.pairs.length, words: Object.keys(words).length, passive_names: Object.keys(passiveNames).length,
    mods: Object.keys(mods).length, rare_words: Object.keys(rareWordsSorted).length,
    curated_templates: merged.report.curated_templates, added_trade_templates: merged.report.added_trade };
  const files = { 'base_items.json': baseItems, 'skills.json': skills, 'stat_lines.json': merged.pairs,
    'classes.json': classes, 'words.json': words, 'passive_names.json': passiveNames, 'mods.json': mods, 'rare_words.json': rareWordsSorted };
  return { files, counts, upstreamGeneratedAt: read('meta.json').generatedAt ?? null,
    audit: { schema_version: 1, source: identity.translation, ...merged.report, word_patches: wordPatches } };
}

/** Compose an explicitly selected and pinned delta, preserving every original pair. */
export function layerSelectedPairs(legacy, delta, selected) {
  assert(Array.isArray(legacy) && legacy.every(validPair), 'invalid legacy pairs');
  const basePin = pin(jsonBytes(legacy));
  assert(delta?.schema === 'pobr-native-selected-pair-delta/v1' && Array.isArray(delta.added_pairs)
    && delta.old_pairs === legacy.length && delta.added_count === delta.added_pairs.length && delta.removed_count === 0
    && delta.baseline_pairs === legacy.length + delta.added_pairs.length, 'invalid native delta');
  assert(delta.input_pins?.length === 2 && equal(basePin, { bytes: delta.input_pins[0].bytes, sha256: delta.input_pins[0].sha256 }), 'native delta legacy pin mismatch');
  assert(selected?.schema === 'poe2-selected-literal-layer/v1' && Array.isArray(selected.added), 'invalid selected literal layer');
  const seen = new Set(legacy.map(pairKey));
  assert(seen.size === legacy.length, 'duplicate legacy pairs');
  const pairs = legacy.map(({ src, en }) => ({ src, en }));
  const append = rows => { for (const row of rows) {
    assert(validPair(row) && !seen.has(pairKey(row)), 'invalid or duplicate selected pair');
    seen.add(pairKey(row)); pairs.push({ src: row.src, en: row.en });
  } };
  append(delta.added_pairs); sortPairs(pairs);
  const baseline = pin(jsonBytes(pairs));
  assert(equal(baseline, { bytes: delta.input_pins[1].bytes, sha256: delta.input_pins[1].sha256 })
    && equal(baseline, { bytes: selected.baseline?.bytes, sha256: selected.baseline?.sha256 })
    && selected.baseline?.pairs === pairs.length, 'selected baseline pin mismatch');
  append(selected.added); sortPairs(pairs);
  assert(equal(pin(jsonBytes(pairs)), selected.output), 'selected output pin mismatch');
  return pairs;
}

function validateMetadata(original, layered, projection, identity) {
  assert(original && layered && typeof original === 'object' && typeof layered === 'object', 'retained metadata required');
  assert(original.source === identity.dictionary.repository && original.source_commit === identity.dictionary.commit
    && original.source_generated_at === projection.upstreamGeneratedAt
    && equal(original.translation_source, identity.translation) && equal(original.counts, projection.counts), 'retained metadata identity or counts mismatch');
  for (const [key, value] of Object.entries(original)) assert(equal(layered[key], value), `layered metadata changed ${key}`);
  const extra = Object.keys(layered).filter(k => !Object.hasOwn(original, k)).sort();
  assert(equal(extra, ['native_csd_unit_translations', 'native_socketable_translations', 'native_tree_translations']), 'unexpected layered metadata fields');
}

/** Read only explicit byte-pinned files; output is fresh and removed on failure. */
export async function produceLocale({ manifestPath, manifestSha256, inputDir, out }) {
  assert(/^[a-f0-9]{64}$/.test(manifestSha256 ?? ''), 'manifest SHA-256 required');
  const mb = await readFile(manifestPath);
  assert(hash(mb) === manifestSha256, 'manifest SHA-256 mismatch');
  const m = strictJson(mb);
  assert(m.schema === 'poe2-locale-generation-input/v1' && ['game', 'game_patch', 'realm']
    .every(key => typeof m.target?.[key] === 'string' && m.target[key].length > 0), 'invalid manifest target or schema');
  assert(['legacy', 'retained-selected'].includes(m.profile), 'invalid generation profile');
  assert(m.identity?.dictionary?.repository && /^[a-f0-9]{40}$/.test(m.identity.dictionary.commit ?? '')
    && m.identity?.translation?.repository && /^[a-f0-9]{40}$/.test(m.identity.translation.commit ?? '')
    && /^[0-9TZ]+$/.test(m.identity.translation.snapshot ?? '') && m.identity.translation.mode === 'pinned', 'invalid source identity');
  const required = [...DICTIONARY_FILES.map(f => `dictionary/${f}`), 'templates.json'];
  if (m.profile === 'retained-selected') required.push('evidence/native-140-pairs.json', 'evidence/selected-literals.json',
    'evidence/zh-CN-original-meta.json', 'evidence/zh-CN-layered-meta.json');
  assert(m.inputs && equal(Object.keys(m.inputs).sort(), [...required].sort()), 'input inventory mismatch');
  const contents = {};
  for (const name of required) {
    const expected = m.inputs[name];
    assert(expected && Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && /^[a-f0-9]{64}$/.test(expected.sha256 ?? '') && expected.source, `invalid input pin ${name}`);
    const bytes = await readFile(path.join(inputDir, name));
    assert(equal(pin(bytes), { bytes: expected.bytes, sha256: expected.sha256 }), `input pin mismatch: ${name}`);
    contents[name] = strictJson(bytes);
  }
  assert(m.identity.translation.sha256 === m.inputs['templates.json'].sha256, 'template identity mismatch');
  const dictionary = Object.fromEntries(DICTIONARY_FILES.map(f => [f, contents[`dictionary/${f}`]]));
  const projection = projectLegacy(dictionary, contents['templates.json'], m.identity);
  let layers = { legacy_pairs: projection.counts.stat_lines, native_selected_pairs: 0, selected_literal_pairs: 0, final_pairs: projection.counts.stat_lines };
  if (m.profile === 'retained-selected') {
    const original = contents['evidence/zh-CN-original-meta.json'], layered = contents['evidence/zh-CN-layered-meta.json'];
    validateMetadata(original, layered, projection, m.identity);
    projection.files['stat_lines.json'] = layerSelectedPairs(projection.files['stat_lines.json'], contents['evidence/native-140-pairs.json'], contents['evidence/selected-literals.json']);
    projection.files['_meta.json'] = layered;
    layers = { legacy_pairs: projection.counts.stat_lines, native_selected_pairs: contents['evidence/native-140-pairs.json'].added_count,
      selected_literal_pairs: contents['evidence/selected-literals.json'].added.length, final_pairs: projection.files['stat_lines.json'].length };
  } else {
    projection.files['_meta.json'] = { source: m.identity.dictionary.repository, source_commit: m.identity.dictionary.commit,
      source_generated_at: projection.upstreamGeneratedAt, translation_source: m.identity.translation,
      regen_command: 'node src/locale-producer.mjs --manifest <pinned-manifest> --manifest-sha256 <sha256> --input-dir <input-dir> --out <new-directory>', counts: projection.counts };
  }
  const files = {};
  for (const [name, value] of Object.entries(projection.files)) files[`i18n/zh-CN/${name}`] = jsonBytes(value);
  files['generated/translation-audit.json'] = jsonBytes(projection.audit);
  const filePins = Object.fromEntries(Object.entries(files).sort(([a], [b]) => compare(a, b)).map(([name, bytes]) => [name, pin(bytes)]));
  if (m.expected_files !== undefined) assert(equal(filePins, m.expected_files), 'expected output pin mismatch');
  const receipt = { schema: 'poe2-locale-generation-receipt/v1', target: m.target, manifest_sha256: manifestSha256,
    profile: m.profile, identity: m.identity, inputs: m.inputs, layers,
    files: filePins };
  files['receipt.json'] = jsonBytes(receipt);
  await mkdir(out);
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const dest = path.join(out, name); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, bytes, { flag: 'wx' });
    }
  } catch (error) { await rm(out, { recursive: true, force: true }); throw error; }
  return receipt;
}

async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    assert(['--manifest', '--manifest-sha256', '--input-dir', '--out'].includes(key) && args[i + 1] && !options[key], 'invalid or duplicate option');
    options[key] = args[i + 1];
  }
  assert(['--manifest', '--manifest-sha256', '--input-dir', '--out'].every(k => options[k]), 'all options are required');
  await produceLocale({ manifestPath: options['--manifest'], manifestSha256: options['--manifest-sha256'], inputDir: options['--input-dir'], out: options['--out'] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
