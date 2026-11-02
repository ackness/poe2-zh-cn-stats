import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, symlink, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { bootstrapPublication, bytePin, checkPublication, registerPublication,
  validateDescriptor, validateIndex, OWNER, ROLES, SCOPE } from '../src/publication-index.mjs';

const bytes = x => Buffer.from(JSON.stringify(x, null, 2) + '\n');
const target = { game: 'poe2', game_patch: '0.5.5.5', realm: 'international' };
const descriptorPath = n => `publication/releases/poe2-international/${n}.json`;
const source = { repository: 'ackness/repoe', revision: 'f'.repeat(40), path: 'handoff/source.zip',
  ...bytePin(Buffer.from('external source')), manifest: bytePin(Buffer.from('external manifest')), expanded_bytes: 999 };

// Valid classic STORE ZIPs; all payloads are tiny, including the synthetic sidecar.
function zip(files) {
  const local = [], central = []; let offset = 0;
  for (const [name, raw] of Object.entries(files)) {
    const nb = Buffer.from(name); let crc = 0xffffffff;
    for (const b of raw) { crc ^= b; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(raw.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(nb.length, 26);
    local.push(h, nb, raw);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(raw.length, 20); c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42); central.push(c, nb);
    offset += h.length + nb.length + raw.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

// Bare object databases exercise real full Git revisions without another checkout.
async function fixture() {
  await mkdir('.cache', { recursive: true });
  const repo = await mkdtemp(path.resolve('.cache/publication-index-test-'));
  const git = (args, input) => execFileSync('git', ['-C', repo, ...args], { input, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
      GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } }).trim();
  git(['init', '--bare', '-q']); await mkdir(path.join(repo, 'publication'), { recursive: true });
  const files = new Map();
  const set = (name, raw) => files.set(name, Buffer.isBuffer(raw) ? raw : bytes(raw));
  function commit(message = 'synthetic') {
    const tree = {};
    for (const [name, value] of files) {
      const parts = name.split('/'); let node = tree;
      for (const p of parts.slice(0, -1)) node = node[p] ??= {};
      node[parts.at(-1)] = value;
    }
    function store(node) {
      const lines = Object.entries(node).map(([name, value]) => {
        if (Buffer.isBuffer(value) || value?.mode) return `${value.mode ?? '100644'} blob ${git(['hash-object', '-w', '--stdin'], value.bytes ?? value)}\t${name}\n`;
        return `040000 tree ${store(value)}\t${name}\n`;
      }).sort();
      return git(['mktree'], lines.join(''));
    }
    return git(['commit-tree', store(tree), '-m', message]);
  }
  const libNames = ['native-catalog.mjs', 'native-names.mjs', 'strict-json.mjs', 'native-catalog-binding.mjs', 'native-catalog-fk-binding.mjs', 'native-localization.mjs'];
  const library = {};
  for (const name of libNames) { const b = Buffer.from(`// synthetic ${name}\n`); set(`src/${name}`, b); library[`src/${name}`] = bytePin(b); }
  const workbench = Buffer.from('// synthetic workbench\n'); set('src/translation-workbench.mjs', workbench);
  const producers = {};
  for (const name of ['locale-producer.mjs', 'legacy-translation-merge.mjs', 'strict-json.mjs']) {
    const p = `src/${name}`, b = files.get(p) ?? Buffer.from(`// synthetic ${name}\n`); set(p, b); producers[p] = bytePin(b);
  }
  const catalogFiles = { 'catalog.json': bytes({ synthetic: 'catalog' }), 'verification.json': bytes({ synthetic: 'full sidecar' }),
    'request.json': bytes({ schema: 'poe2-native-catalog-request/v3', localized: { sha256: source.manifest.sha256 } }) };
  const cm = { schema: 'poe2-native-catalog-manifest/v3', status: 'candidate', production_ready: false, ...target,
    locale: 'zh-CN', target_identity: target, binding_policy: 'stable-key-pinned-fk-structure/v1',
    observed_client: { game_patch: null, realm: null }, producer: Object.fromEntries(Object.entries(library).map(([n, p]) => [n, p.sha256])),
    files: Object.fromEntries(Object.entries(catalogFiles).map(([n, b]) => [n, bytePin(b)])) };
  const cmb = bytes(cm), cz = zip({ ...catalogFiles, 'manifest.json': cmb }); set('handoff/catalog/catalog.zip', cz);
  const validation = { format: 'windows-fk-validation/v1', manifest_sha256: bytePin(cmb).sha256, files: cm.files,
    independent_fk_recomputed: true, boundaries: { observed_patch: null, observed_realm: null, official_client_semantics_verified: false, production_ready: false } };
  set('handoff/catalog/validation.json', validation);
  const runtime = { schema: 'poe2-reviewed-native-supplements/v1', status: 'candidate', production_ready: false,
    sources: [{ ...target, locale: 'zh-CN', catalog_sha256: cm.files['catalog.json'].sha256, verification: cm.files['verification.json'] }], records: [] };
  const rb = bytes(runtime), request = bytes({ synthetic: 'reviewed export' });
  const sm = { schema: 'poe2-reviewed-native-supplements-manifest/v1', status: 'candidate', production_ready: false,
    files: { 'supplements.json': bytePin(rb), 'request.json': bytePin(request) },
    producer: { ...Object.fromEntries(Object.entries(library).map(([n, p]) => [path.posix.basename(n), p.sha256])), 'translation-workbench.mjs': bytePin(workbench).sha256 } };
  const smb = bytes(sm), sz = zip({ 'supplements.json': rb, 'request.json': request, 'manifest.json': smb }); set('handoff/reviewed/runtime.zip', sz);
  const langFiles = {};
  for (const [locale, names] of Object.entries({ 'zh-CN': ['_meta', 'base_items', 'classes', 'display_texts', 'mods', 'passive_names', 'rare_words', 'skills', 'stat_lines', 'words'], 'zh-TW': ['base_items', 'mods', 'skills'] })) {
    for (const n of names) { const b = bytes({ synthetic: `${locale}/${n}` }); const p = `i18n/${locale}/${n}.json`; langFiles[p] = bytePin(b); set(`handoff/language/${p}`, b); }
  }
  for (const n of ['locale-decision.json', 'native-140-pairs.json', 'zh-CN-original-meta.json', 'zh-CN-original-stat-lines.json', 'zh-TW-receipt.json']) {
    const b = bytes({ synthetic: n }); langFiles[`evidence/${n}`] = bytePin(b); set(`handoff/language/evidence/${n}`, b);
  }
  const supportAsset = bytes({ synthetic: 'retained support' }); set('handoff/support/supportDescriptions.zh-CN.json', supportAsset);
  const supportManifest = { schema: 'poe2-support-display-publication/v1', target: { game: target.game, version: target.game_patch, realm: target.realm }, locale: 'zh-CN',
    catalog_sha256: 'b'.repeat(64), files: { 'supportDescriptions.zh-CN.json': bytePin(supportAsset) },
    provenance: { generation_data_version: '0.5.5.4.2', source_commit: 'c'.repeat(40) } };
  set('handoff/support/manifest.json', supportManifest);
  const identity = { dictionary: { repository: 'https://github.com/fixture/dictionary', commit: 'd'.repeat(40) },
    translation: { repository: 'https://github.com/fixture/translation', commit: 'e'.repeat(40), snapshot: '20261101T000000Z', mode: 'pinned', sha256: bytePin(bytes({})).sha256 } };
  const gm = { schema: 'poe2-locale-generation-input/v1', profile: 'retained-selected', target, identity,
    inputs: { 'templates.json': { ...bytePin(bytes({})), source: { url: `https://raw.githubusercontent.com/fixture/translation/${identity.translation.commit}/templates.json` } } },
    expected_files: { ...Object.fromEntries(Object.entries(langFiles).filter(([n]) => n.startsWith('i18n/zh-CN/') && !n.endsWith('/display_texts.json'))), 'generated/translation-audit.json': bytePin(bytes({})) } };
  for (const n of ['lookup/stat_lines.json', 'lookup/en_to_cn.json', 'tables/BaseItemTypes.json', 'tables/ActiveSkills.json', 'tables/Characters.json', 'tables/Ascendancy.json', 'tables/Words.json', 'tables/PassiveSkills.json', 'tables/Mods.json', 'meta.json']) {
    gm.inputs[`dictionary/${n}`] = { ...bytePin(bytes({})), source: { url: `https://raw.githubusercontent.com/fixture/dictionary/${identity.dictionary.commit}/${n}` } };
  }
  for (const n of ['native-140-pairs.json', 'selected-literals.json', 'zh-CN-layered-meta.json', 'zh-CN-original-meta.json']) {
    const p = `handoff/generation/${n}`, b = bytes({ synthetic: n }); set(p, b);
    gm.inputs[`evidence/${n}`] = { ...bytePin(b), source: { repository: `https://github.com/${OWNER}`, revision: 'producer-commit', path: p } };
  }
  set('handoff/generation/input-manifest.json', gm);
  const a = commit('synthetic published components');
  const archive = (name, b, mb, members) => ({ repository: OWNER, revision: a, path: name, ...bytePin(b), manifest: bytePin(mb), expanded_bytes: members.reduce((n, v) => n + v.length, 0) });
  const supplement = archive('handoff/reviewed/runtime.zip', sz, smb, [rb, request, smb]);
  const lm = { schema: 'poe2-retained-locale-publication/v1', target, observed_sc_client: { patch: null, realm: null },
    catalog_sha256: cm.files['catalog.json'].sha256, reviewed_supplement: { revision: a, path: supplement.path, bytes: supplement.bytes, sha256: supplement.sha256, records: 0 }, files: langFiles };
  set('handoff/language/manifest.json', lm); const b = commit('synthetic retained manifest');
  const build = { schema: 'pobr-build-data-lock/v2', target, packages: { language: { format: 'locale-git-files', publication: 'published', repository: OWNER,
    revision: b, path: 'handoff/language/manifest.json', manifest: bytePin(bytes(lm)) } },
    support_display: { publication: 'published', repository: OWNER, revision: a, path: 'handoff/support/manifest.json', manifest: bytePin(bytes(supportManifest)),
      asset: bytePin(supportAsset), catalog_sha256: supportManifest.catalog_sha256, source_data_version: '0.5.5.4.2' } };
  const imports = { schema: 'pobr-data-import-lock/v1', target, packages: { repoe: source,
    translation: archive('handoff/catalog/catalog.zip', cz, cmb, [...Object.values(catalogFiles), cmb]), supplement },
    library: { repository: OWNER, revision: a, files: library }, workbench: { repository: OWNER, revision: a, file: 'src/translation-workbench.mjs', ...bytePin(workbench) } };
  const generation = { schema: 'pobr-locale-generation-lock/v1', target, repository: OWNER, revision: a,
    producer: { entrypoint: 'src/locale-producer.mjs', files: producers }, input_manifest: { path: 'handoff/generation/input-manifest.json', ...bytePin(bytes(gm)) } };
  const locks = { repo, buildLock: bytes(build), importsLock: bytes(imports), localeGenerationLock: bytes(generation) };
  const publish = (d, raw = bytes(d)) => { set(descriptorPath(d.sequence), raw); return { revision: commit('synthetic publication'), path: descriptorPath(d.sequence), ...bytePin(raw) }; };
  return { repo, files, set, commit, locks, build, imports, generation, publish, gm, lm };
}

test('complete synthetic bootstrap preserves all seven inputs, source metadata and honest scopes', async () => {
  const f = await fixture(), d = await bootstrapPublication(f.locks);
  assert.deepEqual(Object.keys(d.components), ROLES); assert.deepEqual(d.scope, SCOPE);
  assert.deepEqual(d.components.language.input, f.build.packages.language);
  assert.deepEqual(d.components.support_display.input, f.build.support_display);
  assert.deepEqual(d.components.locale_generation.input, f.generation);
  assert.deepEqual(d.bindings.display_source, source);
  const head = f.publish(d); assert.equal((await registerPublication({ repo: f.repo, head })).changed, true);
  const raw = await readFile(path.join(f.repo, 'publication/index.json'));
  assert.equal((await checkPublication({ repo: f.repo })).index.sequence, 1);
  assert.equal((await registerPublication({ repo: f.repo, head })).changed, false);
  assert.deepEqual(await readFile(path.join(f.repo, 'publication/index.json')), raw);
});

test('same-patch new language advances only that role and uses exact predecessor', async () => {
  const f = await fixture(), first = await bootstrapPublication(f.locks), old = f.publish(first);
  await registerPublication({ repo: f.repo, head: old });
  const next = structuredClone(first); next.sequence = 2; next.previous = old;
  const mb = Buffer.concat([bytes(f.lm), Buffer.from('\n')]); f.set('handoff/language/manifest.json', mb);
  next.components.language = { sequence: 2, input: { ...first.components.language.input, revision: f.commit('new same-patch language'), manifest: bytePin(mb) } };
  const head = f.publish(next); await registerPublication({ repo: f.repo, head });
  const result = await checkPublication({ repo: f.repo }); assert.equal(result.index.sequence, 2);
  assert.equal(result.descriptor.components.language.sequence, 2);
  for (const r of ROLES.filter(r => r !== 'language')) assert.deepEqual(result.descriptor.components[r], first.components[r]);
  await assert.rejects(registerPublication({ repo: f.repo, head: old }), /sequence|predecessor/u);
});

test('same-patch source-binding-only publication preserves every unchanged role frontier', async () => {
  const f = await fixture(), first = await bootstrapPublication(f.locks), old = f.publish(first);
  await registerPublication({ repo: f.repo, head: old });
  const next = structuredClone(first); next.sequence = 2; next.previous = old;
  next.bindings.display_source.revision = 'e'.repeat(40);
  const head = f.publish(next);
  await registerPublication({ repo: f.repo, head });
  const actual = await checkPublication({ repo: f.repo });
  assert.equal(actual.index.sequence, 2);
  assert.deepEqual(actual.descriptor.components, first.components);
  assert.deepEqual(actual.descriptor.bindings, next.bindings);
  assert.deepEqual(actual.descriptor.evidence, first.evidence);
  const before = await readFile(path.join(f.repo, 'publication/index.json'));
  const bad = structuredClone(next); bad.sequence = 3; bad.previous = head;
  bad.bindings.display_source.manifest.sha256 = 'a'.repeat(64);
  await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(bad) }), /source-catalog/u);
  assert.deepEqual(await readFile(path.join(f.repo, 'publication/index.json')), before);
});

