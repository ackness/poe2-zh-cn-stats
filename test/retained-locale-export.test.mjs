import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { exportRetainedLocale } from '../src/retained-locale-export.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const pin = b => ({ bytes: b.length, sha256: sha(b) });

test('pinned export preserves bytes and rejects mismatched identity or contents before writing', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'retained-locale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pub = path.join(root, 'pub');
  await mkdir(path.join(pub, 'i18n/zh-CN'), { recursive: true });
  await mkdir(path.join(pub, 'i18n/zh-TW'), { recursive: true });
  const target = { game: 'poe2', game_patch: '0.5.5.5', realm: 'international' };
  const catalog = Buffer.from('catalog'); const supplement = Buffer.from('reviewed');
  await writeFile(path.join(root, 'catalog'), catalog); await writeFile(path.join(root, 'reviewed'), supplement);
  const m = { schema: 'poe2-retained-locale-publication/v1', target, catalog_sha256: sha(catalog), reviewed_supplement: pin(supplement), files: {} };
  for (const locale of ['zh-CN', 'zh-TW']) {
    const filenames = locale === 'zh-CN' ? ['_meta','base_items','classes','display_texts','mods','passive_names','rare_words','skills','stat_lines','words'] : ['base_items','mods','skills'];
    for (const name of filenames) {
      const key = `i18n/${locale}/${name}.json`;
      const data = Buffer.from(name === 'display_texts' ? JSON.stringify({ schema: 'pobr-native-display-texts/v1', locale, ...target, catalog_sha256: sha(catalog) }) : JSON.stringify({ locale, name }));
      await writeFile(path.join(pub, key), data); m.files[key] = pin(data);
    }
  }
  const mb = Buffer.from(JSON.stringify(m)); await writeFile(path.join(pub, 'manifest.json'), mb);
  const args = { publication: pub, manifestSha256: sha(mb), target, locale: 'zh-CN', catalog: path.join(root, 'catalog'), reviewedSupplement: path.join(root, 'reviewed'), out: path.join(root, 'out') };
  await exportRetainedLocale(args);
  assert.deepEqual(await readFile(path.join(args.out, 'i18n/zh-CN/stat_lines.json')), await readFile(path.join(pub, 'i18n/zh-CN/stat_lines.json')));
  await exportRetainedLocale({ ...args, locale: 'zh-TW', out: path.join(root, 'tw'), catalog: undefined, reviewedSupplement: undefined });
  assert.deepEqual(await readFile(path.join(root, 'tw/i18n/zh-TW/mods.json')), await readFile(path.join(pub, 'i18n/zh-TW/mods.json')));
  for (const [n, overrides] of Object.entries({ manifest: { manifestSha256: '0'.repeat(64) }, locale: { locale: 'zh-HK' }, patch: { target: { ...target, game_patch: 'old' } }, realm: { target: { ...target, realm: 'china' } }, catalog: { catalog: path.join(root, 'reviewed') }, supplement: { reviewedSupplement: path.join(root, 'catalog') } })) {
    const out = path.join(root, `bad-${n}`); await assert.rejects(exportRetainedLocale({ ...args, ...overrides, out })); await assert.rejects(access(out));
  }
  const displayPath = 'i18n/zh-CN/display_texts.json';
  const originalDisplay = await readFile(path.join(pub, displayPath));
  const wrongDisplay = Buffer.from(JSON.stringify({ schema: 'pobr-native-display-texts/v1', locale: 'zh-TW', ...target, catalog_sha256: sha(catalog) }));
  await writeFile(path.join(pub, displayPath), wrongDisplay);
  m.files[displayPath] = pin(wrongDisplay);
  const wrongManifest = Buffer.from(JSON.stringify(m));
  await writeFile(path.join(pub, 'manifest.json'), wrongManifest);
  await assert.rejects(exportRetainedLocale({ ...args, manifestSha256: sha(wrongManifest), out: path.join(root, 'bad-display') }), /display identity mismatch/);
  await writeFile(path.join(pub, displayPath), originalDisplay);
  await writeFile(path.join(pub, 'manifest.json'), mb);
  await writeFile(path.join(pub, 'i18n/zh-TW/mods.json'), 'tampered');
  await assert.rejects(exportRetainedLocale({ ...args, locale: 'zh-TW', out: path.join(root, 'bad-file') }), /byte pin mismatch/);
});
