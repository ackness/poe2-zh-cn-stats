import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { strictJson } from '../src/strict-json.mjs';
import { buildNativeLocalization, canonical, generateNativeLocalization, nativeBytes, readNativeDescriptions } from '../src/native-localization.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('fixtures/native-descriptions/', import.meta.url));
const dag = fileURLToPath(new URL('fixtures/native-descriptions-dag/', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const pin = async directory => sha(await readFile(path.join(directory, 'manifest.json')));
const read = async () => readNativeDescriptions(fixture, await pin(fixture));
async function ownFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-locale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'input');
  await cp(fixture, target, { recursive: true });
  return target;
}
async function mutateDocument(directory, mutate) {
  const data = JSON.parse(await readFile(path.join(directory, 'descriptions.json')));
  mutate(data);
  await reseal(directory, 'descriptions.json', nativeBytes(data));
}
async function reseal(directory, name, bytes) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
  await writeFile(path.join(directory, name), bytes);
  manifest.files[name] = { bytes: bytes.length, sha256: sha(bytes) };
  await writeFile(path.join(directory, 'manifest.json'), nativeBytes(manifest));
}
const descriptions = source => Object.values(source.files).flatMap(file => file.records.filter(r => r.kind === 'description'));

test('strict JSON rejects escaped duplicates at every depth and unsafe input encodings', () => {
  for (const text of ['{"x":1,"\\u0078":2}', '[{"a":{"b":1,"b":2}}]', '{"x":NaN}', '{"x":1e999}',
    '{"x":9007199254740993}', '{"x":"\\ud800"}', '{"\\ud800":1}', '{"x":1} trailing']) {
    assert.throws(() => strictJson(Buffer.from(text)), undefined, text);
  }
  assert.throws(() => strictJson(Buffer.from([0xff, 0xfe])));
  assert.throws(() => strictJson(Buffer.from('['.repeat(65) + '0' + ']'.repeat(65))), /depth/u);
  assert.deepEqual(strictJson(Buffer.from('{"text":"a\\\"b","nested":[null,true,-2,0.5]}')),
    { text: 'a"b', nested: [null, true, -2, 0.5] });
});

test('synthetic upstream facts bind their complete raw inputs', async () => {
  for (const name of ['native-descriptions', 'native-descriptions-dag']) {
    const source = JSON.parse(await readFile(new URL(`fixtures/${name}-source.json`, import.meta.url)));
    const manifest = JSON.parse(await readFile(new URL(`fixtures/${name}/manifest.json`, import.meta.url)));
    assert.equal(source.producer_commit, '3e1e488ff2763acb692387f4d8fbb69019985cf2');
    assert.deepEqual(Object.keys(source.raw_files_base64).sort(), Object.keys(manifest.source_identity.raw_resources).sort());
    for (const [file, encoded] of Object.entries(source.raw_files_base64)) {
      const bytes = Buffer.from(encoded, 'base64');
      assert.deepEqual(manifest.source_identity.raw_resources[file], { bytes: bytes.length, sha256: sha(bytes) });
    }
  }
});

test('native pairs retain IDs, contexts, conditions, restrictions, slot reordering and provenance', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected fetch'); });
  const verified = await read();
  const before = canonical(verified.document);
  const result = buildNativeLocalization(verified);
  assert.equal(result.format, 'poe2-native-localization-candidate/v1');
  assert.equal(result.production_ready, false);
  assert.equal(result.pairs.length, 5);
  const fires = result.pairs.filter(row => row.stat_ids.length === 1 && row.stat_ids[0] === 'fire_resistance');
  assert.equal(fires.length, 2);
  assert.notEqual(fires[0].file, fires[1].file);
  assert.ok(fires.some(row => row.chinese_template_raw === '[Resistances|火焰抗性] {0:+d}%'));
  const multi = result.pairs.find(row => row.stat_ids.length === 2);
  assert.deepEqual(multi.stat_ids, ['first', 'second']);
  assert.deepEqual(multi.restrictions_raw, ['table_only']);
  assert.equal(multi.default_template_raw, 'Adds {0:d} to {1:d} damage every 2 seconds');
  assert.equal(multi.chinese_template_raw, '每 2 秒附加 {1:d} 至 {0:d} 伤害');
  assert.deepEqual(multi.conditions_raw, ['#', '#']);
  assert.deepEqual(multi.placeholders.chinese.map(p => p.index_token_raw), ['1', '0']);
  const sameEnglish = result.pairs.filter(row => row.default_template_raw === 'Same {0} template');
  assert.equal(sameEnglish.length, 2);
  assert.notDeepEqual(sameEnglish[0].stat_ids, sameEnglish[1].stat_ids);
  assert.notEqual(sameEnglish[0].chinese_template_raw, sameEnglish[1].chinese_template_raw);
  assert.equal(result.input.manifest_sha256, await pin(fixture));
  assert.equal(result.input.source_identity.game_patch, 'synthetic-test');
  assert.equal(result.input.source_identity.realm, 'international');
  assert.equal(result.policy.trade_id_mapping, 'none');
  assert.equal(canonical(verified.document), before);
});

