import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDisplayTexts, projectDisplayTexts } from '../../src/pobr/display-texts.mjs';
import { entryId, monsterTargets } from '../../src/pobr/display-supplements.mjs';
import { gemTargets, markupProblem, pairOfficialTables, readOfficialTables } from '../../src/pobr/official-tables.mjs';
import { storedZip } from '../../src/release/stored-zip.mjs';
import { tablePackage } from './official-fixture.mjs';

const GEMS = { _meta: { schema: 'repoe-gem-descriptions/v1', game_patch: '9.9' }, scopes: {
  'GemEffects.SupportText': { A: 'Supports [Fire|fire] Skills ', B: 'English B', C: 'English C', D: 'English D', E: 'New English',
    G: 'Never localized' },
  'ActiveSkills.Description': { Bolt: 'Fires a [Bolt]' } } };
const TABLES = {
  GemEffects: { A: ['Supports [Fire|fire] Skills ', '辅助[Fire|火焰]技能 '], B: ['English B', 'English B'], C: ['English C', ''],
    D: ['English D', 'Deutsch'], E: ['Old English', '旧文'], F: ['Removed', '移除'], G: ['Never localized', undefined] },
  ActiveSkills: { Bolt: ['Fires a [Bolt]', '发射一道[Bolt|闪电]'] },
};
const targets = () => new Map([...gemTargets(GEMS, '9.9')]);
const counts = values => ({ adopted: 0, shadowed: 0, 'not-in-game': 0, 'ambiguous-target': 0, 'ambiguous-id': 0, 'no-default-row': 0,
  'english-differs': 0, untranslated: 0, 'no-han': 0, 'broken-markup': 0, ...values });

