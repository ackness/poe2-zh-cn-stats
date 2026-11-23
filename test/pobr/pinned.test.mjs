import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEX64, parseRequiredArgs, pinOf, readPinned, readPinnedJson, sha256 } from '../../src/pobr/pinned.mjs';

test('sha256 and pinOf hash raw bytes consistently', () => {
  const raw = Buffer.from('{"ok":true}\n');
  const pin = pinOf(raw);
  assert.equal(pin.bytes, raw.length);
  assert.equal(pin.sha256, sha256(raw));
  assert.match(pin.sha256, HEX64);
});

test('readPinned and readPinnedJson verify size, bounds, symlinks and SHA-256', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pobr-pinned-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data.json');
  const raw = Buffer.from('{"a":1}\n');
  fs.writeFileSync(file, raw);
  const pin = pinOf(raw);

  assert.deepEqual(readPinned(file, pin.sha256, { bytes: pin.bytes, rejectSymlinkPath: true }), raw);
  assert.deepEqual(readPinnedJson(file, pin.sha256, { kind: 'Test input' }), { a: 1 });

  assert.throws(() => readPinned(file, 'not-a-hash'), /Missing external SHA256/);
  assert.throws(() => readPinned(file, pin.sha256, { bytes: -1 }), /Invalid declared input size/);
  assert.throws(() => readPinned(file, pin.sha256, { bytes: pin.bytes + 1 }), /size differs/);
  assert.throws(() => readPinned(file, '0'.repeat(64)), /SHA256 mismatch/);
  assert.throws(() => readPinned(file, '0'.repeat(64), { bytes: pin.bytes, label: 'edits' }), /edits: .* differs from its pin/);
  assert.throws(() => readPinned(file, pin.sha256, { bytes: pin.bytes + 1, label: 'edits' }), /edits: .* differs from its pin/);
  assert.throws(() => readPinned(file, pin.sha256, { maxBytes: raw.length - 1, kind: 'Test input' }), /bounded regular file/);

  const dirLink = path.join(root, 'dir-link');
  fs.mkdirSync(path.join(root, 'real-dir'));
  fs.writeFileSync(path.join(root, 'real-dir', 'data.json'), raw);
  fs.symlinkSync(path.join(root, 'real-dir'), dirLink);
  assert.throws(() => readPinned(path.join(dirLink, 'data.json'), pin.sha256, { rejectSymlinkPath: true }), /contains a symlink/);

  const fileLink = path.join(root, 'file-link.json');
  fs.symlinkSync(file, fileLink);
  assert.throws(() => readPinned(fileLink, pin.sha256), /ELOOP/);
});

test('parseRequiredArgs accepts exact flags in any order and rejects unknown, duplicate, empty or missing flags', () => {
  const flags = ['request', 'out'];
  const messages = { invalidMessage: 'bad flag', missingMessage: 'missing flag' };
  assert.deepEqual(parseRequiredArgs(['--out', '.cache/a', '--request', 'r.json'], flags, messages), { request: 'r.json', out: '.cache/a' });
  assert.deepEqual(parseRequiredArgs(['--request=r.json', '--out=.cache/a'], flags, messages), { request: 'r.json', out: '.cache/a' });
  assert.throws(() => parseRequiredArgs(['--request', 'r.json'], flags, messages), /missing flag/);
  assert.throws(() => parseRequiredArgs(['--request', 'r.json', '--out', 'a', '--out', 'b'], flags, messages), /bad flag/);
  assert.throws(() => parseRequiredArgs(['--request', '', '--out', 'a'], flags, messages), /bad flag/);
  assert.throws(() => parseRequiredArgs(['--request', 'r.json', '--out', 'a', '--extra', '1'], flags, messages), /bad flag/);
  assert.throws(() => parseRequiredArgs(['--request', 'r.json', '--out', 'a', 'pos'], flags, messages), /bad flag/);
});
