import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { strictJson } from '../src/strict-json.mjs';
import { crc32, readZip, storedZip } from '../src/stored-zip.mjs';
import {
  ROOT, build, check, checkRelease, defaultConfig, download, loadConfig, pin, releaseUrl, remoteLocaleTags, sha256, unpinnedTags,
} from '../src/locale-release.mjs';
import { SOURCE_DIR, SOURCE_FILES, TARGET, bytes, commitAll, config, fixture, gitIn, sourceManifest, write } from './locale-release-fixture.mjs';

const members = () => new Map([['b.json', Buffer.from('{"b":1}\n')], ['a/x.json', Buffer.from('[]')], ['manifest.json', Buffer.from('{}\n')]]);

test('stored zip: deterministic, sorted, fixed headers and readable', () => {
  const zip = storedZip(members());
  assert.deepEqual(zip, storedZip(new Map([...members()].reverse())));
  const read = readZip(zip);
  assert.deepEqual([...read.keys()], ['a/x.json', 'b.json', 'manifest.json']);
  for (const [name, raw] of members()) {
    assert.deepEqual(read.get(name).raw, raw);
    assert.equal(read.get(name).method, 0);
    assert.equal(read.get(name).mode, 0o100644);
  }
  // Local header of the first member: version 2.0, no flags, stored, 1980-01-01 00:00:00.
  assert.deepEqual([...zip.subarray(4, 14)], [20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0]);
  assert.equal(zip.readUInt32LE(14), crc32(Buffer.from('[]')));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.throws(() => storedZip(new Map([['../x', Buffer.alloc(0)]])), /Unsafe/u);
  assert.throws(() => storedZip(new Map([['名.json', Buffer.alloc(0)]])), /non-ASCII/u);
  assert.throws(() => readZip(Buffer.concat([zip, Buffer.from('x')])), /comment-free/u);
  const corrupt = Buffer.from(zip);
  corrupt[30 + 'a/x.json'.length] ^= 1;
  assert.throws(() => readZip(corrupt), /Corrupt ZIP member/u);
});

// RePoE's write_zip convention with ZIP_STORED: Python's zipfile must write the same bytes.
test('stored zip equals Python zipfile output', t => {
  const script = `import io,stat,sys,zipfile
src=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
assert src.testzip() is None
out=io.BytesIO()
with zipfile.ZipFile(out,'x',compression=zipfile.ZIP_STORED) as z:
    for name in sorted(src.namelist()):
        info=zipfile.ZipInfo(name,(1980,1,1,0,0,0)); info.create_system=3; info.external_attr=(stat.S_IFREG|0o644)<<16
        z.writestr(info,src.read(name),compress_type=zipfile.ZIP_STORED)
sys.stdout.buffer.write(out.getvalue())`;
  const zip = storedZip(members());
  const result = spawnSync('python3', ['-I', '-c', script], { input: zip });
  if (result.error) return t.skip('python3 is not available');
  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, zip);
});