test('official tables: only the localized row whose English is the game English ships, raw and never as null', () => {
  const { zip, spec } = tablePackage({ tables: TABLES });
  const source = readOfficialTables(zip, spec, 'zh-CN');
  assert.equal(source.source.realm, 'china');
  assert.equal(source.source.localized.source_identity.language, 'Simplified Chinese');
  const paired = pairOfficialTables([source], targets());
  // Markup and the trailing space stay as the client has them; the consumer renders [A|B].
  assert.deepEqual(Object.fromEntries(paired.scopes.get('GemEffects.SupportText')),
    { A: ['Supports [Fire|fire] Skills ', '辅助[Fire|火焰]技能 '] });
  assert.deepEqual(Object.fromEntries(paired.scopes.get('ActiveSkills.Description')), { Bolt: ['Fires a [Bolt]', '发射一道[Bolt|闪电]'] });
  assert.deepEqual(paired.counts[0]['GemEffects.SupportText'],
    counts({ adopted: 1, untranslated: 2, 'no-han': 1, 'english-differs': 1, 'not-in-game': 1 }));
  // B, C, D, E and G are omitted (no null): PoBR falls back for them.
  assert.equal(paired.missing['GemEffects.SupportText'], 5);
  // An older source fills only ids the newer one did not adopt.
  const older = tablePackage({ tables: { GemEffects: { E: ['New English', '新文'], A: ['Supports [Fire|fire] Skills ', '旧辅助'] } }, tag: 'inputs/9.8-1' });
  const both = pairOfficialTables([source, readOfficialTables(older.zip, older.spec, 'zh-CN')], targets());
  assert.deepEqual(Object.fromEntries(both.scopes.get('GemEffects.SupportText')),
    { A: ['Supports [Fire|fire] Skills ', '辅助[Fire|火焰]技能 '], E: ['New English', '新文'] });
  assert.deepEqual(both.counts[1]['GemEffects.SupportText'], counts({ adopted: 1, shadowed: 1 }));
  // A new markup form in the English fails loudly instead of shipping.
  assert.equal(markupProblem('a [b|c] [d]'), null);
  assert.equal(markupProblem('a [b|c'), 'unmatched-bracket');
  assert.equal(markupProblem('a ]b['), 'unmatched-bracket');
  assert.equal(markupProblem('[a [b]]'), 'nested-bracket');
  // Only [A] and [A|B] with a non-empty key: a third part, [] and [|B] are broken too.
  assert.equal(markupProblem('[Projectile|Projectiles|投射物]'), 'extra-separator');
  assert.equal(markupProblem('a [] b'), 'empty-key');
  assert.equal(markupProblem('a [|b] c'), 'empty-key');
  assert.equal(markupProblem('[Flask|]'), null);
  const brokenEnglish = tablePackage({ tables: { GemEffects: { A: ['Supports [Fire|fire Skills ', '辅助[Fire|火焰]技能'] } } });
  assert.throws(() => pairOfficialTables([readOfficialTables(brokenEnglish.zip, brokenEnglish.spec, 'zh-CN')],
    new Map([['GemEffects.SupportText', new Map([['A', 'Supports [Fire|fire Skills ']])]])), /A has unmatched-bracket markup in its English/u);
  // A localized value that breaks the markup (a client typo) is omitted, not shipped, and an older
  // source may still fill the id.
  const broken = tablePackage({ tables: { GemEffects: { A: ['Supports [Fire|fire] Skills ', '辅助[Fire|火焰技能'] } } });
  const omitted = pairOfficialTables([readOfficialTables(broken.zip, broken.spec, 'zh-CN'), readOfficialTables(older.zip, older.spec, 'zh-CN')], targets());
  assert.deepEqual(omitted.counts[0]['GemEffects.SupportText'], counts({ 'broken-markup': 1 }));
  assert.deepEqual(Object.fromEntries(omitted.scopes.get('GemEffects.SupportText')),
    { A: ['Supports [Fire|fire] Skills ', '旧辅助'], E: ['New English', '新文'] });
  // The three-part form of the zh-TW frost_darts text is omitted the same way; in the English it throws.
  const threePart = tablePackage({ tables: { GemEffects: { A: ['Supports [Fire|fire] Skills ', '[Projectile|Projectiles|投射物]辅助'],
    E: ['New English', '新文'] } } });
  const dropped = pairOfficialTables([readOfficialTables(threePart.zip, threePart.spec, 'zh-CN')], targets());
  assert.deepEqual(dropped.counts[0]['GemEffects.SupportText'], counts({ adopted: 1, 'broken-markup': 1 }));
  assert.deepEqual(Object.fromEntries(dropped.scopes.get('GemEffects.SupportText')), { E: ['New English', '新文'] });
  const threeEnglish = tablePackage({ tables: { GemEffects: { A: ['Supports [Fire|fire|blaze] Skills ', '辅助[Fire|火焰]技能'] } } });
  assert.throws(() => pairOfficialTables([readOfficialTables(threeEnglish.zip, threeEnglish.spec, 'zh-CN')],
    new Map([['GemEffects.SupportText', new Map([['A', 'Supports [Fire|fire|blaze] Skills ']])]])), /A has extra-separator markup in its English/u);
  // A scope with no target English cannot be decided.
  assert.throws(() => pairOfficialTables([source], new Map()), /no target English for GemEffects\.SupportText/u);
  // A localized row with no default row, and an Id the default table repeats.
  const scope = 'GemEffects.SupportText';
  const direct = (english, localized) => ({ scopes: new Map([[scope, { english: new Map(english), localized: new Map(localized) }]]) });
  const edge = pairOfficialTables([direct([['A', 'Supports [Fire|fire] Skills '], ['C', undefined]],
    [['A', '辅助'], ['B', '乙'], ['C', '丙']])], targets());
  assert.deepEqual(edge.counts[0][scope], counts({ adopted: 1, 'no-default-row': 1, 'ambiguous-id': 1 }));
  // A scope that adopts nothing would silently drop every catalog row it owns: refused.
  assert.throws(() => pairOfficialTables([direct([['B', 'English B']], [['B', 'English B']])], targets()),
    /GemEffects\.SupportText adopts no row/u);
});