test('empty publication advancement keeps the existing index and no success residue', async () => {
  const f = await fixture(), first = await bootstrapPublication(f.locks), old = f.publish(first);
  await registerPublication({ repo: f.repo, head: old });
  const before = await readFile(path.join(f.repo, 'publication/index.json'));
  const next = structuredClone(first); next.sequence = 2; next.previous = old;
  await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(next) }), /no changed role input/u);
  assert.deepEqual(await readFile(path.join(f.repo, 'publication/index.json')), before);
  assert.deepEqual(await readdir(path.join(f.repo, 'publication')), ['index.json']);
});

test('fixed publication revisions ignore local replacement refs', async () => {
  const f = await fixture(), descriptor = await bootstrapPublication(f.locks), head = f.publish(descriptor);
  await registerPublication({ repo: f.repo, head });
  const replacement = f.publish({ ...descriptor, owner: 'synthetic/replacement' });
  execFileSync('git', ['-C', f.repo, 'replace', head.revision, replacement.revision]);
  const checked = await checkPublication({ repo: f.repo });
  assert.deepEqual(checked.descriptor, descriptor);
  assert.deepEqual(checked.index.head, head);
});

test('missing local metadata fails without lazy-fetching from a promisor remote', async () => {
  const f = await fixture(), descriptor = await bootstrapPublication(f.locks), head = f.publish(descriptor);
  await registerPublication({ repo: f.repo, head });
  const git = args => execFileSync('git', ['-C', f.repo, ...args], { encoding: 'utf8' }).trim();
  git(['update-ref', 'refs/heads/synthetic', head.revision]);
  git(['symbolic-ref', 'HEAD', 'refs/heads/synthetic']);
  const remote = `${f.repo}-promisor.git`;
  execFileSync('git', ['clone', '--mirror', '--no-hardlinks', f.repo, remote], { stdio: 'pipe' });
  const validation = descriptor.evidence.catalog_validation;
  const oid = git(['rev-parse', `${validation.revision}:${validation.path}`]);
  execFileSync('git', ['-C', remote, 'cat-file', '-e', oid]);
  git(['config', 'core.repositoryFormatVersion', '1']);
  git(['config', 'extensions.partialClone', 'origin']);
  git(['config', 'remote.origin.url', remote]);
  git(['config', 'remote.origin.promisor', 'true']);
  git(['config', 'remote.origin.partialCloneFilter', 'blob:none']);
  git(['config', 'protocol.file.allow', 'always']);
  await unlink(path.join(f.repo, 'objects', oid.slice(0, 2), oid.slice(2)));
  await assert.rejects(checkPublication({ repo: f.repo }), /Git|git|object|missing|non-regular/u);
  assert.notEqual(spawnSync('git', ['--no-lazy-fetch', '-C', f.repo, 'cat-file', '-e', oid]).status, 0,
    'the absent local object must remain absent; only synthetic local Git was available');
});

