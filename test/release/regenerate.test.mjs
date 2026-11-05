import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DICTIONARY_FILES, produceLocale } from '../../src/pobr/locale-producer.mjs';
import { ROOT, build, pin, releaseUrl } from '../../src/release/build.mjs';
import { createSupplementLines } from '../../src/pobr/supplement-lines.mjs';
import { storedZip } from '../../src/release/stored-zip.mjs';
import { loadRecipe, problems, recipeFiles, regenerate } from '../../src/release/regenerate.mjs';
import { strictJson } from '../../src/strict-json.mjs';
import { chinaPackage } from '../pobr/official-fixture.mjs';
import { TARGET, bytes, commitAll, config, fixture, gitIn, sourceManifest, write } from './fixture.mjs';

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
// With `supplement`, stat_lines.json and _meta.json of the publication come from pobr:supplement-lines
// over the producer's own members (committed as a base), a game package and a correction.
const GAME_ZIP = storedZip({ 'data/9.9/overlay/stat_descriptions.json': Buffer.from('{"scopes":{}}') });
const GAME = { repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip', ...pin(GAME_ZIP) };
const REVIEW = { by: 'claude-opus-5-5', note: 'synthetic' };
const EDITS = bytes({ schema: 'poe2-display-supplements/v1', entries: [], corrections: [{ correction_id: 'fixture', locale: 'zh-CN',
  member: 'stat_lines.json', rows: [{ from: { src: '生命', en: 'Life' }, to: { src: '生命值', en: 'Life' } }], origin: 'agent',
  basis: 'official-terms', author: 'claude-opus-5-5', note: 'synthetic', evidence: ['synthetic'], status: 'reviewed', review: REVIEW }] });

const CHINA = chinaPackage();

async function setup(t, { edit, supplement, official } = {}) {
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
  let supplementJob;
  if (supplement) {
    write(repo, 'base/stat_lines.json', files['i18n/zh-CN/stat_lines.json']);
    write(repo, 'base/_meta.json', files['i18n/zh-CN/_meta.json']);
    write(repo, 'curation/display-supplements.json', EDITS);
    const revision = commitAll(repo, 'supplement inputs');
    const local = name => ({ file: path.join(repo, name), ...pin(readFileSync(path.join(repo, name))) });
    write(root, 'game.zip', GAME_ZIP);
    write(root, CHINA.spec.asset, CHINA.zip);
    const out = path.join(ROOT, '.cache', `${path.basename(root)}-supplement`);
    t.after(() => rmSync(out, { recursive: true, force: true }));
    await createSupplementLines({ schema: 'pobr-supplement-lines-request/v1', target: { ...TARGET, locale: 'zh-CN' },
      base: local('base/stat_lines.json'), meta: local('base/_meta.json'), edits: local('curation/display-supplements.json'),
      game_package: { file: path.join(root, 'game.zip'), ...GAME },
      ...(official ? { official: [{ file: path.join(root, CHINA.spec.asset), ...CHINA.spec }] } : {}) }, out);
    for (const name of ['stat_lines.json', '_meta.json']) files[`i18n/zh-CN/${name}`] = readFileSync(path.join(out, name));
    const git = name => ({ revision, path: name, ...pin(readFileSync(path.join(repo, name))) });
    supplementJob = { id: 'zh-cn-supplement-lines', kind: 'supplement-lines', locale: 'zh-CN', base: git('base/stat_lines.json'),
      meta: git('base/_meta.json'), game_package: GAME, edits: git('curation/display-supplements.json'),
      members: ['i18n/zh-CN/stat_lines.json', 'i18n/zh-CN/_meta.json'], ...(official ? { official: [CHINA.spec] } : {}) };
  }
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
  if (supplementJob) {
    const replaced = supplementJob.members;
    recipe.jobs = [{ ...recipe.jobs[0], members: ZH_CN.filter(member => !replaced.includes(member)),
      replaced_by: Object.fromEntries(replaced.map(member => [member, supplementJob.id])) }, supplementJob];
  }
  write(repo, 'release/regenerate/9.9.json', bytes(recipe));
  commitAll(repo, 'recipe');
  const served = [];
  const fetcher = async address => {
    served.push(address);
    if (address === releaseUrl(GAME.repository, GAME.tag, GAME.asset)) return GAME_ZIP;
    if (address === releaseUrl(CHINA.spec.repository, CHINA.spec.tag, CHINA.spec.asset)) return CHINA.zip;
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
  const layer = { input: 'templates.json', category: 'unknown', reason: 'r', exit: 'e' };
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, composed_evidence: { 'i18n/zh-CN/stat_lines.json': [layer] } }] }),
    /stat_lines\.json layer templates\.json names an undeclared category/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, composed_evidence: { 'i18n/zh-CN/stat_lines.json': [{ ...layer, category: undefined }] } }] }),
    /maps a member to \[\{input, category, reason, exit\}\]/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, passthrough: { 'i18n/zh-CN/mods.json': 'carried' } }] }),
    /mods\.json is declared passthrough but equals no input/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, manifest: { ...job.manifest, sha256: '0'.repeat(64) } }] }),
    /generation\/input-manifest\.json differs from its pin/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...job, manifest: { ...job.manifest, revision: 'e'.repeat(40) } }] }),
    /Cannot fetch origin revision e{40}/u);
  await assert.rejects(regenerate({ repo, recipe: recipeFile, fetcher }), /e{40}:generation\/input-manifest\.json is not present locally \(pass --fetch\)/u);
  // A display-texts job pins its projection; src/pobr/display-projection.json is only the default for new candidates.
  const zip = { revision: 'f'.repeat(40), path: 'x.zip', bytes: 1, sha256: '0'.repeat(64) };
  const projection = { scopes: ['Characters.Name'], literals: 'all-catalog-conflict-participants' };
  const display = { id: 'display', kind: 'display-texts', locale: 'zh-CN', catalog: zip, supplement: zip,
    supplement_module: { revision: 'f'.repeat(40), path: 'src/translation-workbench.mjs' }, projection,
    members: ['i18n/zh-CN/display_texts.json'] };
  for (const bad of [undefined, { ...projection, extra: 1 }, { ...projection, scopes: ['Characters.Name', 'Characters.Name'] }]) {
    await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, projection: bad }] }), /display: pin the projection \{scopes, literals\}/u);
  }
  await assert.rejects(attempt({ ...recipe, jobs: [job, display] }), /extra: i18n\/zh-CN\/display_texts\.json/u);
  // An optional names pin (curation/display-supplements.json) is a full Git pin.
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names: { revision: 'f'.repeat(40), path: 'n.json' } }] }),
    /display: pin the names file/u);
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, official_names: { url: 'http://x.test/n.json', bytes: 1, sha256: '0'.repeat(64) } }] }),
    /display: pin official_names/u);
  // Monster names are decided against the game English, so names need the game Release package pinned too.
  const names = { revision: 'f'.repeat(40), path: 'n.json', bytes: 1, sha256: '0'.repeat(64) };
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names }] }), /display: game_package needs repository/u);
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names, game_package: GAME }] }), /display: pin package_texts/u);
  // They must be this package's own official texts, not any pinned file.
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names, game_package: GAME,
    package_texts: { stat_lines: names, passive_names: names } }] }), /display: package_texts\.passive_names is not this package's i18n\/zh-CN\/passive_names\.json/u);
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names, game_package: { ...GAME, asset: '../x.zip' } }] }),
    /asset pobr-game-9\.9\.zip/u);
  await assert.rejects(attempt({ ...recipe, jobs: [job, { ...display, names, game_package: { ...GAME, tag: '' } }] }),
    /display: game_package needs repository/u);
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

