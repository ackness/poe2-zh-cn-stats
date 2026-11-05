import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build, pin, sha256 } from '../src/locale-release.mjs';
import {
  commands, main, nextSequence, plan, preflight, remoteTags, sequences, stage, tagName,
} from '../src/locale-release-publish.mjs';
import { bytes, commitAll, config, fixture, gitIn, write } from './locale-release-fixture.mjs';
import { addRetainedDisplay, retained } from './support-display-fixture.mjs';

const STAGE = 'publish/poe2-international-9.9';

function setup(t) {
  const context = fixture('locale-publish');
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  return context;
}

// Git runs for real (tags are pushed to the fixture's bare origin); gh is simulated.
// releases: {tag: {draft, assets: {name: Buffer}}}. create: 'ok', 'fail', or 'killed'
// (interrupted mid-upload: a draft with only the first asset is left behind).
function runner(repo, { auth = true, gh = true, releases = {}, create = 'ok' } = {}) {
  const calls = [];
  const done = (status, stdout = '', stderr = '') => ({ status, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr) });
  const run = (command, options = {}) => {
    calls.push(command);
    if (command[0] === 'git') {
      try {
        gitIn(repo, ...command.slice(1));
        return done(0);
      } catch (error) {
        return done(1, '', error.message);
      }
    }
    if (!gh) throw new Error('spawnSync gh ENOENT');
    const verb = command.slice(1, 3).join(' '), tag = command[3], release = releases[tag];
    const option = name => command[command.indexOf(name) + 1];
    if (verb === 'auth status') return auth ? done(0) : done(1, '', 'You are not logged into any GitHub hosts');
    if (verb === 'release view') {
      if (!release) return done(1, '', 'release not found');
      return done(0, JSON.stringify({ tagName: tag, isDraft: release.draft, assets: Object.entries(release.assets)
        .map(([name, raw]) => ({ name, size: raw.length, digest: `sha256:${sha256(raw)}`, state: 'uploaded' })) }));
    }
    if (verb === 'release download') {
      if (!release) return done(1, '', 'release not found');
      if (command.includes('--pattern')) {
        const raw = release.assets[option('--pattern')];
        return raw ? done(0, raw) : done(1, '', 'no assets match the file pattern');
      }
      for (const [name, raw] of Object.entries(release.assets)) write(repo, path.relative(repo, path.join(option('--dir'), name)), raw);
      return done(0);
    }
    if (verb === 'release create') {
      if (create === 'fail') return done(1, '', 'HTTP 502');
      const files = command.slice(command.indexOf('--notes-file') + 2);
      const assets = Object.fromEntries(files.map(file => [path.basename(file), readFileSync(file)]));
      if (create === 'killed') {
        const [first] = Object.keys(assets);
        releases[tag] = { draft: true, assets: { [first]: assets[first] } };
        return done(1, '', 'signal: killed');
      }
      releases[tag] = { draft: false, assets };
      return done(0);
    }
    if (verb === 'release edit' && command.includes('--draft=false')) {
      release.draft = false;
      return done(0);
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { run, calls, releases };
}

const verbs = gh => gh.calls.map(c => c.slice(0, 3).join(' '));

function publish(repo, argv, gh) {
  const lines = [];
  const status = main(argv, { repo, runner: gh.run, print: line => lines.push(line) });
  return { status, output: lines.join('\n') };
}

const remoteTagsOf = origin => gitIn(origin, 'tag', '--list').split('\n').filter(Boolean);

test('tags: peeled ls-remote output, sequences and the next number', () => {
  const tags = remoteTags(['a'.repeat(40) + '\trefs/tags/locale/9.9-1', 'b'.repeat(40) + '\trefs/tags/locale/9.9-1^{}',
    'c'.repeat(40) + '\trefs/tags/locale/9.9-3', 'd'.repeat(40) + '\trefs/tags/locale/9.9-x',
    'e'.repeat(40) + '\trefs/tags/locale/9.10-7', ''].join('\n'));
  assert.equal(tags['locale/9.9-1'], 'b'.repeat(40));
  assert.deepEqual(sequences(tags, '9.9'), { 1: 'locale/9.9-1', 3: 'locale/9.9-3' });
  assert.equal(nextSequence(tags, '9.9'), 4);
  assert.equal(nextSequence(tags, '9.8'), 1);
  assert.equal(tagName('0.5.5.5', 1), 'locale/0.5.5.5-1');
});

test('stage: the three assets under their release names, GNU SHA256SUMS sorted by name', t => {
  const { repo } = setup(t);
  const built = build({ repo });
  const staged = stage(built.out, path.join(repo, '.cache/stage'));
  const assets = path.join(repo, '.cache/stage/assets');
  assert.deepEqual(readdirSync(assets).sort(), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json']);
  assert.deepEqual(Object.keys(staged.assets), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json']);
  assert.deepEqual(readFileSync(path.join(assets, 'pobr-locale-9.9.zip')), built.zip);
  assert.equal(readFileSync(path.join(assets, 'SHA256SUMS'), 'utf8'),
    `${sha256(built.zip)}  pobr-locale-9.9.zip\n${sha256(built.receiptRaw)}  receipt.json\n`);
  const [tag, push, release] = commands(staged, 'locale/9.9-1', 'c'.repeat(40));
  assert.deepEqual(tag.slice(0, 2).concat(tag.slice(-2)), ['git', 'tag', 'locale/9.9-1', 'c'.repeat(40)]);
  assert.deepEqual(push, ['git', 'push', 'origin', 'refs/tags/locale/9.9-1']);
  assert.deepEqual(release.slice(0, 8), ['gh', 'release', 'create', 'locale/9.9-1', '--repo', 'ackness/poe2-zh-cn-stats', '--verify-tag', '--title']);
  assert.deepEqual(release.slice(-3).map(f => path.basename(f)), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json']);
  // A build whose zip no longer matches its receipt is not staged.
  write(repo, '.cache/release/poe2-international-9.9/pobr-locale-9.9.zip', Buffer.concat([built.zip, Buffer.from('x')]));
  assert.throws(() => stage(built.out, path.join(repo, '.cache/stage')), /differs from its pin in receipt\.json/u);
  assert.throws(() => stage(built.out, path.join(repo, 'release')), /differs|non-publish/u);
});

test('preflight: a clean commit on origin/main passes; dirty, unpushed and unreachable do not', t => {
  const { repo, commit } = setup(t);
  assert.deepEqual(preflight(repo), { commit, problems: [], warnings: [] });
  write(repo, 'scratch.txt', 'x');
  assert.match(preflight(repo).problems.join(), /working tree is not clean \(1 paths, e\.g\. scratch\.txt\)/u);
  rmSync(path.join(repo, 'scratch.txt'));
  const local = commitAll(repo, 'not pushed');
  assert.deepEqual(preflight(repo).problems, [`HEAD ${local} is not on origin/main`]);
  gitIn(repo, 'remote', 'set-url', 'origin', path.join(repo, 'missing.git'));
  const offline = preflight(repo);
  assert.match(offline.warnings.join(), /could not fetch origin\/main/u);
  assert.deepEqual(offline.problems, [`HEAD ${local} is not on origin/main`]);
});

test('plan: next number, resume an unpushed tag, recognise a pushed one, never renumber HEAD', t => {
  const { repo, origin, commit } = setup(t);
  assert.deepEqual(plan(repo, '9.9', commit, {}), { action: 'new', sequence: 1, problems: [] });
  assert.deepEqual(plan(repo, '9.9', commit, { 'locale/9.9-1': 'a'.repeat(40) }), { action: 'new', sequence: 2, problems: [] });
  assert.equal(plan(repo, '9.9', commit, null).action, null);
  gitIn(repo, 'tag', 'locale/9.9-1', commit);
  assert.deepEqual(plan(repo, '9.9', commit, {}), { action: 'resume-push', sequence: 1, problems: [] });
  assert.deepEqual(plan(repo, '9.9', commit, { 'locale/9.9-1': 'a'.repeat(40) }).problems,
    ['locale/9.9-1 names another commit on the remote']);
  gitIn(repo, 'push', '-q', 'origin', 'refs/tags/locale/9.9-1');
  assert.deepEqual(plan(repo, '9.9', commit, { 'locale/9.9-1': commit }), { action: 'remote-tag', sequence: 1, problems: [] });
  const next = commitAll(repo, 'next');
  gitIn(repo, 'tag', 'locale/9.9-2', commit);
  assert.deepEqual(plan(repo, '9.9', next, { 'locale/9.9-1': commit }).problems,
    ['a local tag locale/9.9-2 exists that the remote does not have; delete it']);
  assert.deepEqual(remoteTagsOf(origin), ['locale/9.9-1']);
});

test('dry run (the default): stages and prints the plan, runs nothing', t => {
  const { repo, origin, commit } = setup(t);
  for (const argv of [[], ['--dry-run']]) {
    const gh = runner(repo);
    const { status, output } = publish(repo, argv, gh);
    assert.equal(status, 0);
    assert.deepEqual(verbs(gh), ['gh auth status']);
    assert.match(output, new RegExp(`tag: locale/9\\.9-1 -> ${commit}`, 'u'));
    assert.match(output, /git push origin refs\/tags\/locale\/9\.9-1/u);
    assert.match(output, /dry run: nothing was tagged, pushed or released/u);
  }
  assert.deepEqual(remoteTagsOf(origin), []);
  assert.equal(gitIn(repo, 'tag', '--list'), '');
  const notes = readFileSync(path.join(repo, '.cache/release', STAGE, 'release-notes.md'), 'utf8');
  assert.match(notes, /mise run data:bump ackness\/poe2-zh-cn-stats locale\/9\.9-1/u);
  assert.throws(() => publish(repo, ['--dry-run', '--yes'], runner(repo)), /mutually exclusive/u);
});

test('--yes tags, pushes and creates the Release; rerunning only verifies it', t => {
  const { repo, origin, commit } = setup(t);
  const gh = runner(repo);
  const { status, output } = publish(repo, ['--yes'], gh);
  assert.equal(status, 0);
  assert.match(output, /published https:\/\/github\.com\/ackness\/poe2-zh-cn-stats\/releases\/tag\/locale\/9\.9-1/u);
  assert.deepEqual(verbs(gh), ['gh auth status', 'git tag --annotate', 'git push origin', 'gh release create']);
  assert.equal(gitIn(origin, 'rev-parse', 'locale/9.9-1^{commit}'), commit);
  assert.match(gitIn(origin, 'tag', '-l', '--format=%(contents)', 'locale/9.9-1'), /pobr-locale-9\.9\.zip/u);
  const { releases } = gh;
  assert.deepEqual(Object.keys(releases['locale/9.9-1'].assets), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json']);
  const again = runner(repo, { releases });
  const rerun = publish(repo, ['--yes'], again);
  assert.equal(rerun.status, 0);
  assert.match(rerun.output, /already published: locale\/9\.9-1 names HEAD/u);
  assert.deepEqual(verbs(again), ['gh auth status', 'gh release view', 'gh release download']);
  // A dry run still shows plan problems before reporting the existing Release.
  write(repo, 'scratch.txt', 'x');
  const dirty = publish(repo, [], runner(repo, { releases }));
  assert.equal(dirty.status, 1);
  assert.match(dirty.output, /already published: locale\/9\.9-1[^]*problems:\n {2}- the working tree is not clean/u);
  rmSync(path.join(repo, 'scratch.txt'));
  // Other bytes under the same tag are an error, never overwritten.
  releases['locale/9.9-1'].assets['pobr-locale-9.9.zip'] = Buffer.from('tampered');
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { releases })), /already released with other assets/u);
});

test('an interrupted upload leaves a draft: finish a complete one, refuse an incomplete one', t => {
  const { repo } = setup(t);
  const releases = {};
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { releases, create: 'killed' })), /step failed: gh release create/u);
  assert.equal(releases['locale/9.9-1'].draft, true);
  // Incomplete draft: never "already published"; the remedy keeps the tag.
  const dry = publish(repo, [], runner(repo, { releases }));
  assert.equal(dry.status, 1);
  assert.match(dry.output, /commands: none until the problems below are resolved/u);
  assert.match(dry.output, /locale\/9\.9-1 is a draft Release whose assets are incomplete or differ from the staged ones \(pobr-locale-9\.9\.zip,receipt\.json\); delete the draft with `gh release delete locale\/9\.9-1 --repo ackness\/poe2-zh-cn-stats --yes` \(keeps the tag\) and rerun/u);
  const refused = runner(repo, { releases });
  assert.equal(publish(repo, ['--yes'], refused).status, 1);
  assert.deepEqual(verbs(refused), ['gh auth status', 'gh release view']);
  delete releases['locale/9.9-1'];
  const recreate = runner(repo, { releases });
  assert.equal(publish(repo, ['--yes'], recreate).status, 0);
  assert.deepEqual(verbs(recreate), ['gh auth status', 'gh release view', 'gh release create']);
  // A draft that holds exactly the staged assets is published as it is.
  releases['locale/9.9-1'].draft = true;
  const plan = publish(repo, [], runner(repo, { releases }));
  assert.match(plan.output, /gh release edit locale\/9\.9-1 --repo ackness\/poe2-zh-cn-stats --draft=false/u);
  const finish = runner(repo, { releases });
  assert.equal(publish(repo, ['--yes'], finish).status, 0);
  assert.deepEqual(verbs(finish), ['gh auth status', 'gh release view', 'gh release edit']);
  assert.equal(releases['locale/9.9-1'].draft, false);
});