test('bad declarations fail closed without an index or a leftover success marker', async t => {
  const f = await fixture(), good = await bootstrapPublication(f.locks);
  const cases = [
    ['missing support', d => { delete d.components.support_display; }, /components/u],
    ['missing locale generator', d => { delete d.components.locale_generation; }, /components/u],
    ['extra role', d => { d.components.unknown = d.components.language; }, /components/u],
    ['bad full revision', d => { d.components.language.input.revision = 'main'; }, /revision/u],
    ['bad digest', d => { d.components.language.input.manifest.sha256 = 'A'.repeat(64); }, /pin/u],
    ['wrong manifest bytes', d => { d.components.language.input.manifest.bytes++; }, /pin mismatch/u],
    ['unpublished', d => { d.components.language.input.publication = 'local-only'; }, /unpublished/u],
    ['unsafe path', d => { d.components.language.input.path = '../escape.json'; }, /path/u],
    ['unknown artifact', d => { d.components.workbench.input.revision = 'a'.repeat(40); }, /Git|git|object/u],
    ['wrong source binding', d => { d.bindings.display_source.manifest.sha256 = 'a'.repeat(64); }, /source-catalog/u],
    ['wrong library binding', d => { d.components.display_library.input.files['src/native-catalog.mjs'].sha256 = 'a'.repeat(64); }, /library/u],
    ['wrong owner', d => { d.owner = 'another/owner'; }, /owner/u],
    ['wrong realm', d => { d.target.realm = 'global'; }, /target/u],
    ['wrong patch', d => { d.target.game_patch = '9.9'; d.components.locale_generation.input.target.game_patch = '9.9'; }, /target/u],
    ['missing predecessor', d => { d.sequence = 2; d.previous = null; }, /previous/u],
    ['invalid complete scope', d => { d.scope.official_client_certified = true; }, /scope/u],
  ];
  for (const [name, change, error] of cases) await t.test(name, async () => {
    const d = structuredClone(good); change(d);
    await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(d) }), error);
    await assert.rejects(readFile(path.join(f.repo, 'publication/index.json')), /ENOENT/u);
    assert.deepEqual(await readdir(path.join(f.repo, 'publication')), []);
  });
});