test('ambiguous, missing, malformed, number, sign and handler cases remain exclusions', async () => {
  const verified = await read();
  const result = buildNativeLocalization(verified);
  const reasons = new Set(result.excluded.map(row => row.reason));
  for (const expected of ['nonunique-branch-signature', 'missing-simplified-chinese-group', 'unmatched-branch-signature',
    'literal-number-mismatch', 'unresolved-template-syntax', 'no-han-in-declared-chinese']) assert.ok(reasons.has(expected), expected);
  const rejected = new Set(result.excluded.flatMap(row => row.stat_ids));
  for (const id of ['duplicate', 'no_chinese', 'quality', 'literal', 'syntax', 'sign', 'handler', 'not_han']) {
    assert.ok(rejected.has(id), id);
    assert.ok(!result.pairs.some(row => row.stat_ids.includes(id)), id);
  }
  assert.deepEqual(result.source_diagnostics, verified.diagnostics);
  assert.equal(result.source_diagnostics.length, 2);
});

test('all payload hashes and inventory are checked before facts are consumed', async t => {
  for (const name of ['descriptions.json', 'diagnostics.json', 'source-lock.json']) {
    const directory = await ownFixture(t);
    await writeFile(path.join(directory, name), Buffer.from('changed'));
    await assert.rejects(readNativeDescriptions(directory, await pin(directory)), /identity mismatch/u);
  }
  const directory = await ownFixture(t);
  await assert.rejects(readNativeDescriptions(directory, '0'.repeat(64)), /external pin/u);
  await assert.rejects(readNativeDescriptions(directory, null), /External/u);
  await mkdir(path.join(directory, 'extra'));
  await assert.rejects(readNativeDescriptions(directory, await pin(directory)), /inventory/u);
});

test('symlinks and duplicate-key resealed JSON do not bypass package validation', async t => {
  const directory = await ownFixture(t);
  await rm(path.join(directory, 'descriptions.json'));
  await symlink(path.join(fixture, 'descriptions.json'), path.join(directory, 'descriptions.json'));
  await assert.rejects(readNativeDescriptions(directory, await pin(directory)), /inventory/u);
  const duplicate = await ownFixture(t);
  const bytes = await readFile(path.join(duplicate, 'descriptions.json'));
  await reseal(duplicate, 'descriptions.json', Buffer.from(bytes.toString().replace('{', '{"format":"ignored",')));
  await assert.rejects(readNativeDescriptions(duplicate, await pin(duplicate)), /Duplicate/u);
});

test('resealed malformed branch, language, span and source evidence is rejected', async t => {
  const mutations = [
    doc => { descriptions(doc)[0].groups[0].branches[0].placeholders[0].index_token_raw = '9'; },
    doc => { descriptions(doc)[0].groups[0].branches[0].quantifier_tokens_raw = ['invented', '1']; },
    doc => { descriptions(doc)[0].groups[0].branches[0].span.byte_start++; },
    doc => { descriptions(doc)[0].groups[0].declared_branch_count++; },
    doc => { descriptions(doc)[0].groups[0].language_origin = 'explicit-lang'; },
    doc => { descriptions(doc)[0].groups[0].new_required_policy = true; },
    doc => { delete Object.values(doc.files)[0].stat_index.fire_resistance; },
    doc => { descriptions(doc)[0].ids = []; },
  ];
  for (const mutate of mutations) {
    const directory = await ownFixture(t);
    await mutateDocument(directory, mutate);
    await assert.rejects(readNativeDescriptions(directory, await pin(directory)));
  }
  const directory = await ownFixture(t);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
  manifest.source_identity.game_patch = 'changed';
  await writeFile(path.join(directory, 'manifest.json'), nativeBytes(manifest));
  await assert.rejects(readNativeDescriptions(directory, await pin(directory)), /selected-source mismatch/u);
});

test('diagnostic references and language summary remain bound to actual branches', async t => {
  const directory = await ownFixture(t);
  const diagnostics = JSON.parse(await readFile(path.join(directory, 'diagnostics.json')));
  diagnostics.diagnostics[0].record++;
  await reseal(directory, 'diagnostics.json', nativeBytes(diagnostics));
  await assert.rejects(readNativeDescriptions(directory, await pin(directory)), /diagnostic reference/u);
  const wrongSummary = await ownFixture(t);
  const manifest = JSON.parse(await readFile(path.join(wrongSummary, 'manifest.json')));
  manifest.summary.explicit_languages = ['English'];
  await writeFile(path.join(wrongSummary, 'manifest.json'), nativeBytes(manifest));
  await assert.rejects(readNativeDescriptions(wrongSummary, await pin(wrongSummary)), /language\/handler summary/u);
});

