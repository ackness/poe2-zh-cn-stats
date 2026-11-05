import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildTemplateExport } from '../../src/trade/template-export.mjs';
import { mergeTranslations } from '../../src/legacy-translation-merge.mjs';

const aliases = [
  { src: '无法使用生命药剂', en: 'Cannot use Life Flasks' },
  { src: '非传奇生命药剂的效果持续生效', en: 'Non-Unique Life Flasks apply their Effects constantly' },
  { src: '生命药剂的回复效果无法瞬间完成', en: 'Recovery from Life Flasks cannot be Instant' },
  { src: '你的生命药剂回复效果仅对你自己生效', en: 'Recovery from your Life Flasks cannot be applied to anything other than you' },
];
const block = {
  src: aliases.map(row => row.src).join('\n'),
  en: aliases.map(row => row.en).join('\n'),
};
const source = 'https://github.com/ackness/poe2-zh-cn-stats/blob/a4bd9b5b0534d706a7b19975dae5cfa43a1d57fb/handoff/locale-retained-20261101/i18n/zh-CN/stat_lines.json#L54015-L54016';
const curated = JSON.parse(await readFile(new URL('../../curation/curated.json', import.meta.url)));
// The retained 0.5.5.4.2 stat_lines.json (tag handoff/locale-retained-20261101) is no longer in the
// tree. It is exactly the Shaman Mantle publication's stat_lines.json without the four aliases, which
// its evidence pins by SHA-256 (evidence/production-snapshots.json).
const RETAINED_SHA256 = '1d51e0a2e58bb0fe46dfde331bd004140250eeed70d4e16f683b180c06eba301';
const evidence = await readFile(new URL('../../inputs/locale-0.5.5.5/evidence/production-snapshots.json', import.meta.url), 'utf8');
const published = JSON.parse(await readFile(new URL('../../inputs/locale-0.5.5.5/i18n/zh-CN/stat_lines.json', import.meta.url)));
const aliasKeys = new Set(aliases.map(row => JSON.stringify({ src: row.src, en: row.en })));
const retained = published.filter(row => !aliasKeys.has(JSON.stringify({ src: row.src, en: row.en })));
const retainedRaw = `${JSON.stringify(retained, null, 2)}\n`;
const bundle = buildTemplateExport({ snapshot: '20261103T000000000Z', entries: [], curated });
const pair = ({ src, en }) => ({ src, en });
const key = row => JSON.stringify(pair(row));

test('the retained stat lines are the pinned 0.5.5.4.2 bytes', () => {
  assert.ok(evidence.includes(`"sha256": "${RETAINED_SHA256}"`));
  assert.equal(createHash('sha256').update(retainedRaw).digest('hex'), RETAINED_SHA256);
  assert.equal(published.length, retained.length + 4);
});

test('Shaman Mantle exports exactly four reviewed, verbatim single-line aliases with retained provenance', () => {
  const rows = bundle.templates.filter(row => row.provenance.id.startsWith('curated.shaman-mantle.'));
  assert.equal(rows.length, 4);
  assert.deepEqual(new Set(rows.map(key)), new Set(aliases.map(key)));
  assert.deepEqual(retained.filter(row => row.en === block.en), [block]);
  for (const row of rows) {
    assert.equal(row.kind, 'curated');
    assert.equal(row.provenance.source_url, source);
    assert.match(row.provenance.note, /Reviewed single-line alias/);
    assert.ok(!/[\n{}]/u.test(row.src + row.en));
  }
});

test('locale merge adds only the four aliases and preserves every retained pair and the original block', () => {
  const before = JSON.stringify(retained);
  const result = mergeTranslations(retained, bundle);
  const retainedKeys = new Set(retained.map(key));
  const added = result.pairs.filter(row => !retainedKeys.has(key(row)));
  assert.deepEqual(new Set(added.map(key)), new Set(aliases.map(key)));
  assert.equal(result.pairs.length, retained.length + 4);
  assert.deepEqual(result.pairs.filter(row => retainedKeys.has(key(row))), retained);
  assert.deepEqual(result.pairs.filter(row => row.en === block.en), [block]);
  assert.equal(JSON.stringify(retained), before);
});

test('unreviewed multiline templates remain whole and gain no implicit single-line aliases', () => {
  const unrelated = { src: '测试生命\n测试魔力', en: 'Test Life\nTest Mana' };
  const result = mergeTranslations([block, unrelated], bundle);
  assert.deepEqual(result.pairs.filter(row => row.en === unrelated.en), [unrelated]);
  assert.ok(result.pairs.every(row => !['Test Life', 'Test Mana'].includes(row.en)));
});
