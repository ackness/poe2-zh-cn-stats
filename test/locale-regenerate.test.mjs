import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DICTIONARY_FILES, produceLocale } from '../src/locale-producer.mjs';
import { build, pin } from '../src/locale-release.mjs';
import { loadRecipe, problems, recipeFiles, regenerate } from '../src/locale-regenerate.mjs';
import { strictJson } from '../src/strict-json.mjs';
import { TARGET, bytes, commitAll, config, fixture, gitIn, sourceManifest, write } from './locale-release-fixture.mjs';

const table = (column, values) => ({ entries: values.map(([id, en, zh]) => ({ id, columns: { [column]: [{ en, zh }] } })) });
const DICTIONARY = {
  'lookup/stat_lines.json': [{ forms: [{ en: 'Life', zh: '生命' }] }], 'lookup/en_to_cn.json': { Storm: '雷霆', Ignored: null },
  'tables/BaseItemTypes.json': table('Name', [['b', 'Base', '基底']]), 'tables/ActiveSkills.json': table('DisplayedName', [['s', 'Strike', '打击']]),
  'tables/Characters.json': table('Name', [['c', 'Warrior', '战士']]), 'tables/Ascendancy.json': table('Name', []),
  'tables/Words.json': table('Text2', [['w', 'Strike', '重击']]), 'tables/PassiveSkills.json': table('Name', [['p', 'Node', '节点']]),
  'tables/Mods.json': table('Name', [['m', 'Sharp', '锐利']]), 'meta.json': { generatedAt: null },
};
const SNAPSHOT = '20261012T000000000Z';
const TEMPLATES = bytes({ schema_version: 1, snapshot: SNAPSHOT, templates: [], excluded: [], words: [] });
const url = file => `https://dictionary.example.test/${file}`;
const ZH_TW = bytes({ 'Metadata/Items/b': '基底' });
const ZH_CN = ['_meta.json', 'base_items.json', 'classes.json', 'mods.json', 'passive_names.json', 'rare_words.json', 'skills.json',
  'stat_lines.json', 'words.json'].map(file => `i18n/zh-CN/${file}`);

// A checkout whose release/9.9.json publication is what the legacy producer writes (plus a frozen zh-TW
// file), with the producer manifest and template bundle committed, and its recipe.
async function setup(t, { edit } = {}) {
  const made = fixture('locale-regenerate');
  t.after(() => rmSync(made.root, { recursive: true, force: true }));
  const { repo, root } = made;
  write(repo, 'templates.json', TEMPLATES);
  const templatesCommit = commitAll(repo, 'templates');
  const inputs = {}, materialized = path.join(root, 'materialized');
  for (const file of DICTIONARY_FILES) {
    const raw = bytes(DICTIONARY[file]);
    inputs[`dictionary/${file}`] = { ...pin(raw), source: { url: url(file) } };
    write(materialized, `dictionary/${file}`, raw);
  }
  inputs['templates.json'] = { ...pin(TEMPLATES),
    source: { url: `https://raw.githubusercontent.com/ackness/poe2-zh-cn-stats/${templatesCommit}/templates.json` } };
  write(materialized, 'templates.json', TEMPLATES);
  const manifestRaw = bytes({ schema: 'poe2-locale-generation-input/v1', profile: 'legacy', target: TARGET,
    identity: { dictionary: { repository: 'https://dictionary.example.test', commit: 'a'.repeat(40) },
      translation: { repository: 'https://github.com/ackness/poe2-zh-cn-stats', commit: templatesCommit, snapshot: SNAPSHOT,
        sha256: pin(TEMPLATES).sha256, mode: 'pinned' } }, inputs });
  writeFileSync(path.join(root, 'manifest.json'), manifestRaw);
  const produced = path.join(root, 'produced');
  await produceLocale({ manifestPath: path.join(root, 'manifest.json'), manifestSha256: pin(manifestRaw).sha256, inputDir: materialized, out: produced });
  const files = Object.fromEntries(ZH_CN.map(name => [name, readFileSync(path.join(produced, name))]));
  files['i18n/zh-TW/base_items.json'] = ZH_TW;
  if (edit) files[edit] = bytes({ edited: true });
  gitIn(repo, 'rm', '-rq', 'inputs');
  for (const [name, raw] of Object.entries(files)) write(repo, `inputs/locale-test/${name}`, raw);
  const sourceRaw = sourceManifest(files);
  write(repo, 'inputs/locale-test/manifest.json', sourceRaw);
  write(repo, 'generation/input-manifest.json', manifestRaw);
  const commit = commitAll(repo, 'publication and generation manifest');
  const declared = config(sourceRaw);
  const origin = { ...declared.source.origin, revision: commit };
  write(repo, 'release/9.9.json', bytes({ ...declared, source: { ...declared.source, origin } }));
  const published = { tag: 'locale/9.9-1', asset: 'pobr-locale-9.9.zip', ...pin(build({ repo }).zip) };
  write(repo, 'release/9.9.json', bytes({ ...declared, source: { ...declared.source, origin }, published }));
  const recipe = {
    schema: 'poe2-locale-regeneration/v1', reproduces: 'release/9.9.json',
    categories: { 'unpinned-input': 'An input was never committed.' },
    jobs: [{ id: 'zh-cn-dictionary', kind: 'locale-producer',
      manifest: { revision: commit, path: 'generation/input-manifest.json', ...pin(manifestRaw) }, producer_commit: commit, members: ZH_CN }],
    frozen: { 'i18n/zh-TW/base_items.json': { ...pin(ZH_TW), category: 'unpinned-input', reason: 'no names.json', exit: 'publish it' } },
  };
  write(repo, 'release/regenerate/9.9.json', bytes(recipe));
  commitAll(repo, 'recipe');
  const served = [];
  const fetcher = async address => {
    served.push(address);
    const file = DICTIONARY_FILES.find(name => url(name) === address);
    assert.ok(file, `unexpected download ${address}`);
    return bytes(DICTIONARY[file]);
  };
  return { ...made, recipe, served, fetcher, published, recipeFile: path.join(repo, 'release/regenerate/9.9.json') };
}