test('role rollback, same-sequence mutation, skipped/missing/wrong predecessor leave old index byte-identical', async t => {
  const f = await fixture(), first = await bootstrapPublication(f.locks), old = f.publish(first);
  await registerPublication({ repo: f.repo, head: old }); const before = await readFile(path.join(f.repo, 'publication/index.json'));
  f.set('synthetic-new-input.txt', Buffer.from('next')); const revision = f.commit('same workbench bytes, new input declaration');
  const next = structuredClone(first); next.sequence = 2; next.previous = old;
  next.components.workbench.sequence = 2; next.components.workbench.input.revision = revision;
  const cases = [
    ['role rollback', d => { d.components.workbench.sequence = 1; }, /role sequence/u],
    ['unchanged role advances', d => { d.components.language.sequence = 2; }, /role sequence/u],
    ['skip global sequence', d => { d.sequence = 3; }, /sequence/u],
    ['same-sequence content', d => { d.sequence = 1; d.previous = null; d.components.workbench.sequence = 1; }, /same publication sequence/u],
    ['missing predecessor object', d => { d.previous.revision = 'a'.repeat(40); }, /git|Git|object/u],
    ['bad predecessor pin', d => { d.previous.sha256 = 'a'.repeat(64); }, /pin mismatch/u],
  ];
  for (const [name, change, error] of cases) await t.test(name, async () => {
    const d = structuredClone(next); change(d);
    await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(d) }), error);
    assert.deepEqual(await readFile(path.join(f.repo, 'publication/index.json')), before);
  });
  await registerPublication({ repo: f.repo, head: f.publish(next) });
  const fork = structuredClone(next); fork.components.workbench.input.revision = old.revision;
  // Commit containing the original script is available, but cannot reuse sequence 2 with a different head.
  await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(fork) }), /same publication sequence/u);
});