test('repeated includes validate as a graph and retain all literal occurrences', async t => {
  const verified = await readNativeDescriptions(dag, await pin(dag));
  assert.equal(Object.keys(verified.document.files).length, 17);
  assert.equal(verified.document.files[verified.document.roots[0]].records.length, 8);
  assert.equal(buildNativeLocalization(verified).summary.descriptions, 0);
  const cycle = await ownFixture(t);
  await mutateDocument(cycle, doc => {
    const root = doc.files[doc.roots[0]];
    const include = root.records.find(record => record.kind === 'include');
    include.target = doc.roots[0];
    include.literal_target = doc.roots[0];
    include.line_raw = `include "${doc.roots[0]}"`;
  });
  await assert.rejects(readNativeDescriptions(cycle, await pin(cycle)), /cyclic/u);
});

test('fresh CLI processes replay exactly and never change current/manual inputs', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const watched = ['data/CURRENT', 'translations.json', 'overrides.json', 'curated.json'];
  const before = new Map(await Promise.all(watched.map(async name => [name, await readFile(path.join(root, name))])));
  const args = ['src/cli.mjs', 'native', '--facts', fixture, '--expected-manifest-sha256', await pin(fixture)];
  const one = execFileSync(process.execPath, args, { cwd: root });
  const two = execFileSync(process.execPath, args, { cwd: root });
  assert.deepEqual(one, two);
  const value = JSON.parse(one);
  assert.equal(value.consumer.node_version, process.versions.node);
  assert.ok(Object.hasOwn(value.consumer.files, 'src/native-localization.mjs'));
  const candidate = path.join(directory, 'candidate.json');
  await writeFile(candidate, one);
  const check = ['src/cli.mjs', 'native-check', '--facts', fixture, '--expected-manifest-sha256', await pin(fixture), '--candidate', candidate];
  assert.match(execFileSync(process.execPath, check, { cwd: root }).toString(), /verified/u);
  await writeFile(candidate, Buffer.from('changed'));
  assert.throws(() => execFileSync(process.execPath, check, { cwd: root, stdio: 'pipe' }));
  for (const [name, bytes] of before) assert.deepEqual(await readFile(path.join(root, name)), bytes);
});

test('generation preserves compiler fingerprint and input package bytes', async () => {
  const before = await readFile(path.join(fixture, 'descriptions.json'));
  const result = await generateNativeLocalization(fixture, await pin(fixture));
  assert.deepEqual(await readFile(path.join(fixture, 'descriptions.json')), before);
  for (const [name, digest] of Object.entries(result.consumer.files)) assert.equal(sha(await readFile(path.join(root, name))), digest);
});

test('canonical JSON and producer metadata cannot generate undefined output', async t => {
  for (const value of [undefined, { producer: undefined }, [undefined], Number.NaN, Infinity]) {
    assert.throws(() => nativeBytes(value), /Unsupported canonical JSON value/u);
  }
  for (const producer of [undefined, {}, { 'producer.py': 'invalid' }]) {
    const directory = await ownFixture(t);
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json')));
    if (producer === undefined) delete manifest.producer; else manifest.producer = producer;
    await writeFile(path.join(directory, 'manifest.json'), nativeBytes(manifest));
    await assert.rejects(generateNativeLocalization(directory, await pin(directory)), /producer metadata/u);
  }
});

test('mathematical minus remains part of literal and placeholder sign signatures', async () => {
  const verified = await read();
  const description = descriptions(verified.document).find(record => record.ids.includes('sign'));
  assert.ok(description);
  const defaults = description.groups.find(group => group.declared_language === null);
  const chinese = description.groups.find(group => group.declared_language === 'Simplified Chinese');
  for (const group of [defaults, chinese]) assert.ok(group);
  const template = (branch, text, token = '{0}') => {
    branch.template_raw = text;
    branch.placeholders = token ? [{ token_raw: token, index_token_raw: '0', format_raw: '', syntax_status: 'recognized-lexical',
      template_character_span: [text.indexOf(token), text.indexOf(token) + token.length] }] : [];
    branch.template_syntax_diagnostics = [];
  };
  for (const [left, right, token] of [['−{0} Life', '生命 {0}', '{0}'], ['−5 Life', '生命 5', null]]) {
    template(defaults.branches[0], left, token); template(chinese.branches[0], right, token);
    const result = buildNativeLocalization(verified);
    assert.ok(!result.pairs.some(row => row.stat_ids.includes('sign')));
  }
  template(defaults.branches[0], '−{0} Life'); template(chinese.branches[0], '生命 −{0}');
  assert.ok(buildNativeLocalization(verified).pairs.some(row => row.stat_ids.includes('sign')));
});

test('native-check rejects a FIFO candidate promptly without waiting for a writer', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-fifo-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fifo = path.join(directory, 'candidate');
  execFileSync('mkfifo', [fifo]);
  const args = ['src/cli.mjs', 'native-check', '--facts', fixture, '--expected-manifest-sha256', await pin(fixture), '--candidate', fifo];
  assert.throws(() => execFileSync(process.execPath, args, { cwd: root, timeout: 2000, stdio: 'pipe' }), error => {
    assert.notEqual(error.code, 'ETIMEDOUT');
    assert.equal(error.status, 1);
    assert.match(error.stderr.toString(), /bounded regular file/u);
    return true;
  });
});