test('official tables: realm and language follow the locale; the package shape is pinned', () => {
  const tables = { MonsterVarieties: { Wolf: ['Wolf', '狼'] } };
  const intl = tablePackage({ tables, realm: 'international' });
  assert.throws(() => readOfficialTables(intl.zip, intl.spec, 'zh-CN'), /is realm international; official zh-CN needs realm china/u);
  const china = tablePackage({ tables, language: 'Traditional Chinese', localizedDir: 'display-tables/traditional-chinese/' });
  assert.throws(() => readOfficialTables(china.zip, china.spec, 'zh-TW'), /is realm china; official zh-TW needs realm international/u);
  const wrongLanguage = tablePackage({ tables, language: 'Traditional Chinese' });
  assert.throws(() => readOfficialTables(wrongLanguage.zip, wrongLanguage.spec, 'zh-CN'), /is Traditional Chinese, not Simplified Chinese/u);
  const mixed = tablePackage({ tables, defaultRealm: 'international' });
  assert.throws(() => readOfficialTables(mixed.zip, mixed.spec, 'zh-CN'), /must be the default \(English\) tables of the same realm/u);
  const { zip, spec } = tablePackage({ tables });
  assert.throws(() => readOfficialTables(zip, { ...spec, localized_manifest_sha256: '0'.repeat(64) }, 'zh-CN'),
    /differs from the pinned localized_manifest_sha256/u);
  const extra = tablePackage({ tables, extra: { 'display-tables/default/stray.json': Buffer.from('{}') } });
  assert.throws(() => readOfficialTables(extra.zip, extra.spec, 'zh-CN'), /must hold manifest\.json and exactly the files it pins/u);
  assert.throws(() => readOfficialTables(zip, spec, 'en'), /no official table source for en/u);
  // Both sides come from one client capture: the same game_patch and source lock.
  for (const localizedIdentity of [{ game_patch: '9.8' }, { source_lock_sha256: 'e'.repeat(64) }]) {
    const other = tablePackage({ tables, localizedIdentity });
    assert.throws(() => readOfficialTables(other.zip, other.spec, 'zh-CN'), /must share one game_patch and source_lock_sha256/u);
  }
});

const BASED_ON = { game_patch: '9.9', game_package: { repository: 'ackness/repoe', tag: 'game/9.9-1', sha256: 'c'.repeat(64) },
  stat_descriptions_sha256: 'd'.repeat(64) };
const ours = (english, ids, locale = 'zh-CN') => {
  const identity = { game: 'poe2', realm: 'international', locale, kind: 'monster-name', table: 'MonsterVarieties', field: 'Name', english };
  return { entry_id: entryId(identity), identity, ids, based_on: BASED_ON, text: '我们的狼', origin: 'agent', basis: 'own',
    author: 'claude-haiku-4-5', note: '意译', status: 'reviewed', review: { by: 'claude-opus-5-5', note: 'checked' } };
};

