import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDictionary } from '../../src/trade/dictionary.mjs';

const life = { id: 'explicit.stat_1', text: '# to maximum Life' };
const catalog = entries => ({ result: [{ id: 'explicit', label: 'Explicit', entries }] });
const build = (translations = [], cn = [], extra = {}) => buildDictionary({
  english: catalog([life]), chinese: catalog(cn), translations, ...extra,
});
const manual = { id: life.id, english: life.text, manual_chinese: '# 最大生命',
  manual_note: 'Reviewed the Life stat, not Mana', manual_source_url: null };

test('missing branches enter the table separately and derived fields cannot act as translations', () => {
  const english = catalog([life, { ...life, text: '# to maximum Mana' }]);
  const result = build([], [], { english });
  assert.deepEqual(result.translations.map(r => [r.english, r.status]), [
    ['# to maximum Life', 'pending'], ['# to maximum Mana', 'pending'],
  ]);
  const edited = result.translations.map(row => ({ ...row, chinese: '# 伪造译文', status: 'automatic' }));
  const again = build(edited, [], { english });
  assert.deepEqual(again.translations, result.translations);
  assert.equal(again.report.translation_worklist.pending, 2);
});

test('manual completion enters dictionary, coverage and evidence and survives repeated builds', () => {
  const result = build([manual]);
  assert.equal(result.entries[0].chinese, '# 最大生命');
  assert.equal(result.entries[0].method, 'manual-fallback');
  assert.equal(result.entries[0].evidence[0].reason, manual.manual_note);
  assert.equal(result.report.totals.resolved_entries, 1);
  assert.deepEqual(result.unresolved, []);
  assert.equal(result.translations[0].status, 'manual');
  assert.deepEqual(build(result.translations), result);
});

test('later official translation replaces fallback without erasing the manual work', () => {
  const first = build([manual]);
  const official = [{ id: life.id, text: '# 生命上限' }];
  const updated = build(first.translations, official);
  assert.equal(updated.entries[0].method, 'trade');
  assert.equal(updated.entries[0].chinese, '# 生命上限');
  assert.equal(updated.translations[0].status, 'automatic');
  assert.equal(updated.translations[0].manual_chinese, manual.manual_chinese);
  assert.equal(updated.translations[0].manual_differs, true);
  assert.equal(updated.report.translation_worklist.manual_differences, 1);
  assert.equal(updated.conflicts[0].kind, 'manual-fallback-difference');
  assert.deepEqual(build(updated.translations, official), updated);
  const unavailableAgain = build(updated.translations);
  assert.equal(unavailableAgain.entries[0].chinese, manual.manual_chinese);
  assert.equal(unavailableAgain.translations[0].status, 'manual');
});

test('later PoE2DB evidence automatically completes pending rows and supersedes fallbacks', () => {
  const supplementalPairs = [{ english: life.text, chinese: '# 生命上限', proof: {
    enUrl: 'https://poe2db.tw/us/Amulets', cnUrl: 'https://poe2db.tw/cn/Amulets', identity: { family: ['Life'] },
  } }];
  for (const table of [build().translations, [manual]]) {
    const result = build(table, [], { supplementalPairs });
    assert.equal(result.translations[0].status, 'automatic');
    assert.equal(result.entries[0].method, 'poe2db');
    assert.equal(result.entries[0].chinese, '# 生命上限');
  }
});

test('changed English is a new pending branch and old work retires without migrating', () => {
  const previous = build([manual]);
  const changed = build(previous.translations, [], {
    english: catalog([{ id: life.id, text: '# to maximum Mana' }]),
  });
  assert.equal(changed.entries[0].chinese, null);
  assert.deepEqual(changed.translations.map(r => [r.english, r.status]), [
    ['# to maximum Life', 'retired'], ['# to maximum Mana', 'pending'],
  ]);
  assert.equal(changed.translations[0].manual_chinese, manual.manual_chinese);
  assert.equal(changed.translations[0].reason, 'not-in-current-catalog');
  const restored = build(changed.translations);
  assert.equal(restored.entries[0].chinese, manual.manual_chinese);
  assert.equal(restored.translations.find(r => r.english === life.text).status, 'manual');
});

test('enum suffixes are distinct and a previously automatic value never becomes a manual fallback', () => {
  const english = catalog([{ id: 'explicit.stat_1|1', text: life.text }, { id: 'explicit.stat_1|2', text: life.text }]);
  const result = build([{ ...manual, id: 'explicit.stat_1|1' }], [], { english });
  assert.equal(result.entries.find(e => e.id.endsWith('|2')).chinese, null);
  assert.equal(result.entries.find(e => e.id.endsWith('|1')).chinese, manual.manual_chinese);
  const automatic = build(build().translations, [{ id: life.id, text: '# 生命上限' }]);
  const missing = build(automatic.translations);
  assert.equal(missing.entries[0].chinese, null);
  assert.equal(missing.translations[0].status, 'pending');
});

