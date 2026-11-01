import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTranslations } from '../src/legacy-translation-merge.mjs';

const snapshot = '20261012T000000000Z';
const row = (src, en, kind = 'trade') => ({ src, en, kind, provenance: { source: 'fixture' } });
const bundle = templates => ({ schema_version: 1, snapshot, templates, words: [], excluded: [] });
const life = row('{0:d} 生命上限', '{0:d} to maximum Life');

test('reviewed nested templates retain exact slot identity and plural aliases', () => {
  const templates = [row('获得 {0} 个天赋技能点', 'Grants {0} Passive Skill Point', 'curated'),
    row('获得 {0} 个天赋技能点', 'Grants {0} Passive Skill Points', 'curated'),
    row('获得技能：{0} 级 {1}', 'Grants Skill: Level {0} {1}', 'curated')];
  const result = mergeTranslations([], bundle(templates));
  assert.deepEqual(new Set(result.pairs.map(p => p.en)), new Set(templates.map(p => p.en)));
  assert.equal(result.report.added_curated, 3);
});

test('new automatic text is admitted without taking over a different existing Chinese template', () => {
  const legacy = [{ src: '{0:+d} 生命上限', en: '{0:+d} to maximum Life' },
    { src: '{0:d}% 法术伤害', en: '{0:d}% increased Spell Damage' }];
  const mana = row('{0:d} 魔力上限', '{0:d} to maximum Mana');
  const result = mergeTranslations(legacy, bundle([life, mana,
    row('{0:d}% 法术伤害', '{0:d}% increased Attack Damage')]));
  assert.deepEqual(result.pairs.filter(p => p.en.includes('Life')), [legacy[0]]);
  assert.ok(result.pairs.some(p => p.en === mana.en && p.src === mana.src));
  assert.equal(result.report.added_trade, 1);
  assert.deepEqual(result.report.replaced_legacy, []);
  assert.deepEqual(new Set(result.report.excluded.map(p => p.reason)), new Set(['existing-english-template', 'existing-chinese-template']));
});

test('official wording replaces differing legacy Chinese and keeps the legacy English and slot format', () => {
  const legacy = [{ src: '{0:+d} 最大生命', en: '{0:+d} to maximum Life' },
    { src: '绑定词缀生效', en: 'Bonded modifiers apply' },
    { src: '第一行\n第二行 {0}', en: 'First line\nsecond {0}' }];
  const result = mergeTranslations(legacy, bundle([life,
    row('羁绊词缀生效', 'Bonded modifiers apply'),
    row('首行 次行 {0:d}', 'First line second {0:d}')]));
  assert.deepEqual(result.pairs.filter(p => p.en.includes('Life')), [{ src: '{0:+d} 生命上限', en: '{0:+d} to maximum Life' }]);
  assert.deepEqual(result.pairs.filter(p => p.en.includes('Bonded')), [{ src: '羁绊词缀生效', en: 'Bonded modifiers apply' }]);
  assert.ok(result.pairs.some(p => p.src === legacy[2].src), 'multi-line legacy templates are kept');
  assert.deepEqual(result.report.replaced_legacy.map(p => [p.legacy, p.official]),
    [['绑定词缀生效', '羁绊词缀生效'], ['{0:+d} 最大生命', '{0:+d} 生命上限']]);
  assert.equal(result.report.added_trade, 0);
});

test('official wording does not replace curated, literal-number or ambiguous templates', () => {
  const curated = row('每 {0} 点力量', 'Per {0} Strength', 'curated');
  const legacy = [{ src: '每 10 点敏捷获得 {0} 闪避', en: '{0} Evasion per 10 Dexterity' },
    { src: '旧甲', en: '{0} to Armour' }];
  const result = mergeTranslations(legacy, bundle([curated,
    row('每 {0:d} 点力量值', 'Per {0:d} Strength'),
    row('每 20 点敏捷增加 {0:d} 闪避值', '{0:d} Evasion per 20 Dexterity'),
    row('{0:d} 护甲', '{0:d} to Armour'), row('护甲 {0:d}', '{0:d} to armour')]));
  assert.deepEqual(result.report.replaced_legacy, []);
  assert.deepEqual(new Set(result.pairs.map(p => p.src)), new Set([curated.src, legacy[0].src, legacy[1].src]));
});

test('literal-number and case-only skeleton collisions are excluded independent of source order', () => {
  const rows = [row('每 10 点敏捷增加 {0:d} 闪避值', '{0:d} Evasion per 10 Dexterity'),
    row('每 20 点敏捷增加 {0:d} 闪避值', '{0:d} Evasion per 20 Dexterity'),
    row('额外 {0:d} 精魂', '{0:d} additional Spirit'),
    row('{0:d} 额外精魂', '{0:d} additional spirit')];
  const first = mergeTranslations([], bundle(rows));
  const reversed = mergeTranslations([], bundle([...rows].reverse()));
  assert.deepEqual(first, reversed);
  assert.deepEqual(first.pairs, []);
  assert.equal(first.report.excluded.filter(p => p.reason === 'automatic-skeleton-ambiguity').length, 4);
});

test('invalid placeholder mappings fail closed', () => {
  assert.throws(() => mergeTranslations([], bundle([row('{1} 生命', '{0} Life')])), /template/);
  assert.throws(() => mergeTranslations([], bundle([row('{bad} 生命', '{0} Life')])), /placeholder/);
});