test('build: members are the source i18n bytes and the manifest pins them in order', t => {
  const { root, repo, commit, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const built = build({ repo });
  assert.equal(built.out, path.join(repo, '.cache/release/poe2-international-9.9'));
  const zip = readFileSync(path.join(built.out, 'pobr-locale-9.9.zip'));
  assert.deepEqual(zip, built.zip);
  const read = readZip(zip);
  const expected = Object.entries(SOURCE_FILES).filter(([name]) => name.startsWith('i18n/'));
  assert.deepEqual([...read.keys()].sort(), ['manifest.json', ...expected.map(([n]) => `data/9.9/${n}`)].sort());
  for (const [name, raw] of expected) assert.deepEqual(read.get(`data/9.9/${name}`).raw, raw);
  const manifest = strictJson(read.get('manifest.json').raw);
  assert.deepEqual(manifest, {
    schema: 'pobr-build-data-part/v1', kind: 'language', target: TARGET,
    source: { repository: 'ackness/poe2-zh-cn-stats', publication: { path: `${SOURCE_DIR}/manifest.json`, ...pin(manifestRaw) } },
    files: Object.fromEntries(expected.map(([n, raw]) => [`data/9.9/${n}`, pin(raw)]).sort(([a], [b]) => (a < b ? -1 : 1))),
  });
  assert.deepEqual(Object.keys(manifest.files), Object.keys(manifest.files).sort());
  // The receipt pins every source file (evidence too), the source manifest and the package.
  const receipt = strictJson(readFileSync(path.join(built.out, 'receipt.json')));
  assert.equal(receipt.schema, 'poe2-locale-release-receipt/v1');
  assert.deepEqual(receipt.target, TARGET);
  assert.deepEqual({ ...receipt.producer, code: undefined, config: undefined },
    { repository: 'ackness/poe2-zh-cn-stats', commit, dirty: false, dirty_paths: [], code: undefined, config: undefined });
  assert.deepEqual(receipt.producer.config, { 'release/9.9.json': pin(readFileSync(path.join(repo, 'release/9.9.json'))) });
  assert.deepEqual(Object.keys(receipt.producer.code), ['src/locale-release.mjs', 'src/locale-package.mjs',
    'src/support-display.mjs', 'src/support-description-projection.mjs', 'src/stored-zip.mjs', 'src/strict-json.mjs', 'mise.lock']);
  assert.deepEqual(receipt.source.manifest, { path: `${SOURCE_DIR}/manifest.json`, ...pin(manifestRaw), schema: 'poe2-retained-locale-publication/v1' });
  assert.deepEqual(receipt.source.files, Object.fromEntries(Object.entries(SOURCE_FILES).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, raw]) => [`${SOURCE_DIR}/${name}`, pin(raw)])));
  assert.deepEqual(receipt.package, {
    asset: 'pobr-locale-9.9.zip', ...pin(zip), expanded_bytes: [...read.values()].reduce((n, e) => n + e.raw.length, 0),
    manifest: pin(read.get('manifest.json').raw),
    members: Object.fromEntries(expected.map(([n]) => [`data/9.9/${n}`, `${SOURCE_DIR}/${n}`]).sort(([a], [b]) => (a < b ? -1 : 1))),
    // The language index rides in the receipt, not the zip.
    index: { languages: {
      'zh-CN': { fallback: [], tables: { 'stat_lines.json': { entries: 1 } } },
      'zh-TW': { fallback: [], tables: { 'mods.json': { entries: 1 } } },
    } },
  });
  const receiptRaw = readFileSync(path.join(built.out, 'receipt.json'));
  assert.equal(readFileSync(path.join(built.out, 'SHA256SUMS'), 'utf8'),
    `${sha256(zip)}  pobr-locale-9.9.zip\n${sha256(receiptRaw)}  receipt.json\n`);
});

test('build: reproducible, and the zip does not depend on the producer commit', t => {
  const { root, repo } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = build({ repo });
  const again = build({ repo, out: path.join(repo, '.cache/second') });
  assert.deepEqual(again.zip, first.zip);
  assert.deepEqual(again.receiptRaw, first.receiptRaw);
  write(repo, 'docs.md', 'an unrelated change\n');
  const commit = commitAll(repo, 'unrelated');
  const later = build({ repo });
  assert.deepEqual(later.zip, first.zip);
  assert.equal(later.receipt.producer.commit, commit);
  assert.deepEqual({ ...later.receipt, producer: null }, { ...first.receipt, producer: null });
});

test('build: records a dirty producer on tracked changes and untracked inputs only', t => {
  const { root, repo } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(repo, 'notes.txt', 'untracked outside the inputs\n');
  assert.equal(build({ repo }).receipt.producer.dirty, false);
  write(repo, 'src/extra.mjs', '// untracked input\n');
  assert.deepEqual(build({ repo }).receipt.producer.dirty_paths, ['src/extra.mjs']);
  rmSync(path.join(repo, 'src/extra.mjs'));
  write(repo, '.gitignore', '.cache/\nchanged\n');
  const { producer } = build({ repo }).receipt;
  assert.deepEqual([producer.dirty, producer.dirty_paths], [true, ['.gitignore']]);
});

