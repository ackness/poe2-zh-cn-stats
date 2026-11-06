import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { strictJson } from '../../src/strict-json.mjs';

// The locale/0.5.5.5-4 publication: official China text before our supplements, and gem descriptions
// and monster names from official client tables. Only frozen publications are read, so later curation
// edits cannot change these claims.
const read = async file => strictJson(await readFile(new URL(`../../inputs/${file}`, import.meta.url)));
const lines = await read('locale-0.5.5.5-4/i18n/zh-CN/stat_lines.json');
const cn = await read('locale-0.5.5.5-4/i18n/zh-CN/display_texts.json');
const tw = await read('locale-0.5.5.5-4/i18n/zh-TW/display_texts.json');
const meta = await read('locale-0.5.5.5-4/i18n/zh-CN/_meta.json');
const WOLF = 'Metadata/Monsters/Wolves/WolfCompanionPlayerSummoned';
const GEMS = ['GemEffects.SupportText', 'ActiveSkills.Description'];
const plain = text => text.replace(/\[([^\]|]*)\|([^\]]*)\]/gu, '$2').replace(/\[([^\]|]*)\]/gu, '$1')
  .replaceAll('\\n', '\n').replaceAll('\r\n', '\n').trim();

test('stat lines: official China text first, 29 agent rows, Bonded/Idol official', () => {
  assert.deepEqual(meta.official.counts, { official_english: 22750, confirmed: 22517, revised: 103, revised_partial: 10,
    kept_pairing_incomplete: 0, added: 28, skipped_not_game_template: 102, skipped_other_stats: 0, skipped_unresolved_markup: 0,
    kept_historical: 5300 });
  assert.equal(lines.filter(row => row.origin === 'agent').length, 29);
  assert.equal(lines.filter(row => row.origin === 'agent' && row.en.startsWith('Bonded: ')).length, 24);
  const idol = lines.filter(row => row.en === 'Gain the benefits of Bonded modifiers on Runes and Idols');
  assert.deepEqual(idol, [{ src: '从符文和魔偶上获得纽带词缀效果', en: 'Gain the benefits of Bonded modifiers on Runes and Idols' }]);
  assert.deepEqual(lines.filter(row => row.en === '{0}% increased Skill Effect Duration'),
    [{ src: '技能效果持续时间提高 {0}%', en: '{0}% increased Skill Effect Duration' }]);
});

test('monster names are official in both locales: Wolf Companion is 恶狼同伴 and 狼盟友', () => {
  assert.deepEqual(cn.scopes['MonsterVarieties.Name'][WOLF], ['Wolf Companion', '恶狼同伴']);
  assert.deepEqual(tw.scopes['MonsterVarieties.Name'][WOLF], ['Wolf Companion', '狼盟友']);
  // Official text is never marked: neither member has an origins block.
  assert.equal(Object.hasOwn(cn, 'origins'), false);
  assert.equal(Object.hasOwn(tw, 'origins'), false);
  assert.deepEqual(tw.entries, {});
});

// Contract 1.3 markup: only [A] and [A|B] with a non-empty key, and nothing left after rendering.
const MARKUP = /\[([^[\]|]+)(?:\|([^[\]|]*))?\]/gu;
const wellFormed = text => !/[[\]]/u.test(text.replace(MARKUP, ''));

test('table rows: one English per id across locales, never null, only [A] and [A|B] markup', () => {
  for (const scope of [...GEMS, 'MonsterVarieties.Name']) {
    for (const [locale, catalog] of [['zh-CN', cn], ['zh-TW', tw]]) {
      for (const [id, [english, text]] of Object.entries(catalog.scopes[scope])) {
        assert.equal(typeof text, 'string', `${locale} ${scope} ${id}`);
        assert.ok(wellFormed(english) && wellFormed(text), `${locale} ${scope} ${id}: ${text}`);
        if (locale === 'zh-TW' && cn.scopes[scope][id]) assert.equal(cn.scopes[scope][id][0], english, `${scope} ${id}`);
      }
    }
  }
  assert.equal(wellFormed('[Projectile|Projectiles|投射物]'), false);
  assert.equal(wellFormed('[BloodLoss|失血影響。'), false);
  // The client's zh-TW herald_of_blood and frost_darts texts break the markup, so only zh-CN ships them.
  for (const id of ['herald_of_blood', 'frost_darts']) {
    assert.equal(tw.scopes['ActiveSkills.Description'][id], undefined, id);
    assert.equal(typeof cn.scopes['ActiveSkills.Description'][id][1], 'string', id);
  }
  assert.deepEqual(Object.fromEntries([...GEMS, 'MonsterVarieties.Name'].map(scope => [scope, Object.keys(tw.scopes[scope]).length])),
    { 'GemEffects.SupportText': 611, 'ActiveSkills.Description': 438, 'MonsterVarieties.Name': 648 });
});

test('every entry of the retired support description asset is in the zh-CN GemEffects.SupportText scope', async () => {
  const old = (await read('support-display-0.5.5.5/supportDescriptions.zh-CN.json')).entries;
  const byEnglish = new Map();
  for (const [english, text] of Object.values(cn.scopes['GemEffects.SupportText'])) byEnglish.set(plain(english), plain(text));
  assert.equal(Object.keys(old).length, 534);
  for (const [id, { en, zh_cn: zh }] of Object.entries(old)) assert.equal(byEnglish.get(plain(en)), plain(zh), id);
});