test('strict JSON, descriptor/index head pins, immutable Git symlinks and filesystem symlinks reject', async t => {
  const f = await fixture(), good = await bootstrapPublication(f.locks), head = f.publish(good);
  assert.throws(() => validateDescriptor(Buffer.from(bytes(good).toString().replace('"sequence": 1', '"sequence": 1, "sequenc\\u0065": 1'))), /Duplicate/u);
  await assert.rejects(registerPublication({ repo: f.repo, head: { ...head, bytes: head.bytes + 1 } }), /pin mismatch/u);
  f.files.set('handoff/language/link.json', { mode: '120000', bytes: Buffer.from('manifest.json') });
  const d = structuredClone(good); d.components.language.input.path = 'handoff/language/link.json'; d.components.language.input.revision = f.commit('symlink fixture');
  await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(d) }), /non-regular/u);
  await symlink('elsewhere.json', path.join(f.repo, 'publication/index.json'));
  await assert.rejects(registerPublication({ repo: f.repo, head }), /symlink/u);
  const ancestor = path.join(f.repo, 'alias'); await symlink('publication', ancestor);
  await assert.rejects(registerPublication({ repo: f.repo, head, indexPath: 'alias/index.json' }), /symlink/u);
  const index = { schema: 'owned-data-publication-index/v2', channel: { game: 'poe2', realm: 'international' }, sequence: 1, head };
  assert.throws(() => validateIndex(bytes({ ...index, head: { ...head, path: '/absolute.json' } })), /path/u);
  assert.throws(() => validateIndex(Buffer.from(bytes(index).toString().replace('"sequence": 1', '"sequence": 1, "sequence": 2'))), /Duplicate/u);
  await t.test('exclusive writer rejects before publishing', async () => {
    const another = await fixture(), d = await bootstrapPublication(another.locks);
    await writeFile(path.join(another.repo, 'publication/index.json.lock'), 'other writer');
    await assert.rejects(registerPublication({ repo: another.repo, head: another.publish(d) }), /writer lock/u);
    await assert.rejects(readFile(path.join(another.repo, 'publication/index.json')), /ENOENT/u);
  });
});