test('build: refuses changed, unlisted or mislabelled source bytes', t => {
  const { root, repo, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reset = () => { gitIn(repo, 'checkout', '-q', '--', '.'); gitIn(repo, 'clean', '-fdq', 'inputs'); };
  write(repo, `${SOURCE_DIR}/i18n/zh-CN/_meta.json`, '{"lang":"zh-TW"}\n');
  assert.throws(() => build({ repo }), /_meta\.json differs from its pin/u);
  reset();
  write(repo, `${SOURCE_DIR}/i18n/zh-CN/stray.json`, '{}\n');
  assert.throws(() => build({ repo }), /Unlisted files in inputs\/locale-test: i18n\/zh-CN\/stray\.json/u);
  reset();
  write(repo, `${SOURCE_DIR}/manifest.json`, sourceManifest(SOURCE_FILES, { ...TARGET, realm: 'china' }));
  assert.throws(() => build({ repo }), /differs from its pin in the release config/u);
  write(repo, 'release/9.9.json', bytes(config(readFileSync(path.join(repo, SOURCE_DIR, 'manifest.json')))));
  assert.throws(() => build({ repo }), /target differs from the release config/u);
  reset();
  write(repo, 'release/9.9.json', bytes({ ...config(manifestRaw), target: { ...TARGET, game_patch: '9.8' } }));
  assert.throws(() => build({ repo }), /9\.9\.json declares game patch 9\.8/u);
  reset();
  assert.throws(() => build({ repo, out: path.join(repo, 'release') }), /Output must be under \.cache/u);
  write(repo, '.cache/occupied/file', 'x');
  assert.throws(() => build({ repo, out: path.join(repo, '.cache/occupied') }), /non-release directory/u);
});

test('check: clean, origin tree and published pin', async t => {
  const { root, repo, commit, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let built = build({ repo });
  assert.match(check(repo, built).join('\n'), /origin f{40} is not present locally/u);
  const origin = { repository: 'ackness/poe2-zh-cn-stats', tag: 'handoff/test', revision: commit };
  const published = { tag: 'locale/9.9-1', asset: 'pobr-locale-9.9.zip', ...pin(built.zip) };
  const declare = extra => {
    const declared = config(manifestRaw, extra);
    write(repo, 'release/9.9.json', bytes({ ...declared, source: { ...declared.source, origin } }));
  };
  declare({ published });
  commitAll(repo, 'declare origin and published');
  built = build({ repo });
  assert.deepEqual(check(repo, built), []);
  declare({ published: { ...published, sha256: '0'.repeat(64) } });
  built = build({ repo });
  assert.deepEqual(check(repo, built), ['the checkout is dirty: release/9.9.json',
    `the package differs from the published locale/9.9-1 (${'0'.repeat(64)})`]);
  // The published Release must serve the rebuilt zip and list it in SHA256SUMS.
  declare({ published });
  built = build({ repo });
  const served = new Map([
    [releaseUrl('ackness/poe2-zh-cn-stats', 'locale/9.9-1', 'SHA256SUMS'), Buffer.from(`${published.sha256}  pobr-locale-9.9.zip\n`)],
    [releaseUrl('ackness/poe2-zh-cn-stats', 'locale/9.9-1', 'pobr-locale-9.9.zip'), built.zip],
  ]);
  await checkRelease(built, async url => served.get(url));
  served.set([...served.keys()][1], Buffer.from('other'));
  await assert.rejects(checkRelease(built, async url => served.get(url)), /differs from the rebuilt package/u);
  assert.equal(releaseUrl('o/r', 'locale/9.9-1', 'a.zip', 'http://127.0.0.1:1/'), 'http://127.0.0.1:1/o/r/releases/download/locale/9.9-1/a.zip');
});

test('check: a source moved after its origin commit keeps its tree and package bytes', t => {
  const { root, repo, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = build({ repo });
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const moved = 'inputs/locale-moved';
  gitIn(repo, 'mv', SOURCE_DIR, moved);
  const declared = config(manifestRaw);
  const origin = { repository: 'ackness/poe2-zh-cn-stats', tag: 'handoff/test', revision: commit,
    path: `${SOURCE_DIR}/manifest.json` };
  write(repo, 'release/9.9.json', bytes({ ...declared,
    source: { manifest: { ...declared.source.manifest, path: `${moved}/manifest.json` }, origin } }));
  commitAll(repo, 'move the source');
  const built = build({ repo });
  // The package records the origin path, so its bytes do not depend on the current directory.
  assert.deepEqual(built.zip, before.zip);
  assert.equal(strictJson(readZip(built.zip).get('manifest.json').raw).source.publication.path, `${SOURCE_DIR}/manifest.json`);
  assert.equal(built.receipt.source.manifest.path, `${moved}/manifest.json`);
  assert.deepEqual(check(repo, built), []);
  write(repo, `${moved}/README.md`, 'changed\n');
  commitAll(repo, 'change the moved tree');
  assert.deepEqual(check(repo, build({ repo })), [`${moved} differs from ${SOURCE_DIR} at handoff/test`]);
  write(repo, 'release/9.9.json', bytes({ ...declared, source: { ...declared.source,
    origin: { ...origin, path: '../escape/manifest.json' } } }));
  assert.throws(() => build({ repo }), /Unsafe path/u);
});

test('the committed release configs build their pinned publications and expected packages', t => {
  const parent = mkdtempSync(path.join(ROOT, '.cache', 'locale-release-real-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const files = readdirSync(path.join(ROOT, 'release')).filter(name => name.endsWith('.json'));
  assert.ok(files.includes(path.basename(defaultConfig(ROOT))));
  for (const name of files) {
    const configFile = path.join(ROOT, 'release', name);
    const loaded = loadConfig(configFile), { config: declared } = loaded;
    const built = build({ config: configFile, out: path.join(parent, name) });
    const { published, expect } = declared;
    for (const wanted of [published, expect?.package].filter(Boolean)) assert.deepEqual(pin(built.zip), { bytes: wanted.bytes, sha256: wanted.sha256 }, name);
    const sourceConfig = (loaded.base ?? loaded).config;
    const source = strictJson(readFileSync(path.join(ROOT, sourceConfig.source.manifest.path)));
    const i18n = Object.entries(source.files).filter(([member]) => member.startsWith('i18n/'));
    const manifest = strictJson(readZip(built.zip).get('manifest.json').raw);
    const transformed = new Set((declared.transforms ?? []).map(transform => `data/${declared.target.game_patch}/${transform.member}`));
    for (const [member, expected] of i18n) {
      const packaged = `data/${declared.target.game_patch}/${member}`;
      if (!transformed.has(packaged)) assert.deepEqual(manifest.files[packaged], expected, `${name}: ${member}`);
    }
  }
});

test('check-release: every locale/* tag on origin is pinned by exactly one release config', t => {
  const { root, repo, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const published = tag => ({ tag, asset: 'pobr-locale-9.9.zip', bytes: 1, sha256: '0'.repeat(64) });
  const tagged = (...tags) => {
    for (const tag of tags) gitIn(repo, 'tag', tag);
    gitIn(repo, 'push', '-q', 'origin', ...tags.map(tag => `refs/tags/${tag}`));
  };
  tagged('handoff/other');
  assert.deepEqual(remoteLocaleTags(repo), []);
  tagged('locale/9.9-1');
  assert.deepEqual(remoteLocaleTags(repo), ['locale/9.9-1']);
  assert.deepEqual(unpinnedTags(repo, remoteLocaleTags(repo)), ['locale/9.9-1 is published, but no release config pins it: '
    + 'write "published" into release/9.9-1.json or release/9.9.json']);
  write(repo, 'release/9.9.json', bytes(config(manifestRaw, { published: published('locale/9.9-1') })));
  assert.deepEqual(unpinnedTags(repo, remoteLocaleTags(repo)), []);
  // Published, but its config's post-publish PR has not landed.
  write(repo, 'release/9.9-2.json', bytes(config(manifestRaw)));
  tagged('locale/9.9-2');
  assert.deepEqual(unpinnedTags(repo, remoteLocaleTags(repo)), ['locale/9.9-2 is published, but no release config pins it: '
    + 'write "published" into release/9.9-2.json']);
  write(repo, 'release/9.9-2.json', bytes(config(manifestRaw, { published: published('locale/9.9-2') })));
  write(repo, 'release/9.9-1.json', bytes(config(manifestRaw, { published: published('locale/9.9-1') })));
  assert.deepEqual(unpinnedTags(repo, remoteLocaleTags(repo)),
    ['locale/9.9-1 is pinned by several release configs: release/9.9-1.json, release/9.9.json']);
});

test('config: a published tag must name the config patch', t => {
  const { root, repo, manifestRaw } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const published = tag => ({ tag, asset: 'pobr-locale-9.9.zip', bytes: 1, sha256: '0'.repeat(64) });
  const file = path.join(repo, 'release/9.9.json');
  for (const tag of ['locale/9.8-1', 'locale/9.9-0', 'locale/9.9-1x', 'game/9.9-1', 'locale/9.99-1']) {
    write(repo, 'release/9.9.json', bytes(config(manifestRaw, { published: published(tag) })));
    assert.throws(() => loadConfig(file, repo), /Invalid published package pin/u, tag);
  }
  write(repo, 'release/9.9.json', bytes(config(manifestRaw, { published: published('locale/9.9-12') })));
  assert.equal(loadConfig(file, repo).config.published.tag, 'locale/9.9-12');
});

test('download retries network errors, 429 and 5xx, never other HTTP errors', async () => {
  const response = (status, body = '') => ({ ok: status === 200, status, arrayBuffer: async () => Buffer.from(body) });
  const scripted = steps => {
    const calls = [];
    return { calls, fetchImpl: async url => {
      calls.push(url);
      const step = steps.shift();
      if (step instanceof Error) throw step;
      return response(step, 'payload');
    } };
  };
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  let server = scripted([new Error('ECONNRESET'), 503, 200]);
  assert.deepEqual(await download('u', { ...server, sleep }), Buffer.from('payload'));
  assert.deepEqual([server.calls.length, waits], [3, [1000, 2000]]);
  server = scripted([429, 502, 500]);
  await assert.rejects(download('u', { ...server, sleep }), /GET u: HTTP 500 after 3 attempts/u);
  server = scripted([404]);
  await assert.rejects(download('u', { ...server, sleep }), /GET u: HTTP 404$/u);
  assert.equal(server.calls.length, 1);
});
