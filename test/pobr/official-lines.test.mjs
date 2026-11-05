import { test } from 'node:test';
import assert from 'node:assert/strict';
import { officialLayer, plain, readOfficialSource } from '../../src/pobr/official-lines.mjs';
import { MEMBER, chinaPackage } from './official-fixture.mjs';

const source = (texts, incomplete = [], stats = {}) => ({
  texts: new Map(Object.entries(texts).map(([en, list]) => [en, new Set(list)])),
  stats: new Map(Object.keys(texts).map(en => [en, new Set(stats[en] ?? ['x'])])),
  incomplete: new Set(incomplete),
});

test('plain() reads the markup the way the shipped rows spell it', () => {
  assert.equal(plain('[Resistances|火焰抗性] {0:+d}%'), '火焰抗性 {0:+d}%');
  assert.equal(plain('生命[Flask] {0}'), '生命Flask {0}');
  // The China client writes [Flask|] for a keyword link that shows no text.
  assert.equal(plain('附加相当于[Flask|]药剂回复量'), '附加相当于药剂回复量');
  assert.equal(plain('献祭 {0}%\\n完全献祭'), '献祭 {0}%\n完全献祭');
});

test('officialLayer: confirmed, revised, partial, incomplete, added, skipped and kept, per English', () => {
  const base = [
    { src: '甲 {0}', en: 'A {0}' },
    { src: '旧乙 {0}', en: 'B {0}' },
    { src: '箭雨', en: 'Rain' }, { src: '轮箭雨', en: 'Rain' },
    { src: '旧丙', en: 'C' },
    { src: '丁', en: 'D' },
    { src: '旧戊', en: 'Marked' },
  ];
  const templates = new Map([['E {0}', ['e']], ['G', ['g']], ['I', ['i']]]);
  const newer = source({ 'A {0}': ['甲 {0}'], 'B {0}': ['新乙 {0}'], Rain: ['箭雨'], C: ['新丙'], 'E {0}': ['戊 {0}'], F: ['己'],
    G: ['庚'], Marked: ['[Unknown 戊'] }, ['C'], { 'E {0}': ['e'], G: ['h'] });
  const older = source({ 'B {0}': ['更旧乙 {0}'], I: ['辛'], D: ['新丁'] }, [], { I: ['i'] });
  const layer = officialLayer(base, [newer, older], templates);
  const decision = Object.fromEntries(layer.decisions.map(row => [row.english, [row.decision, row.source]]));
  assert.deepEqual(decision, {
    'A {0}': ['confirmed', 0], 'B {0}': ['revised', 0], Rain: ['revised-partial', 0], C: ['kept-pairing-incomplete', 0],
    'E {0}': ['added', 0], F: ['skipped-not-game-template', 0], G: ['skipped-other-stats', 0], Marked: ['skipped-unresolved-markup', 0],
    // The older source fills only English the newer one lacks (B stays with the newer text).
    I: ['added', 1], D: ['revised', 1],
  });
  // Revised English take the official rows (轮箭雨 is dropped); C (incomplete pairing) and Marked
  // (unknown markup) keep the base; F and G add nothing; E and I are added. Sorted like the member.
  const byText = (a, b) => a.src < b.src ? -1 : a.src > b.src ? 1 : 0;
  assert.deepEqual(layer.lines, [
    { src: '戊 {0}', en: 'E {0}' },
    { src: '新丁', en: 'D' },
    { src: '新乙 {0}', en: 'B {0}' },
    { src: '旧丙', en: 'C' },
    { src: '旧戊', en: 'Marked' },
    { src: '甲 {0}', en: 'A {0}' },
    { src: '箭雨', en: 'Rain' },
    { src: '辛', en: 'I' },
  ].sort(byText));
  // Rows stay {src, en}: the official layer never marks a row.
  assert.ok(layer.lines.every(row => Object.keys(row).length === 2));
  assert.deepEqual([...layer.english].sort(), ['A {0}', 'B {0}', 'D', 'E {0}', 'I', 'Rain']);
  assert.deepEqual(layer.decisions.find(row => row.english === 'Rain').base, ['箭雨', '轮箭雨']);
  assert.deepEqual(layer.counts.sources[0], { official_english: 8, confirmed: 1, revised: 2, revised_partial: 1, kept_pairing_incomplete: 1,
    added: 1, skipped_not_game_template: 1, skipped_other_stats: 1, skipped_unresolved_markup: 1, shadowed: 0 });
  assert.deepEqual(layer.counts.sources[1], { official_english: 3, confirmed: 0, revised: 1, revised_partial: 0, kept_pairing_incomplete: 0,
    added: 1, skipped_not_game_template: 0, skipped_other_stats: 0, skipped_unresolved_markup: 0, shadowed: 1 });
  assert.deepEqual(layer.counts.total, { official_english: 10, confirmed: 1, revised: 3, revised_partial: 1, kept_pairing_incomplete: 1,
    added: 2, skipped_not_game_template: 1, skipped_other_stats: 1, skipped_unresolved_markup: 1, kept_historical: 0 });
  // Swapping the order swaps who decides B.
  const swapped = officialLayer(base, [older, newer], templates);
  assert.deepEqual(swapped.lines.filter(row => row.en === 'B {0}'), [{ src: '更旧乙 {0}', en: 'B {0}' }]);
  // Base English no source supplies is kept historical.
  assert.equal(officialLayer(base, [source({ 'A {0}': ['甲 {0}'] })], templates).counts.total.kept_historical, 5);
});