test('the same bytes never get a second number from a later commit', t => {
  const { repo } = setup(t);
  const releases = {};
  assert.equal(publish(repo, ['--yes'], runner(repo, { releases })).status, 0);
  write(repo, 'docs.md', 'unrelated\n');
  commitAll(repo, 'unrelated');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const result = publish(repo, [], runner(repo, { releases }));
  assert.equal(result.status, 1);
  assert.match(result.output, /tag: locale\/9\.9-2[^]*these exact bytes are already published as locale\/9\.9-1; pin that Release instead/u);
  // Other bytes, or a previous tag without a Release, get the next number.
  releases['locale/9.9-1'].assets.SHA256SUMS = Buffer.from(`${'0'.repeat(64)}  pobr-locale-9.9.zip\n`);
  assert.equal(publish(repo, [], runner(repo, { releases })).status, 0);
  delete releases['locale/9.9-1'];
  assert.equal(publish(repo, [], runner(repo, { releases })).status, 0);
});

test('a dry run without gh reports it instead of failing', t => {
  const { repo } = setup(t);
  const releases = {};
  assert.equal(publish(repo, ['--yes'], runner(repo, { releases })).status, 0);
  for (const args of [[], ['--yes']]) {
    const fn = () => publish(repo, args, runner(repo, { gh: false }));
    if (args.length) assert.throws(fn, /gh is not available/u);
    else {
      const { status, output } = fn();
      assert.equal(status, 1);
      assert.match(output, /publish refused:\n {2}- gh is not available: spawnSync gh ENOENT/u);
    }
  }
});