test('regenerate: rebuilds every member from pinned inputs and the published zip byte for byte', async t => {
  const { repo, recipeFile, fetcher, served, published } = await setup(t);
  assert.deepEqual(recipeFiles(repo), [recipeFile]);
  await assert.rejects(regenerate({ repo, recipe: recipeFile, fetcher }), /lookup\/stat_lines\.json is not cached \(pass --fetch\)/u);
  const done = await regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  assert.equal(served.length, DICTIONARY_FILES.length);
  assert.equal(done.out, path.join(repo, '.cache/regenerate/poe2-international-9.9'));
  assert.deepEqual(problems(done), []);
  const { result } = done;
  assert.deepEqual(result.summary, { 'generated-identical': 9, frozen: 1 });
  assert.deepEqual(Object.keys(result.members), [...ZH_CN, 'i18n/zh-TW/base_items.json'].sort());
  assert.deepEqual(result.members['i18n/zh-TW/base_items.json'],
    { class: 'frozen', ...pin(ZH_TW), category: 'unpinned-input', reason: 'no names.json', exit: 'publish it' });
  assert.deepEqual({ ...result.package, asset: undefined }, { asset: undefined, bytes: published.bytes, sha256: published.sha256, equals_published: true });
  assert.deepEqual(readFileSync(path.join(done.out, 'pobr-locale-9.9.zip')), done.zip);
  // Git inputs name their revision; the own-repository URL was read from Git, the others downloaded.
  assert.equal(result.inputs['zh-cn-dictionary:templates.json'].source.path, 'templates.json');
  assert.match(result.inputs['zh-cn-dictionary:dictionary/meta.json'].source.url, /^https:\/\/dictionary\.example\.test\//u);
  assert.ok(!existsSync(path.join(done.out, 'work')));
  // Downloads are cached by SHA-256: a second run needs no --fetch, and the receipt is stable.
  const again = await regenerate({ repo, recipe: recipeFile, fetcher });
  assert.equal(served.length, DICTIONARY_FILES.length);
  assert.deepEqual(again.raw, done.raw);
  assert.equal(strictJson(readFileSync(path.join(done.out, 'regeneration.json'))).schema, 'poe2-locale-regeneration-receipt/v1');
});

test('regenerate: a source member that its producer does not reproduce is reported', async t => {
  const { repo, recipeFile, fetcher } = await setup(t, { edit: 'i18n/zh-CN/mods.json' });
  const done = await regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  assert.equal(done.result.members['i18n/zh-CN/mods.json'].class, 'generated-different');
  // The published pin was built from the edited source, so the regenerated package differs too.
  assert.deepEqual(problems(done).map(p => p.split(' ')[0]), ['i18n/zh-CN/mods.json', 'the']);
});

test('recipe: covers the source exactly once, pins frozen bytes and checks declared passthrough', async t => {
  const { repo, recipe, recipeFile, fetcher } = await setup(t);
  const attempt = async value => {
    write(repo, 'release/regenerate/9.9.json', bytes(value));
    return regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  };
  const [job] = recipe.jobs;
  await assert.rejects(attempt({ ...recipe, frozen: {} }), /missing: i18n\/zh-TW\/base_items\.json/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, members: [...ZH_CN, 'i18n/zh-TW/base_items.json'] }] }),
    /the producer writes i18n\/zh-CN\/\* only/u);
  await assert.rejects(attempt({ ...recipe, frozen: { ...recipe.frozen, 'i18n/zh-CN/mods.json': recipe.frozen['i18n/zh-TW/base_items.json'] } }),
    /i18n\/zh-CN\/mods\.json is both regenerated and frozen/u);
  await assert.rejects(attempt({ ...recipe, frozen: { 'i18n/zh-TW/base_items.json': { ...recipe.frozen['i18n/zh-TW/base_items.json'], exit: '' } } }),
    /states category, reason and exit/u);
  await assert.rejects(attempt({ ...recipe, frozen: { 'i18n/zh-TW/base_items.json': { ...recipe.frozen['i18n/zh-TW/base_items.json'], bytes: 1 } } }),
    /frozen pin differs/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, members: ZH_CN.slice(1) }] }), /missing: i18n\/zh-CN\/_meta\.json/u);
  const meta = { ...pin(readFileSync(path.join(repo, 'inputs/locale-test/i18n/zh-CN/_meta.json'))), category: 'unpinned-input', reason: 'r', exit: 'e' };
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, members: ZH_CN.slice(1) }], frozen: { ...recipe.frozen, 'i18n/zh-CN/_meta.json': meta } }),
    /the producer also writes i18n\/zh-CN\/_meta\.json/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, passthrough: { 'i18n/zh-CN/mods.json': 'carried' } }] }),
    /mods\.json is declared passthrough but equals no input/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, manifest: { ...job.manifest, sha256: '0'.repeat(64) } }] }),
    /generation\/input-manifest\.json differs from its pin/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, manifest: { ...job.manifest, revision: 'e'.repeat(40) } }] }),
    /Cannot fetch origin revision e{40}/u);
  await assert.rejects(regenerate({ repo, recipe: recipeFile, fetcher }), /e{40}:generation\/input-manifest\.json is not present locally \(pass --fetch\)/u);
  write(repo, 'release/regenerate/9.9.json', bytes(recipe));
  mkdirSync(path.join(repo, 'release/regenerate/other'), { recursive: true });
  write(repo, 'release/regenerate/9.8.json', bytes(recipe));
  assert.throws(() => loadRecipe(path.join(repo, 'release/regenerate/9.8.json'), repo), /9\.8\.json must be named like release\/9\.9\.json/u);
});

test('the committed recipes cover their configs and name a reason and an exit for every frozen member', () => {
  for (const file of recipeFiles()) {
    const { recipe, members, config: loaded } = loadRecipe(file);
    const source = strictJson(readFileSync(loaded.config.source.manifest.path));
    assert.deepEqual([...members].sort(), Object.keys(source.files).filter(name => name.startsWith('i18n/')).sort(), file);
    for (const [member, entry] of Object.entries(recipe.frozen)) {
      assert.deepEqual({ bytes: entry.bytes, sha256: entry.sha256 }, source.files[member], member);
    }
  }
});
