import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDictionary } from '../src/dictionary.mjs';

const row = (id, text) => ({ id, text });
const catalog = entries => ({ result: [{ id: 'explicit', label: 'Explicit', entries }] });
const proof = { enUrl: 'https://poe2db.tw/us/Amulets', cnUrl: 'https://poe2db.tw/cn/Amulets', identity: { family: ['Life'] } };
const pair = (english, chinese) => ({ english, chinese, proof });
const input = chinese => ({ english: catalog([row('explicit.stat_1', '# to maximum Life')]), chinese: catalog(chinese) });

test('official text survives conflicting supplemental evidence', () => {
  const result = buildDictionary({ ...input([row('explicit.stat_1', '# 生命上限')]),
    supplementalPairs: [pair('# to maximum Life', '最大生命值增加 #')] });
  assert.equal(result.entries[0].chinese, '# 生命上限');
  assert.equal(result.entries[0].method, 'trade');
  assert.deepEqual(result.conflicts[0], { kind: 'official-supplemental-difference', id: 'explicit.stat_1',
    english: '# to maximum Life', retained: '# 生命上限', candidates: ['最大生命值增加 #'] });
});

test('missing official text gains exact supplemental template with source proof', () => {
  const result = buildDictionary({ ...input([]), supplementalPairs: [pair('# to maximum Life', '# 生命上限')] });
  assert.equal(result.entries[0].method, 'poe2db');
  assert.equal(result.entries[0].chinese, '# 生命上限');
  assert.equal(result.entries[0].evidence[0].cnUrl, proof.cnUrl);
  assert.equal(result.report.stages.explicit_reuse.covered_english, 0);
  assert.equal(result.report.stages.poe2db.covered_english, 1);
});

test('different supplemental Chinese candidates do not collapse to first or last', () => {
  const result = buildDictionary({ ...input([]), supplementalPairs: [
    pair('# to maximum Life', '# 生命上限'), pair('# to maximum Life', '# 最大生命'),
  ] });
  assert.equal(result.entries[0].chinese, null);
  assert.equal(result.entries[0].reason, 'missing-cn');
  assert.equal(result.conflicts[0].kind, 'supplemental-ambiguity');
});

test('supplemental data cannot rewrite literal conditions or mismatched arity', () => {
  const result = buildDictionary({ ...input([]), supplementalPairs: [
    pair('# to maximum Life while on Full Mana', '满魔时 # 生命上限'),
    pair('# to maximum Life', '# 到 # 生命上限'),
  ] });
  assert.equal(result.entries[0].chinese, null);
  assert.equal(result.conflicts[0].kind, 'invalid-supplemental-template');
});

test('duplicate official branches require supplemental text in the official Chinese set', () => {
  const english = catalog([row('explicit.stat_1', '#% increased Experience gain'), row('explicit.stat_1', '#% increased Experience gain in Map')]);
  const chinese = catalog([row('explicit.stat_1', '经验值提高 #%'), row('explicit.stat_1', '地图内经验值提高 #%')]);
  const result = buildDictionary({ english, chinese, supplementalPairs: [
    pair('#% increased Experience gain', '经验值提高 #%'),
    pair('#% increased Experience gain in Map', '经验获取增加 #%'),
  ] });
  assert.equal(result.entries.find(e => e.english.endsWith('gain')).chinese, '经验值提高 #%');
  assert.equal(result.entries.find(e => e.english.endsWith('Map')).chinese, null);
  assert.equal(result.conflicts[0].kind, 'supplemental-not-in-official-branches');
});

test('reviewed override is explicit and stale, duplicate or arity-changing edits fail', () => {
  const override = { id: 'explicit.stat_1', english: '# to maximum Life', chinese: '# 最大生命',
    reason: 'Reviewed current source wording', source_url: proof.cnUrl };
  const source = input([row('explicit.stat_1', '# 生命上限')]);
  const result = buildDictionary({ ...source, overrides: [override] });
  assert.equal(result.entries[0].method, 'manual');
  assert.equal(result.entries[0].chinese, '# 最大生命');
  assert.equal(result.conflicts[0].kind, 'reviewed-override');
  assert.throws(() => buildDictionary({ ...source, overrides: [{ ...override, english: '# to Mana' }] }), /Stale override/);
  assert.throws(() => buildDictionary({ ...source, overrides: [override, override] }), /Duplicate override/);
  assert.throws(() => buildDictionary({ ...source, overrides: [{ ...override, chinese: '生命' }] }), /placeholder mismatch/);
});

test('same English with category-specific translations remains an explicit ambiguity', () => {
  const english = { result: [
    { id: 'explicit', label: 'Explicit', entries: [row('explicit.stat_1', '#% increased Spirit')] },
    { id: 'implicit', label: 'Implicit', entries: [row('implicit.stat_1', '#% increased Spirit')] },
  ] };
  const chinese = { result: [
    { id: 'explicit', label: 'Explicit', entries: [row('explicit.stat_1', '该装备精魂提高 #%')] },
    { id: 'implicit', label: 'Implicit', entries: [row('implicit.stat_1', '精魂提高 #%')] },
  ] };
  const result = buildDictionary({ english, chinese });
  assert.deepEqual(result.report.ambiguous_text_translations[0], {
    english: '#% increased Spirit', translations: ['精魂提高 #%', '该装备精魂提高 #%'],
  });
  assert.deepEqual(result.pairs.find(p => p.chinese.startsWith('该装备')).ids, ['explicit.stat_1']);
});