test('--yes refuses before building: gh missing or logged out, dirty tree', t => {
  const { repo, origin } = setup(t);
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { auth: false })), /refusing to publish:\n {2}- gh is not authenticated/u);
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { gh: false })), /gh is not available/u);
  write(repo, 'docs.md', 'untracked\n');
  assert.throws(() => publish(repo, ['--yes'], runner(repo)), /working tree is not clean \(1 paths, e\.g\. docs\.md\)/u);
  assert.ok(!existsSync(path.join(repo, '.cache/release')));
  assert.deepEqual(remoteTagsOf(origin), []);
});

test('a failed step resumes with the same tag; an unpushed local tag resumes from the push', t => {
  const { repo, origin, commit } = setup(t);
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { create: 'fail' })),
    /step failed: gh release create locale\/9\.9-1[^]*rerun release:publish to resume/u);
  assert.equal(gitIn(origin, 'rev-parse', 'locale/9.9-1^{commit}'), commit);
  const gh = runner(repo);
  assert.equal(publish(repo, ['--yes'], gh).status, 0);
  assert.deepEqual(verbs(gh), ['gh auth status', 'gh release view', 'gh release create']);
  // A tag made locally but never pushed.
  const fresh = setup(t);
  gitIn(fresh.repo, 'tag', 'locale/9.9-1', fresh.commit);
  const resumed = runner(fresh.repo);
  const { output } = publish(fresh.repo, ['--yes'], resumed);
  assert.match(output, /\(tagged locally; resuming from the push\)/u);
  assert.deepEqual(verbs(resumed), ['gh auth status', 'git push origin', 'gh release create']);
});