test('readOfficialSource reads the member through the frozen reader and refuses any other shape', async () => {
  const { zip, spec } = chinaPackage({ extra: { 'display-tables/default/tables.json': Buffer.from('{}') } });
  const read = await readOfficialSource(zip, spec, 'zh-CN');
  assert.deepEqual(Object.fromEntries([...read.texts.texts].map(([en, set]) => [en, [...set].sort()])), {
    '{0:+d}% to Fire Resistance': ['火焰抗性 {0:+d}%'],
    'Adds {0:d} to {1:d} damage every 2 seconds': ['每 2 秒附加 {1:d} 至 {0:d} 伤害'],
    'Same {0} template': ['第一种 {0} 模板', '第二种 {0} 模板'],
    'Local {0:+d} Resistance': ['本地抗性 {0:+d}'],
  });
  assert.deepEqual([...read.texts.stats.get('Same {0} template')].sort(), ['scope_one', 'scope_two']);
  // The English of every default branch the reader excluded.
  assert.ok(read.texts.incomplete.has('{0} value') && read.texts.incomplete.has('Same'));
  assert.equal(read.source.realm, 'china');
  assert.equal(read.source.member, MEMBER);
  assert.deepEqual(read.source.package_target, { game: 'poe2', game_patch: '9.9', realm: 'china' });
  assert.equal(read.source.source_identity.source, 'synthetic');
  assert.deepEqual(read.source.reader, { pairs: 5, excluded: 11, excluded_by_reason: { 'literal-number-mismatch': 1,
    'missing-simplified-chinese-group': 1, 'no-han-in-declared-chinese': 1, 'nonunique-branch-signature': 1,
    'unmatched-branch-signature': 6, 'unresolved-template-syntax': 1 } });
  // International Simplified Chinese is not official zh-CN, and no other locale has a CSD source.
  const intl = chinaPackage({ realm: 'international' });
  await assert.rejects(readOfficialSource(intl.zip, intl.spec, 'zh-CN'), /is realm international; official zh-CN needs realm china/u);
  await assert.rejects(readOfficialSource(zip, spec, 'zh-TW'), /no official stat-line source for zh-TW/u);
  await assert.rejects(readOfficialSource(zip, { ...spec, manifest_sha256: '0'.repeat(64) }, 'zh-CN'), /differs from the pinned manifest_sha256/u);
  const extra = chinaPackage({ extra: { [`${MEMBER}extra.json`]: Buffer.from('{}') } });
  await assert.rejects(readOfficialSource(extra.zip, extra.spec, 'zh-CN'), /must hold exactly descriptions\.json/u);
  const missing = chinaPackage({ files: { 'diagnostics.json': null } });
  await assert.rejects(readOfficialSource(missing.zip, missing.spec, 'zh-CN'), /must hold exactly/u);
  const forged = chinaPackage({ root: pins => ({ ...pins, [`${MEMBER}descriptions.json`]: { bytes: 1, sha256: '0'.repeat(64) } }) });
  await assert.rejects(readOfficialSource(forged.zip, forged.spec, 'zh-CN'), /descriptions\.json differs from its manifest pin/u);
  // A client:capture receipt that the lock evidence pins gives the client identity; it is found by hash.
  assert.equal(read.source.client, undefined);
  const receipt = { schema: 'repoe-client-capture-receipt/v1', game_patch: '9.9', realm: 'china', declared_not_verified: ['game_patch', 'realm'],
    capture: { capture_json: { bytes: 1, sha256: 'a'.repeat(64) } },
    observed_client: { executables: [{ name: 'PathOfExile_x64.exe', file_version: '9.9.172', sha256: 'b'.repeat(64), bytes: 1 }],
      index: { sha256: 'c'.repeat(64) } } };
  const captured = chinaPackage({ receipt });
  const withClient = await readOfficialSource(captured.zip, captured.spec, 'zh-CN');
  assert.deepEqual(withClient.source.client, { capture_receipt: { path: 'capture/capture-receipt.json',
    sha256: withClient.source.source_identity.acquisition.evidence[0].sha256 }, capture_json_sha256: 'a'.repeat(64),
  client_index_sha256: 'c'.repeat(64), executables: [{ name: 'PathOfExile_x64.exe', file_version: '9.9.172', sha256: 'b'.repeat(64) }],
  declared: { game_patch: '9.9', realm: 'china', not_verified: ['game_patch', 'realm'] } });
  const wrongSchema = chinaPackage({ receipt: { ...receipt, schema: 'other/v1' } });
  await assert.rejects(readOfficialSource(wrongSchema.zip, wrongSchema.spec, 'zh-CN'), /is not a repoe-client-capture-receipt\/v1/u);
  // A member file the frozen reader rejects (here its manifest pin) fails closed.
  const tampered = chinaPackage({ files: { 'diagnostics.json': Buffer.from('{"diagnostics":[]}\n') } });
  await assert.rejects(readOfficialSource(tampered.zip, tampered.spec, 'zh-CN'), /Native payload identity mismatch|bound/u);
});