test('a scope official tables hold is theirs: catalog rows keep literals but no per-ID row; table names supersede ours', () => {
  const record = (id, english, localized) => ({ table: 'ActiveSkills', field: 'Description', id, english, localized,
    templates: { english: { syntax_valid: true, placeholders: [], hash_slots: 0 } } });
  const records = [record('Bolt', 'Fires a [Bolt]', '旧的闪电'), record('Other', 'Other text', '其他')];
  const lookup = query => {
    const match = records.find(row => row.id === query.id);
    return { status: 'translated', text: match.localized };
  };
  const tables = { scopes: new Map([['ActiveSkills.Description', new Map([['Bolt', ['Fires a [Bolt]', '发射一道[Bolt|闪电]']]])],
    ['MonsterVarieties.Name', new Map([['Metadata/Wolf', ['Wolf', '恶狼']]])]]) };
  const projection = { scopes: ['ActiveSkills.Description', 'MonsterVarieties.Name'], literals: 'all-catalog-conflict-participants' };
  const game = { sha256: 'c'.repeat(64), targets: new Map([['Metadata/Wolf', 'Wolf'], ['Metadata/Wolf2', 'Wolf']]) };
  const names = { schema: 'poe2-display-supplements/v1', corrections: [], entries: [ours('Wolf', ['Metadata/Wolf', 'Metadata/Wolf2'])] };
  const result = projectDisplayTexts({ game_patch: '9.9', realm: 'international', locale: 'zh-CN', records }, lookup, 'a'.repeat(64),
    projection, { tables, names, game, packageTexts: new Map() });
  assert.deepEqual(result.sidecar.scopes, {
    'ActiveSkills.Description': { Bolt: ['Fires a [Bolt]', '发射一道[Bolt|闪电]'] },
    'MonsterVarieties.Name': { 'Metadata/Wolf': ['Wolf', '恶狼'] },
  });
  assert.equal(result.owned_catalog_rows, 2);
  // The catalog still supplies literal entries for those English strings.
  assert.equal(result.sidecar.entries['Other text'], '其他');
  // Our Wolf is superseded for the id the table names, and skipped elsewhere: an official name has its English.
  assert.deepEqual(result.names.entries[0].ids.map(row => [row.id, row.lifecycle]),
    [['Metadata/Wolf', 'superseded'], ['Metadata/Wolf2', 'official-elsewhere']]);
  assert.equal(Object.hasOwn(result.sidecar, 'origins'), false);
  assert.throws(() => projectDisplayTexts({ game_patch: '9.9', realm: 'international', locale: 'zh-CN', records }, lookup, 'a'.repeat(64),
    { ...projection, scopes: ['ActiveSkills.Description'] }, { tables, game }), /MonsterVarieties\.Name is not in projection\.scopes/u);
  // Our catalog value never ships as a literal beside an adopted official table row of the same English.
  const nova = [...records, record('Nova', 'Casts a nova', '我们的新星')];
  const ownLookup = query => query.id === 'Nova' ? { status: 'translated', text: '我们的新星', origin: 'agent' } : lookup(query);
  const novaTables = { scopes: new Map([['ActiveSkills.Description', new Map([...tables.scopes.get('ActiveSkills.Description'),
    ['Nova', ['Casts a nova', '释放新星']]])]]) };
  const masked = projectDisplayTexts({ game_patch: '9.9', realm: 'international', locale: 'zh-CN', records: nova }, ownLookup, 'a'.repeat(64),
    projection, { tables: novaTables, packageTexts: new Map() });
  assert.equal(masked.sidecar.entries['Casts a nova'], null);
  assert.deepEqual(masked.sidecar.scopes['ActiveSkills.Description'].Nova, ['Casts a nova', '释放新星']);
  assert.deepEqual(masked.skipped.map(row => [row.english, row.source, row.official]), [['Casts a nova', 'official-tables', '释放新星']]);
  assert.equal(Object.hasOwn(masked.sidecar, 'origins'), false);
  assert.throws(() => projectDisplayTexts({ game_patch: '9.9', realm: 'international', locale: 'zh-CN', records }, lookup, 'a'.repeat(64),
    projection, { tables, game, official: { format: 'x', names: {} } }), /from official_names or official_tables, not both/u);
});

function cache(t) {
  const root = fileURLToPath(new URL('../../.cache/', import.meta.url));
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'official-tables-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const write = (name, raw) => {
    fs.writeFileSync(path.join(dir, name), raw);
    return { file: path.join(dir, name), bytes: Buffer.byteLength(raw), sha256: createHash('sha256').update(raw).digest('hex') };
  };
  return { dir, write };
}

