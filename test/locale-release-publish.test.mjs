import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { build, pin, sha256 } from '../src/locale-release.mjs';
import {
  commands, main, nextSequence, plan, preflight, remoteTags, sequences, stage, tagName,
} from '../src/locale-release-publish.mjs';
import { bytes, commitAll, config, fixture, gitIn, write } from './locale-release-fixture.mjs';

const STAGE = 'publish/poe2-international-9.9';

function setup(t) {
  const context = fixture('locale-publish');
  t.after(() => rmSync(context.root, { recursive: true, force: true }));
  return context;
}

// Git runs for real (tags are pushed to the fixture's bare origin); gh is simulated.
function runner(repo, { auth = true, released = null, create = true } = {}) {
  const calls = [];
  const state = { released };
  const done = (status, stderr = '') => ({ status, stdout: Buffer.alloc(0), stderr: Buffer.from(stderr) });
  const run = (command, options = {}) => {
    calls.push(command);
    if (command[0] === 'git') {
      try {
        gitIn(repo, ...command.slice(1));
        return done(0);
      } catch (error) {
        return done(1, error.message);
      }
    }
    const verb = command.slice(1, 3).join(' ');
    if (verb === 'auth status') return auth ? done(0) : done(1, 'You are not logged into any GitHub hosts');
    if (verb === 'release view') return state.released ? done(0) : done(1, 'release not found');
    if (verb === 'release download') {
      const directory = command[command.indexOf('--dir') + 1];
      for (const file of state.released) copyFileSync(file, path.join(directory, path.basename(file)));
      return done(0);
    }
    if (verb === 'release create') {
      if (!create) return done(1, 'HTTP 502');
      state.released = command.slice(command.indexOf('--notes-file') + 2);
      return done(0);
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { run, calls, state };
}

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
    assert.deepEqual(gh.calls, []);
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
  assert.deepEqual(gh.calls.map(c => c.slice(0, 3).join(' ')), ['gh auth status', 'git tag --annotate', 'git push origin', 'gh release create']);
  assert.equal(gitIn(origin, 'rev-parse', 'locale/9.9-1^{commit}'), commit);
  assert.match(gitIn(origin, 'tag', '-l', '--format=%(contents)', 'locale/9.9-1'), /pobr-locale-9\.9\.zip/u);
  assert.deepEqual(gh.state.released.map(f => path.basename(f)), ['SHA256SUMS', 'pobr-locale-9.9.zip', 'receipt.json']);
  // The Release keeps its own copies; restaging replaces the staged files.
  const copies = gh.state.released.map(file => {
    const copy = path.join(repo, '.cache/released', path.basename(file));
    write(repo, path.relative(repo, copy), readFileSync(file));
    return copy;
  });
  const again = runner(repo, { released: copies });
  const rerun = publish(repo, ['--yes'], again);
  assert.equal(rerun.status, 0);
  assert.match(rerun.output, /already published: locale\/9\.9-1 names HEAD/u);
  assert.ok(!again.calls.some(c => c[0] === 'git' || c[2] === 'create'));
  // Other bytes under the same tag are an error, never overwritten.
  write(repo, path.relative(repo, copies[1]), Buffer.from('tampered'));
  assert.throws(() => publish(repo, ['--yes'], again), /already released with other assets/u);
});

test('--yes refuses before building: gh missing or logged out, dirty tree', t => {
  const { repo, origin } = setup(t);
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { auth: false })), /refusing to publish:\n {2}- gh is not authenticated/u);
  const missing = { run: () => { throw new Error('spawnSync gh ENOENT'); } };
  assert.throws(() => publish(repo, ['--yes'], missing), /gh is not available/u);
  write(repo, 'docs.md', 'untracked\n');
  assert.throws(() => publish(repo, ['--yes'], runner(repo)), /working tree is not clean \(1 paths, e\.g\. docs\.md\)/u);
  assert.ok(!existsSync(path.join(repo, '.cache/release')));
  assert.deepEqual(remoteTagsOf(origin), []);
});

test('a failed step resumes with the same tag; an unpushed local tag resumes from the push', t => {
  const { repo, origin, commit } = setup(t);
  assert.throws(() => publish(repo, ['--yes'], runner(repo, { create: false })),
    /step failed: gh release create locale\/9\.9-1[^]*rerun release:publish to resume/u);
  assert.equal(gitIn(origin, 'rev-parse', 'locale/9.9-1^{commit}'), commit);
  const gh = runner(repo);
  assert.equal(publish(repo, ['--yes'], gh).status, 0);
  assert.deepEqual(gh.calls.map(c => c.slice(0, 3).join(' ')), ['gh auth status', 'gh release view', 'gh release create']);
  // A tag made locally but never pushed.
  const fresh = setup(t);
  gitIn(fresh.repo, 'tag', 'locale/9.9-1', fresh.commit);
  const resumed = runner(fresh.repo);
  const { output } = publish(fresh.repo, ['--yes'], resumed);
  assert.match(output, /\(tagged locally; resuming from the push\)/u);
  assert.deepEqual(resumed.calls.map(c => c.slice(0, 3).join(' ')), ['gh auth status', 'git push origin', 'gh release create']);
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