test('the package must be built from HEAD and not already published under another tag', t => {
  const { repo, manifestRaw } = setup(t);
  assert.throws(() => publish(repo, ['--reuse'], runner(repo)), /ENOENT/u);
  build({ repo });
  let result = publish(repo, ['--reuse'], runner(repo));
  assert.equal(result.status, 0);
  write(repo, 'docs.md', 'x\n');
  commitAll(repo, 'later');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  assert.throws(() => publish(repo, ['--reuse'], runner(repo)), /was not built from this checkout/u);
  // The config declares these bytes as published already.
  const built = build({ repo });
  const published = { tag: 'locale/9.9-1', asset: 'pobr-locale-9.9.zip', ...pin(built.zip) };
  write(repo, 'release/9.9.json', bytes(config(manifestRaw, { published })));
  commitAll(repo, 'declare published');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  result = publish(repo, [], runner(repo));
  assert.equal(result.status, 1);
  assert.match(result.output, /already published as locale\/9\.9-1; nothing new to publish/u);
  write(repo, 'release/9.9.json', bytes(config(manifestRaw, { published: { ...published, sha256: '0'.repeat(64) } })));
  commitAll(repo, 'declare other bytes');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  result = publish(repo, [], runner(repo));
  assert.match(result.output, /differs from the published locale\/9\.9-1 the config declares/u);
});

