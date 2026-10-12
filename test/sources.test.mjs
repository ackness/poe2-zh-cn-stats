import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { readSnapshot, sha256 } from '../src/sources.mjs';
import { writeGenerated } from '../src/snapshot.mjs';

async function sourceFixture(t, cn) {
  const root = await mkdtemp(path.join(tmpdir(), 'poe2-stats-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'data', 'snapshots', '20260101T000000000Z');
  await mkdir(path.join(directory, 'raw'), { recursive: true });
  const manifest = { schema_version: 1, id: '20260101T000000000Z', sources: [], pages: [], errors: [] };
  for (const [key, data] of [['trade-en', { result: [{ id: 'explicit', label: 'Explicit', entries: [{ id: 'explicit.stat_1', text: '# to maximum Life' }] }] }], ['trade-cn', cn]]) {
    const raw = JSON.stringify(data);
    const file = `raw/${key}.json.gz`;
    await writeFile(path.join(directory, file), gzipSync(raw));
    manifest.sources.push({ key, file, sha256: sha256(raw), bytes: Buffer.byteLength(raw) });
  }
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
  return directory;
}

test('a mandatory catalog with empty actual groups cannot become a valid snapshot', async t => {
  const directory = await sourceFixture(t, { result: [{ id: 'explicit', label: '外延', entries: [] }] });
  await assert.rejects(readSnapshot(directory), /empty|non-pseudo/i);
});

test('published generated files cannot be replaced one at a time', async t => {
  const directory = await sourceFixture(t, { result: [{ id: 'explicit', label: '外延', entries: [{ id: 'explicit.stat_1', text: '# 生命上限' }] }] });
  await mkdir(path.join(directory, 'generated'));
  await writeFile(path.join(directory, 'generated', 'dictionary.json'), 'published revision');
  await assert.rejects(writeGenerated(directory, new Map([['dictionary.json', 'partial new revision']])), /candidate|published/i);
  assert.equal(await readFile(path.join(directory, 'generated', 'dictionary.json'), 'utf8'), 'published revision');
});