test('regenerate: a supplement-lines job owns stat_lines.json and _meta.json over its pinned base', async t => {
  const { repo, recipe, recipeFile, fetcher, served } = await setup(t, { supplement: true });
  const done = await regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  assert.deepEqual(problems(done), []);
  const { result } = done;
  assert.deepEqual(result.summary, { 'generated-identical': 9, frozen: 1 });
  assert.equal(result.members['i18n/zh-CN/stat_lines.json'].job, 'zh-cn-supplement-lines');
  assert.equal(result.members['i18n/zh-CN/_meta.json'].job, 'zh-cn-supplement-lines');
  assert.ok(served.includes(releaseUrl(GAME.repository, GAME.tag, GAME.asset)));
  assert.equal(result.inputs['zh-cn-supplement-lines:edits'].source.path, 'curation/display-supplements.json');
  const lines = strictJson(readFileSync(path.join(repo, 'inputs/locale-test/i18n/zh-CN/stat_lines.json')));
  assert.deepEqual(lines.filter(row => row.origin), [{ src: '生命值', en: 'Life', origin: 'agent' }]);
  assert.equal(result.jobs[1].summary.counts.corrections.applied, 1);
  const attempt = async value => {
    write(repo, 'release/regenerate/9.9.json', bytes(value));
    return regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  };
  const [producer, job] = recipe.jobs;
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...producer, replaced_by: undefined }, job] }),
    /the producer also writes i18n\/zh-CN\/(_meta|stat_lines)\.json/u);
  await assert.rejects(attempt({ ...recipe, jobs: [{ ...producer, replaced_by: { ...producer.replaced_by, 'i18n/zh-CN/stat_lines.json': 'nobody' } }, job] }),
    /stat_lines\.json is not a member of job nobody/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, members: ['i18n/zh-CN/stat_lines.json'] }] }),
    /members are i18n\/<locale>\/stat_lines\.json/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, game_package: { ...job.game_package, sha256: '0'.repeat(64) } }] }),
    /game_package/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, edits: { ...job.edits, bytes: 1 } }] }), /edits.*differs from its pin/u);
});