test('bootstrap rejects mismatched consumer targets, absent roles and duplicate lock keys', async () => {
  const f = await fixture();
  await assert.rejects(bootstrapPublication({ ...f.locks, importsLock: bytes({ ...f.imports, target: { ...target, realm: 'global' } }) }), /targets/u);
  const b = structuredClone(f.build); delete b.support_display;
  await assert.rejects(bootstrapPublication({ ...f.locks, buildLock: bytes(b) }), /support_display/u);
  await assert.rejects(bootstrapPublication({ ...f.locks, buildLock: Buffer.from('{"schema":1,"schema":2}') }), /Duplicate/u);
});

test('repinning damaged small metadata cannot turn an incomplete declaration into a publication', async t => {
  const f = await fixture(), good = await bootstrapPublication(f.locks);
  for (const [name, change, expected] of [
    ['missing dictionary input', m => { delete m.inputs['dictionary/meta.json']; }, /input inventory/u],
    ['mutable source URL', m => { m.inputs['dictionary/meta.json'].source.url = 'https://raw.githubusercontent.com/fixture/dictionary/main/meta.json'; }, /source URL/u],
    ['wrong generation output', m => { m.expected_files['i18n/zh-CN/stat_lines.json'].sha256 = 'a'.repeat(64); }, /output binding/u],
    ['bad producer evidence bytes', m => { m.inputs['evidence/selected-literals.json'].sha256 = 'a'.repeat(64); }, /pin mismatch/u],
  ]) await t.test(name, async () => {
    const gm = structuredClone(f.gm); change(gm); const raw = bytes(gm);
    f.set('handoff/generation/input-manifest.json', raw);
    const d = structuredClone(good); d.components.locale_generation.input.revision = f.commit('damaged generation metadata');
    Object.assign(d.components.locale_generation.input.input_manifest, bytePin(raw));
    await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(d) }), expected);
    await assert.rejects(readFile(path.join(f.repo, 'publication/index.json')), /ENOENT/u);
  });
  for (const [name, change, expected] of [
    ['inferred observed client', m => { m.observed_sc_client.patch = target.game_patch; }, /observed client/u],
    ['invented reviewed record', m => { m.reviewed_supplement.records = 1; }, /supplement binding/u],
    ['missing independent TW evidence', m => { delete m.files['evidence/zh-TW-receipt.json']; }, /retained source evidence/u],
  ]) await t.test(name, async () => {
    const lm = structuredClone(f.lm); change(lm); const raw = bytes(lm); f.set('handoff/language/manifest.json', raw);
    const d = structuredClone(good); d.components.language.input.revision = f.commit('damaged retained metadata');
    d.components.language.input.manifest = bytePin(raw);
    await assert.rejects(registerPublication({ repo: f.repo, head: f.publish(d) }), expected);
    await assert.rejects(readFile(path.join(f.repo, 'publication/index.json')), /ENOENT/u);
  });
});