test('explicit overrides retain priority over both official and fallback translations', () => {
  const result = build([manual], [{ id: life.id, text: '# 生命上限' }], { overrides: [{
    id: life.id, english: life.text, chinese: '最大生命增加 #', reason: 'Reviewed correction',
    source_url: 'https://poe2db.tw/cn/Amulets',
  }] });
  assert.equal(result.entries[0].method, 'manual');
  assert.equal(result.entries[0].chinese, '最大生命增加 #');
  assert.equal(result.translations[0].status, 'override');
  assert.equal(result.translations[0].manual_chinese, manual.manual_chinese);
});

test('invalid or duplicated manual work fails rather than quietly contaminating the dictionary', () => {
  assert.throws(() => build([manual, manual]), /Duplicate translation/);
  assert.throws(() => build([{ ...manual, manual_chinese: '生命' }]), /placeholder mismatch/);
  assert.throws(() => build([{ ...manual, manual_chinese: '# untranslated' }]), /Chinese text/);
  assert.throws(() => build([{ ...manual, manual_note: '' }]), /review note/);
  assert.throws(() => build([{ ...manual, manual_source_url: 'https://' }]), /HTTPS URL/);
  assert.throws(() => build([{ ...manual, manual_source_url: 'http://example.org' }]), /HTTPS URL/);
});

test('agent supplements carry origin into evidence, and only reviewed rows are applied', () => {
  const review = { by: 'claude-opus-5-5', note: 'Checked the term against the official Life rows' };
  const agent = { ...manual, manual_origin: 'agent', manual_basis: 'official-same-stat-other-category',
    manual_author: 'claude-haiku-4-5', manual_status: 'reviewed', manual_review: review };
  const result = build([agent]);
  assert.equal(result.entries[0].chinese, manual.manual_chinese);
  assert.deepEqual(result.entries[0].evidence, [{ source: 'manual-fallback', reason: manual.manual_note, url: null,
    origin: 'agent', basis: 'official-same-stat-other-category', author: 'claude-haiku-4-5', review }]);
  assert.equal(result.translations[0].manual_origin, 'agent');
  assert.deepEqual(build(result.translations), result);
  // A legacy row without the new fields is a human, reviewed fallback and keeps its table shape.
  const legacy = build([manual]);
  assert.equal(legacy.entries[0].evidence[0].origin, 'human');
  assert.deepEqual(Object.keys(legacy.translations[0]).filter(key => key.startsWith('manual_')),
    ['manual_chinese', 'manual_note', 'manual_source_url', 'manual_differs']);
  for (const status of ['draft', 'rejected']) {
    const kept = build([{ ...agent, manual_status: status, ...(status === 'draft' ? { manual_review: null } : {}) }]);
    assert.equal(kept.entries[0].chinese, null);
    assert.equal(kept.translations[0].status, 'pending');
    assert.equal(kept.translations[0].manual_status, status);
    assert.equal(kept.translations[0].manual_chinese, manual.manual_chinese);
    assert.deepEqual(build(kept.translations), kept);
  }
  // Official text that appears later still wins over a reviewed agent row and records the difference.
  const official = build(result.translations, [{ id: life.id, text: '# 生命上限' }]);
  assert.equal(official.entries[0].method, 'trade');
  assert.equal(official.translations[0].manual_differs, true);
  assert.equal(official.translations[0].manual_origin, 'agent');
});

test('supplement attribution is validated', () => {
  const agent = { ...manual, manual_origin: 'agent', manual_author: 'claude-haiku-4-5', manual_status: 'draft' };
  assert.throws(() => build([{ ...agent, manual_status: undefined }]), /requires manual_status and manual_author/);
  assert.throws(() => build([{ ...agent, manual_author: undefined }]), /requires manual_status and manual_author/);
  assert.throws(() => build([{ ...agent, manual_author: ' ' }]), /manual_author must be nonempty/);
  // The author may be a model id, a GitHub account or a deterministic generator id.
  assert.doesNotThrow(() => build([{ ...agent, manual_author: 'zh-supp-plan generator (deterministic)' }]));
  assert.throws(() => build([{ ...agent, manual_origin: 'official' }]), /agent or human/);
  assert.throws(() => build([{ ...agent, manual_status: 'approved' }]), /draft, reviewed or rejected/);
  assert.throws(() => build([{ ...agent, manual_status: 'reviewed' }]), /requires manual_review/);
  assert.throws(() => build([{ ...agent, manual_status: 'reviewed', manual_review: { by: '', note: 'x' } }]), /\{by, note\}/);
  assert.throws(() => build([{ ...agent, manual_basis: 'guess' }]), /Unknown manual_basis/);
  assert.throws(() => build([{ ...agent, manual_chinese: null, manual_status: 'reviewed',
    manual_review: { by: 'a', note: 'b' } }]), /requires manual_chinese/);
  // A rejected draft may keep text that would not pass; it is never applied.
  assert.equal(build([{ ...agent, manual_chinese: '生命', manual_status: 'rejected', manual_review: { by: 'a', note: 'slot lost' } }])
    .entries[0].chinese, null);
});