test('createDisplayTexts without a catalog (zh-TW): scopes only from official tables, catalog_sha256 the localized manifest', async t => {
  const { dir, write } = cache(t);
  const game = storedZip({
    'data/9.9/overlay/gem_descriptions.json': Buffer.from(JSON.stringify(GEMS)),
    'data/9.9/overlay/minions.json': Buffer.from(JSON.stringify({ minions: [{ id: 'WolfMinion', monster_variety_id: 'Metadata/Wolf', name: 'Wolf' }] })),
    'data/9.9/overlay/spectres.json': Buffer.from(JSON.stringify({ minions: [{ id: 'Metadata/Bear', name: 'Bear' }] })),
  });
  const tc = tablePackage({ realm: 'international', language: 'Traditional Chinese', localizedDir: 'display-tables/traditional-chinese/',
    tables: { ...TABLES, MonsterVarieties: { 'Metadata/Wolf': ['Wolf', '狼盟友'], 'Metadata/Bear': ['Bear', ''] } } });
  const request = {
    schema: 'pobr-native-display-texts-request/v1', game_patch: '9.9', realm: 'international', locale: 'zh-TW',
    projection: { scopes: ['ActiveSkills.Description', 'GemEffects.SupportText', 'MonsterVarieties.Name'], literals: 'all-catalog-conflict-participants' },
    game_package: { ...write('pobr-game-9.9.zip', game), repository: 'ackness/repoe', tag: 'game/9.9-1', asset: 'pobr-game-9.9.zip' },
    official_tables: [{ ...write(tc.spec.asset, tc.zip), ...tc.spec }],
  };
  const receipt = await createDisplayTexts(request, path.join(dir, 'out'));
  const raw = fs.readFileSync(path.join(dir, 'out', 'display_texts.json'), 'utf8');
  const sidecar = JSON.parse(raw);
  assert.deepEqual(sidecar, { schema: 'pobr-native-display-texts/v1', game_patch: '9.9', realm: 'international', locale: 'zh-TW',
    catalog_sha256: tc.spec.localized_manifest_sha256, entries: {}, scopes: {
      'ActiveSkills.Description': { Bolt: ['Fires a [Bolt]', '发射一道[Bolt|闪电]'] },
      'GemEffects.SupportText': { A: ['Supports [Fire|fire] Skills ', '辅助[Fire|火焰]技能 '] },
      'MonsterVarieties.Name': { 'Metadata/Wolf': ['Wolf', '狼盟友'] } } });
  assert.equal(raw.includes('null'), false);
  assert.deepEqual(receipt.official_tables.adopted, { 'GemEffects.SupportText': 1, 'ActiveSkills.Description': 1, 'MonsterVarieties.Name': 1 });
  assert.equal(receipt.official_tables.sources[0].counts['MonsterVarieties.Name'].untranslated, 1);
  assert.equal(receipt.official_tables.sources[0].localized.source_identity.realm, 'international');
  assert.equal(receipt.library, null);
  assert.deepEqual(receipt.decisions, []);
  // English [0] is the game's: the same in every locale that ships the id.
  assert.equal(sidecar.scopes['GemEffects.SupportText'].A[0], GEMS.scopes['GemEffects.SupportText'].A);
  // Refusals: a supplement without a catalog, an unpinned source, the wrong realm for the locale.
  await assert.rejects(createDisplayTexts({ ...request, supplement: {} }, path.join(dir, 'out-supplement')), /without a catalog needs official_tables/u);
  await assert.rejects(createDisplayTexts({ ...request, official_tables: undefined }, path.join(dir, 'out-none')), /without a catalog needs official_tables/u);
  await assert.rejects(createDisplayTexts({ ...request, official_tables: [{ ...request.official_tables[0], sha256: '0'.repeat(64) }] },
    path.join(dir, 'out-pin')), /SHA256 mismatch/u);
  await assert.rejects(createDisplayTexts({ ...request, locale: 'zh-CN' }, path.join(dir, 'out-cn')), /is Traditional Chinese, not Simplified Chinese/u);
  await assert.rejects(createDisplayTexts({ ...request, game_package: undefined }, path.join(dir, 'out-game')), /need game_package/u);
  // A table package of another patch than the request.
  const old = tablePackage({ realm: 'international', language: 'Traditional Chinese', localizedDir: 'display-tables/traditional-chinese/',
    tables: TABLES, gamePatch: '9.8' });
  await assert.rejects(createDisplayTexts({ ...request, official_tables: [{ ...write('old.zip', old.zip), ...old.spec }] },
    path.join(dir, 'out-patch')), /is game_patch 9\.8, not 9\.9/u);
  await assert.rejects(createDisplayTexts({ ...request, official_tables: [{ ...request.official_tables[0], scopes: ['Mods.Name'] }] },
    path.join(dir, 'out-scope')), /scopes lists distinct scopes of/u);
});

test('gem targets come from a repoe-gem-descriptions/v1 member for the same patch', () => {
  assert.equal(gemTargets(GEMS, '9.9').get('GemEffects.SupportText').get('B'), 'English B');
  assert.throws(() => gemTargets({ ...GEMS, _meta: { schema: 'other' } }, '9.9'), /is not repoe-gem-descriptions\/v1/u);
  assert.throws(() => gemTargets(GEMS, '9.8'), /gem_descriptions\.json is for 9\.9/u);
  // A gem scope missing from the member is an error, not an empty scope.
  assert.throws(() => gemTargets({ ...GEMS, scopes: { 'GemEffects.SupportText': {} } }, '9.9'), /ActiveSkills\.Description maps id -> English/u);
  assert.deepEqual(monsterTargets({ minions: [] }, { minions: [] }), new Map());
});