test('bootstrap CLI rejects symlink locks and replays bootstrap/register/check without overwriting', async () => {
  const f = await fixture(), build = path.join(f.repo, 'build.json'), alias = path.join(f.repo, 'alias.json');
  await writeFile(build, f.locks.buildLock); await symlink('build.json', alias);
  const result = spawnSync(process.execPath, [new URL('../src/publication-index.mjs', import.meta.url).pathname,
    'bootstrap', '--repo', f.repo, '--build-lock', alias, '--imports-lock', build, '--locale-generation-lock', build,
    '--out', descriptorPath(1)], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /symlink/u);
  await assert.rejects(readFile(path.join(f.repo, descriptorPath(1))), /ENOENT/u);
  const imports = path.join(f.repo, 'imports.json'), generation = path.join(f.repo, 'generation.json');
  await writeFile(imports, f.locks.importsLock); await writeFile(generation, f.locks.localeGenerationLock);
  await mkdir(path.join(f.repo, path.dirname(descriptorPath(1))), { recursive: true });
  const cli = args => spawnSync(process.execPath, [new URL('../src/publication-index.mjs', import.meta.url).pathname, ...args], { encoding: 'utf8' });
  const args = ['bootstrap', '--repo', f.repo, '--build-lock', build, '--imports-lock', imports, '--locale-generation-lock', generation, '--out', descriptorPath(1)];
  assert.equal(cli(args).status, 0);
  const raw = await readFile(path.join(f.repo, descriptorPath(1))), d = validateDescriptor(raw);
  assert.equal(cli(args).status, 1); assert.deepEqual(await readFile(path.join(f.repo, descriptorPath(1))), raw);
  const head = f.publish(d, raw), registered = cli(['register', '--repo', f.repo, '--revision', head.revision, '--path', head.path, '--bytes', String(head.bytes), '--sha256', head.sha256]);
  assert.equal(registered.status, 0); assert.equal(JSON.parse(registered.stdout).status, 'registered');
  const checked = cli(['check', '--repo', f.repo]); assert.equal(checked.status, 0);
  assert.equal(JSON.parse(checked.stdout).status, 'valid-declarations');
});