test('regenerate: a supplement-lines job reads its official sources from pinned RePoE input Releases', async t => {
  const { repo, recipe, recipeFile, fetcher, served } = await setup(t, { supplement: true, official: true });
  const done = await regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  assert.deepEqual(problems(done), []);
  const { result } = done;
  assert.ok(served.includes(releaseUrl(CHINA.spec.repository, CHINA.spec.tag, CHINA.spec.asset)));
  assert.deepEqual(pin(CHINA.zip), { bytes: result.inputs['zh-cn-supplement-lines:official[0]'].bytes,
    sha256: result.inputs['zh-cn-supplement-lines:official[0]'].sha256 });
  // The synthetic game package has no templates, so the China lines are all skipped.
  assert.equal(result.jobs[1].summary.official.skipped_not_game_template, 4);
  const meta = strictJson(readFileSync(path.join(repo, 'inputs/locale-test/i18n/zh-CN/_meta.json')));
  assert.equal(meta.official.sources[0].tag, CHINA.spec.tag);
  const attempt = async value => {
    write(repo, 'release/regenerate/9.9.json', bytes(value));
    return regenerate({ repo, recipe: recipeFile, fetch: true, fetcher });
  };
  const [producer, job] = recipe.jobs;
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, official: [] }] }), /official lists RePoE input packages/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, official: [{ ...CHINA.spec, url: 'https://x.test' }] }] }),
    /fields are repository, tag, asset, bytes, sha256, member, manifest_sha256/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, official: [{ ...CHINA.spec, member: 'x' }] }] }), /member/u);
  await assert.rejects(attempt({ ...recipe, jobs: [producer, { ...job, official: [{ ...CHINA.spec, sha256: '0'.repeat(64) }] }] }),
    /official\[0\]/u);
  // With an official layer the base is no longer the package's official text: package_texts.stat_lines
  // must be the publication's own member.
  const display = { id: 'display', kind: 'display-texts', locale: 'zh-CN', catalog: job.base, supplement: job.base,
    supplement_module: { revision: job.base.revision, path: 'src/translation-workbench.mjs' },
    projection: { scopes: ['Characters.Name'], literals: 'all-catalog-conflict-participants' },
    names: job.edits, game_package: GAME, members: ['i18n/zh-CN/display_texts.json'] };
  const passive = { revision: job.base.revision, path: 'inputs/locale-test/i18n/zh-CN/passive_names.json',
    ...pin(readFileSync(path.join(repo, 'inputs/locale-test/i18n/zh-CN/passive_names.json'))) };
  write(repo, 'release/regenerate/9.9.json', bytes({ ...recipe, jobs: [producer, job, { ...display, package_texts: { stat_lines: job.base, passive_names: passive } }] }));
  assert.throws(() => loadRecipe(path.join(repo, 'release/regenerate/9.9.json'), repo),
    /package_texts\.stat_lines is not this package's i18n\/zh-CN\/stat_lines\.json$/u);
  const own = { ...passive, path: 'inputs/locale-test/i18n/zh-CN/stat_lines.json',
    ...pin(readFileSync(path.join(repo, 'inputs/locale-test/i18n/zh-CN/stat_lines.json'))) };
  write(repo, 'release/regenerate/9.9.json', bytes({ ...recipe, jobs: [producer, job, { ...display, package_texts: { stat_lines: own, passive_names: passive } }] }));
  assert.doesNotThrow(() => loadRecipe(path.join(repo, 'release/regenerate/9.9.json'), repo));
  // Without an official layer the supplement-lines base is still accepted (the older recipe shape).
  const { official: _, ...plainJob } = job;
  write(repo, 'release/regenerate/9.9.json', bytes({ ...recipe, jobs: [producer, plainJob, { ...display, package_texts: { stat_lines: job.base, passive_names: passive } }] }));
  assert.doesNotThrow(() => loadRecipe(path.join(repo, 'release/regenerate/9.9.json'), repo));
});
