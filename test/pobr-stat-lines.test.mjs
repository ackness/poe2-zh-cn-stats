import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStatLines, parseStatLineArgs } from '../src/pobr-stat-lines.mjs';

const digest = raw => createHash('sha256').update(raw).digest('hex');

function inputs(t) {
  const cache = fileURLToPath(new URL('../.cache/', import.meta.url));
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'stat-lines-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const file = 'Data/StatDescriptions/stat_descriptions.csd';
  const candidate = { format: 'poe2-native-localization-candidate/v1', pairs: [{
    default_reference: { file, record: 2, branch: 0 }, chinese_reference: { file, record: 2, group: 1, branch: 0 },
    default_template_raw: '+{0} to [Armour]', chinese_template_raw: '+{0} 点[Armour|护甲]',
    declared_chinese_language: 'Simplified Chinese', stat_ids: ['test_armour'],
    restrictions_raw: [], quantifier_tokens_raw: [] }],
    input: { manifest_sha256: 'a'.repeat(64), source_identity: { game_patch: 'test' } } };
  const selection = { format: 'pobr-ordinary-facts-receipt/v1',
    adapter: { output_schema: 'pobr_data::catalog::item_overlay::RunesDef' }, target: { version: 'test' },
    conversion: { descriptions: { manifest_sha256: 'a'.repeat(64) }, records: [{
      id: 'rune', mode: 'target-csd', selected_descriptions: [{ source_row: 3, packet: 'normal', prefix: '',
        evidence: [{ pointer: '/files/Data~1StatDescriptions~1stat_descriptions.csd/records/2',
          ids: ['test_armour'], values: [12], branch: 0, handlers: [] }] }] }] } };
  const legacy = [{ src: '旧', en: 'Old' }];
  const options = { out: path.join(root, 'out') };
  for (const [name, value] of [['selection', selection], ['native', candidate], ['legacy', legacy]]) {
    const raw = JSON.stringify(value);
    options[name] = path.join(root, `${name}.json`);
    options[`${name}-sha256`] = digest(raw);
    fs.writeFileSync(options[name], raw);
  }
  return { root, options };
}

test('writes the appended pairs and a receipt into a fresh cache candidate', t => {
  const { options } = inputs(t);
  const receipt = createStatLines(options);
  const raw = fs.readFileSync(path.join(options.out, 'stat_lines.json'));
  assert.deepEqual(JSON.parse(raw), [{ src: '+12 点护甲', en: '+12 to Armour' }, { src: '旧', en: 'Old' }]);
  assert.deepEqual(receipt.files['stat_lines.json'], { bytes: raw.length, sha256: digest(raw) });
  assert.equal(receipt.adoption, 'not-adopted');
  for (const file of ['src/pobr-stat-lines.mjs', 'src/native-selected-translations.mjs'])
    assert.equal(receipt.implementation[file], digest(fs.readFileSync(new URL(`../${file}`, import.meta.url))));
  assert.deepEqual(fs.readdirSync(options.out).sort(), ['receipt.json', 'stat_lines.json']);
  assert.throws(() => createStatLines(options), /EEXIST/);
});

test('rejects changed inputs, outputs outside .cache and malformed arguments', t => {
  const { root, options } = inputs(t);
  assert.throws(() => createStatLines({ ...options, 'legacy-sha256': '0'.repeat(64) }), /SHA256 mismatch/);
  assert.throws(() => createStatLines({ ...options, out: path.join(path.dirname(fileURLToPath(import.meta.url)), 'fresh') }),
    /fresh repository cache candidate/);
  assert.equal(fs.existsSync(options.out), false);
  fs.mkdirSync(path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
  assert.throws(() => createStatLines({ ...options, out: path.join(root, 'link', 'out') }), /parent contains a symlink/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'real')), []);
  const argv = Object.entries(options).flatMap(([key, value]) => [`--${key}`, value]);
  assert.deepEqual(parseStatLineArgs(argv), options);
  assert.throws(() => parseStatLineArgs([...argv, '--out', root]), /duplicate/);
  assert.throws(() => parseStatLineArgs(argv.slice(2)), /missing/);
  assert.throws(() => parseStatLineArgs(['--unknown', 'x', ...argv]), /invalid/);
});
