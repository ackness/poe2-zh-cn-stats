import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { entryId, statTemplates, templateProblem, validateSupplements } from '../../src/pobr/display-supplements.mjs';
import { createSupplementLines, supplementLines } from '../../src/pobr/supplement-lines.mjs';
import { storedZip } from '../../src/release/stored-zip.mjs';

const TARGET = { game: 'poe2', game_patch: '9.9', realm: 'international', locale: 'zh-CN' };
const GAME = { sha256: 'c'.repeat(64), stat_descriptions_sha256: 'd'.repeat(64) };
const BASED_ON = { game_patch: '9.9', game_package: { repository: 'ackness/repoe', tag: 'game/9.9-1', sha256: GAME.sha256 },
  stat_descriptions_sha256: GAME.stat_descriptions_sha256 };
const REVIEW = { by: 'claude-opus-5-5', note: 'Checked against the official terms' };
const DESCRIPTIONS = { scopes: {
  stat_descriptions: {
    descriptors: {
      fire_per_block: { member_stats: ['fire_per_block'], branches: [{ template: 'Gain {0}% of damage as Fire per 2% Block' }] },
      life: { branches: [{ template: '{0}% increased maximum Life' }, { template: '{0}% reduced maximum Life' }] },
    },
    compound: { added_min: { member_stats: ['added_min', 'added_max'], template: 'Adds {0} to {1} Fire Damage' } },
  },
  passive_skill_stat_descriptions: { descriptors: { life: { branches: [{ template: '{0}% increased maximum Life' }] } } },
} };
const TEMPLATES = statTemplates(DESCRIPTIONS);
const BASE = [
  { src: 'Bonded: 生命提高 10%', en: 'Bonded: 10% increased Life' },
  { src: '生命上限提高 {0}%', en: '{0}% increased maximum Life' },
  { src: '纽带：{0}', en: 'Bonded: {0}' },
  { src: '献祭 {0}%\\完全献祭', en: 'Sacrifice {0}%\nFully made' },
];

const entry = (english, stats, text, extra = {}) => {
  const identity = { game: 'poe2', realm: 'international', locale: 'zh-CN', kind: 'stat-line', english, stats };
  return { entry_id: entryId(identity), identity, ids: null, based_on: BASED_ON, text, origin: 'agent', basis: 'official-terms',
    author: 'claude-haiku-4-5', note: '术语取自官方', status: 'reviewed', review: REVIEW, ...extra };
};
const correction = (id, rows, extra = {}) => ({ correction_id: id, locale: 'zh-CN', member: 'stat_lines.json', rows,
  origin: 'agent', basis: 'official-terms', author: 'claude-opus-5-5', note: '前缀改为官方译法', evidence: ['trade-cn 208/208'],
  status: 'reviewed', review: REVIEW, ...extra });
const doc = (entries = [], corrections = []) => ({ schema: 'poe2-display-supplements/v1', entries, corrections });
const run = (entries, corrections, base = BASE) => supplementLines(structuredClone(base), doc(entries, corrections), TEMPLATES, TARGET, GAME);

test('statTemplates maps every English template of every scope to its sorted stat ids', () => {
  assert.deepEqual(TEMPLATES.get('{0}% increased maximum Life'), ['life']);
  assert.deepEqual(TEMPLATES.get('Adds {0} to {1} Fire Damage'), ['added_max', 'added_min']);
  assert.equal(TEMPLATES.size, 4);
});

test('reviewed corrections replace exact base pairs and mark them; other states leave the base alone', () => {
  const bonded = correction('bonded-prefix-official', [
    { from: BASE[0], to: { src: '羁绊： 生命提高 10%', en: BASE[0].en } },
    { from: BASE[2], to: { src: '羁绊： {0}', en: BASE[2].en } },
    { from: { src: 'Bonded: 已不存在', en: 'Bonded: Gone' }, to: { src: '羁绊： 已不存在', en: 'Bonded: Gone' } },
  ]);
  const slash = correction('literal-backslash-line-break', [{ from: BASE[3], to: { src: '献祭 {0}%\n完全献祭', en: BASE[3].en } }],
    { basis: 'format-repair' });
  const result = run([], [bonded, slash]);
  assert.deepEqual(result.lines, [
    { src: '献祭 {0}%\n完全献祭', en: 'Sacrifice {0}%\nFully made', origin: 'agent' },
    { src: '生命上限提高 {0}%', en: '{0}% increased maximum Life' },
    { src: '羁绊： {0}', en: 'Bonded: {0}', origin: 'agent' },
    { src: '羁绊： 生命提高 10%', en: 'Bonded: 10% increased Life', origin: 'agent' },
  ]);
  assert.deepEqual(result.corrections.map(row => row.decision), ['applied', 'applied', 'retired', 'applied']);
  assert.deepEqual(result.counts.with_origin, { agent: 3 });
  // Re-applied over its own output: the corrected pair is already there.
  const again = supplementLines(result.lines.map(({ origin, ...row }) => row), doc([], [bonded]), TEMPLATES, TARGET, GAME);
  assert.deepEqual(again.corrections.map(row => row.decision), ['already-in-base', 'already-in-base', 'retired']);
  // The base changed the text itself: the base wins.
  const changed = run([], [bonded], [{ src: '其他译文', en: BASE[0].en }]);
  assert.equal(changed.corrections[0].decision, 'superseded');
  assert.deepEqual(run([], [{ ...bonded, status: 'draft', review: null }]).lines, BASE.slice().sort((a, b) =>
    a.src < b.src ? -1 : a.src > b.src ? 1 : 0));
  assert.equal(run([], [{ ...slash, locale: 'zh-TW' }]).corrections[0].decision, 'other-locale');
});