test('a config on hold or named for another sequence is not published', t => {
  const { repo, manifestRaw } = setup(t);
  write(repo, 'release/9.9-2.json', bytes(config(manifestRaw, { hold: 'PoBR cannot adopt it yet' })));
  commitAll(repo, 'a held candidate for locale/9.9-2');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const refused = /release\/9\.9-2\.json is on hold: PoBR cannot adopt it yet\n {2}- release\/9\.9-2\.json is meant for locale\/9\.9-2, but the next free tag is locale\/9\.9-1/u;
  const held = ['--config', path.join(repo, 'release/9.9-2.json')];
  assert.throws(() => publish(repo, ['--yes', ...held], runner(repo)), refused);
  const { status, output } = publish(repo, held, runner(repo));
  assert.equal(status, 1);
  assert.match(output, /publish refused:/u);
  assert.ok(existsSync(path.join(repo, '.cache/release/publish/poe2-international-9.9-2/release-notes.md')));
  // The held config is not the default: the plain config of the same patch publishes as locale/9.9-1.
  const plain = publish(repo, [], runner(repo));
  assert.equal(plain.status, 0, plain.output);
});

test('a Release with a support display: published, verified on rerun, and a duplicate only without new display bytes', t => {
  const context = setup(t), { repo } = context;
  addRetainedDisplay(context);
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const display = ['support-display.zh-CN.json', 'supportDescriptions.zh-CN.json'];
  // An interrupted upload: the draft lacks the display files, so it is not finished as it is.
  const releases = {};
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { releases, create: 'killed' })), /step failed: gh release create/u);
  const dry = publish(repo, [], runner(repo, { releases }));
  assert.equal(dry.status, 1);
  assert.match(dry.output, /draft Release whose assets are incomplete or differ from the staged ones \(pobr-locale-9\.9\.zip,receipt\.json,support-display\.zh-CN\.json,supportDescriptions\.zh-CN\.json\)/u);
  delete releases['locale/9.9-1'];
  assert.equal(publish(repo, ['--yes'], runner(repo, { releases })).status, 0);
  assert.deepEqual(Object.keys(releases['locale/9.9-1'].assets).sort(), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json', ...display].sort());
  assert.match(releases['locale/9.9-1'].assets.SHA256SUMS.toString(), /  supportDescriptions\.zh-CN\.json\n/u);
  // The remote tag's Release is compared asset by asset, the display files included.
  const rerun = publish(repo, ['--yes'], runner(repo, { releases }));
  assert.match(rerun.output, /already published: locale\/9\.9-1 names HEAD and its Release assets equal the staged ones/u);
  releases['locale/9.9-1'].assets['supportDescriptions.zh-CN.json'] = Buffer.from('{}\n');
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { releases })), /already released with other assets/u);
  releases['locale/9.9-1'].assets['supportDescriptions.zh-CN.json'] = readFileSync(path.join(repo, 'inputs/support-display-test/supportDescriptions.zh-CN.json'));
  // A later commit with the same zip and display is a duplicate.
  write(repo, 'docs.md', 'unrelated\n');
  commitAll(repo, 'unrelated');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const duplicate = publish(repo, [], runner(repo, { releases }));
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.output, /these exact bytes are already published as locale\/9\.9-1; pin that Release instead/u);
  // The same zip with another display is new content for locale/9.9-2 ...
  const zip = pin(releases['locale/9.9-1'].assets['pobr-locale-9.9.zip']);
  const other = retained({ entries: { SupportA: { en: 'Supports Attacks.', zh_cn: '辅助攻击！' } } });
  rmSync(path.join(repo, 'inputs/support-display-test'), { recursive: true });
  addRetainedDisplay(context, { files: other });
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const fresh = publish(repo, [], runner(repo, { releases }));
  assert.equal(fresh.status, 0, fresh.output);
  assert.match(fresh.output, /tag: locale\/9\.9-2/u);
  // ... but not by editing a config that already declares its Release.
  rmSync(path.join(repo, 'inputs/support-display-test'), { recursive: true });
  addRetainedDisplay(context, { files: other, published: { tag: 'locale/9.9-1', asset: 'pobr-locale-9.9.zip', ...zip } });
  gitIn(repo, 'push', '-q', 'origin', 'main');
  const edited = publish(repo, [], runner(repo, { releases }));
  assert.equal(edited.status, 1);
  assert.match(edited.output, /the zip is already published as locale\/9\.9-1; a new display needs release\/9\.9-2\.json/u);
});