test('reviewed entries append {src, en, origin} only for current templates the base lacks', () => {
  const fire = entry('Gain {0}% of damage as Fire per 2% Block', ['fire_per_block'], '每 2% 格挡获得 {0}% 的火焰伤害');
  const life = entry('{0}% increased maximum Life', ['life'], '最大生命提高 {0}%');
  const stale = entry('Gain {0}% of damage as Cold per 2% Block', ['cold_per_block'], '每 2% 格挡获得 {0}% 的冰霜伤害');
  const otherStats = entry('Adds {0} to {1} Fire Damage', ['added_min'], '附加 {0} - {1} 火焰伤害');
  const draft = entry('{0}% reduced maximum Life', ['life'], '最大生命降低 {0}%', { status: 'draft', review: null });
  const human = entry('Adds {0} to {1} Fire Damage', ['added_max', 'added_min'], '附加 {0} - {1} 基础火焰伤害',
    { origin: 'human', author: 'ackness', based_on: { ...BASED_ON, stat_descriptions_sha256: 'e'.repeat(64) } });
  const result = run([fire, life, stale, otherStats, draft, human], []);
  assert.deepEqual(result.entries.map(row => row.lifecycle), ['supplemented', 'official', 'retired', 'retired', 'draft', 'supplemented']);
  assert.deepEqual(result.entries[1].base, ['生命上限提高 {0}%']);
  assert.equal(result.entries[1].supplement_differs, true);
  assert.equal(result.entries[5].needs_review, 'based_on differs from the pinned game package');
  assert.deepEqual(result.lines.filter(row => row.origin), [
    { src: '每 2% 格挡获得 {0}% 的火焰伤害', en: fire.identity.english, origin: 'agent' },
    { src: '附加 {0} - {1} 基础火焰伤害', en: human.identity.english, origin: 'human' },
  ]);
  assert.equal(result.lines.length, BASE.length + 2);
  assert.throws(() => run([fire, entry(fire.identity.english, ['fire_per_block'], '每 2% 格挡获得 {0}% 火焰伤害',
    { identity: { ...fire.identity }, entry_id: fire.entry_id })], []), /duplicate entry_id/);
});

test('an empty document reproduces the base exactly', () => {
  const sorted = BASE.slice().sort((a, b) => a.src < b.src ? -1 : a.src > b.src ? 1 : a.en < b.en ? -1 : 1);
  assert.deepEqual(run([], [], sorted).lines, sorted);
});

test('the file schema and the template form are validated', () => {
  const good = entry('{0}% reduced maximum Life', ['life'], '最大生命降低 {0}%');
  assert.doesNotThrow(() => validateSupplements(doc([good])));
  const bad = (change, pattern) => assert.throws(() => validateSupplements(doc([{ ...good, ...change }])), pattern);
  bad({ entry_id: '0'.repeat(64) }, /entry_id/);
  bad({ origin: 'official' }, /origin must be agent or human/);
  bad({ status: 'reviewed', review: null }, /review/);
  bad({ review: { by: '', note: 'x' } }, /names its reviewer/);
  bad({ status: 'draft' }, /a draft has review null/);
  bad({ basis: 'guess' }, /basis/);
  bad({ text: '最大生命降低 {1}%' }, /placeholder-mismatch/);
  bad({ extra: 1 }, /fields must be/);
  bad({ ids: ['x'] }, /ids null/);
  assert.doesNotThrow(() => validateSupplements(doc([{ ...good, text: null, status: 'draft', review: null, confidence: 'low' }])));
  assert.throws(() => validateSupplements(doc([], [correction('x', [{ from: BASE[3], to: BASE[3] }])])), /same pair/);
  assert.throws(() => validateSupplements(doc([], [correction('x', [{ from: BASE[3], to: { ...BASE[3], src: '献祭 {0}%\\完全' } }])])),
    /stray-whitespace-or-backslash/);
  assert.throws(() => validateSupplements(doc([], [correction('x', []), correction('y', [])])), /rows lists/);
  assert.throws(() => validateSupplements({ ...doc(), extra: [] }), /fields must be/);
  assert.equal(templateProblem('{0:+d} to Strength', '{0:+d} 力量'), null);
  assert.equal(templateProblem('{0:+d} to Strength', '{0} 力量'), 'placeholder-mismatch');
  assert.equal(templateProblem('Skills fire {1} additional Projectiles', '技能额外发射 {1} 个投射物'), null);
  assert.equal(templateProblem('per 2% Block', '每 1% 格挡'), 'literal-number-mismatch');
  assert.equal(templateProblem('A\nB', 'A 乙'), 'line-count-mismatch');
});

function files(t) {
  const cache = fileURLToPath(new URL('../../.cache/', import.meta.url));
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, 'supplement-lines-test-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const write = (name, raw) => {
    fs.writeFileSync(path.join(root, name), raw);
    return { file: path.join(root, name), bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') };
  };
  return { root, write };
}

test('createSupplementLines reads pinned inputs and writes stat_lines.json, _meta.json and a receipt', async t => {
  const { root, write } = files(t);
  const sorted = BASE.slice().sort((a, b) => a.src < b.src ? -1 : 1);
  const zip = storedZip({ 'data/9.9/overlay/stat_descriptions.json': Buffer.from(JSON.stringify(DESCRIPTIONS)), 'manifest.json': Buffer.from('{}') });
  const descriptionsSha = createHash('sha256').update(JSON.stringify(DESCRIPTIONS)).digest('hex');
  const fire = entry('Gain {0}% of damage as Fire per 2% Block', ['fire_per_block'], '每 2% 格挡获得 {0}% 的火焰伤害');
  const request = {
    schema: 'pobr-supplement-lines-request/v1', target: TARGET,
    base: write('stat_lines.json', JSON.stringify(sorted, null, 2) + '\n'),
    meta: write('_meta.json', JSON.stringify({ source: 'x', counts: { stat_lines: 4 } }, null, 2) + '\n'),
    game_package: { ...write('pobr-game-9.9.zip', zip), repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip' },
    edits: write('display-supplements.json', JSON.stringify(doc([fire], [correction('bonded-prefix-official',
      [{ from: BASE[0], to: { src: '羁绊： 生命提高 10%', en: BASE[0].en } }])]), null, 2) + '\n'),
  };
  const out = path.join(root, 'out');
  const receipt = createSupplementLines(request, out);
  assert.deepEqual(fs.readdirSync(out).sort(), ['_meta.json', 'receipt.json', 'stat_lines.json']);
  const lines = JSON.parse(fs.readFileSync(path.join(out, 'stat_lines.json')));
  assert.equal(lines.length, 5);
  assert.deepEqual(lines.filter(row => row.origin).map(row => row.en), ['Gain {0}% of damage as Fire per 2% Block', 'Bonded: 10% increased Life']);
  const meta = JSON.parse(fs.readFileSync(path.join(out, '_meta.json')));
  assert.deepEqual(Object.keys(meta), ['source', 'counts', 'supplements']);
  assert.deepEqual(meta.supplements.edits, { bytes: request.edits.bytes, sha256: request.edits.sha256 });
  assert.equal(meta.supplements.game_package.stat_descriptions_sha256, descriptionsSha);
  assert.deepEqual(meta.supplements.stat_lines, { corrected: [{ correction_id: 'bonded-prefix-official', rows: 1 }], supplemented: 1,
    with_origin: { agent: 2 } });
  assert.equal(JSON.stringify(meta.supplements).includes('implementation'), false);
  assert.equal(receipt.entries[0].needs_review, 'based_on differs from the pinned game package');
  assert.equal(receipt.adoption, 'not-adopted');
  assert.throws(() => createSupplementLines(request, out), /fresh repository cache candidate/);
  assert.throws(() => createSupplementLines({ ...request, edits: { ...request.edits, sha256: '0'.repeat(64) } }, `${out}-pin`), /differs from its pin/);
  assert.throws(() => createSupplementLines({ ...request, game_package: { ...request.game_package, asset: 'x.zip' } }, `${out}-asset`), /asset/);
  // Without meta and supplements the base bytes come out unchanged.
  const empty = { ...request, meta: undefined, edits: write('empty.json', JSON.stringify(doc())) };
  delete empty.meta;
  createSupplementLines(empty, `${out}-empty`);
  assert.deepEqual(fs.readFileSync(path.join(`${out}-empty`, 'stat_lines.json')), fs.readFileSync(request.base.file));
  assert.equal(fs.existsSync(path.join(`${out}-empty`, '_meta.json')), false);
});
