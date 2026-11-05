// Shared synthetic checkout for the release:build / release:publish tests (no tests of its own).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CODE, ROOT, pin } from '../src/locale-release.mjs';

export const TARGET = { game: 'poe2', game_patch: '9.9', realm: 'international' };
export const SOURCE_DIR = 'inputs/locale-test';
export const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

export const SOURCE_FILES = {
  'i18n/zh-CN/stat_lines.json': Buffer.from('{"a":"甲"}\n'),
  'i18n/zh-CN/_meta.json': Buffer.from('{"lang":"zh-CN"}\n'),
  'i18n/zh-TW/mods.json': Buffer.from('{"m":"乙"}'), // no final newline: bytes must pass through untouched
  'evidence/receipt.json': Buffer.from('{"evidence":true}\n'),
};

const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Synthetic fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Synthetic fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_NOSYSTEM: '1' };

export function gitIn(repo, ...args) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-C', repo, ...args],
    { env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function sourceManifest(files = SOURCE_FILES, target = TARGET) {
  return bytes({ schema: 'poe2-retained-locale-publication/v1', target,
    files: Object.fromEntries(Object.entries(files).map(([name, raw]) => [name, pin(raw)])) });
}

export function config(manifestRaw, extra = {}) {
  return { schema: 'poe2-locale-release-config/v1', target: TARGET,
    source: { manifest: { path: `${SOURCE_DIR}/manifest.json`, ...pin(manifestRaw) },
      origin: { repository: 'ackness/poe2-zh-cn-stats', tag: 'handoff/test', revision: 'f'.repeat(40) } }, ...extra };
}

export function write(repo, name, raw) {
  mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
  writeFileSync(path.join(repo, name), raw);
}

// A committed checkout with a bare `origin` whose main has the commit.
export function fixture(label = 'locale-release') {
  mkdirSync(path.join(ROOT, '.cache'), { recursive: true });
  const root = mkdtempSync(path.join(ROOT, '.cache', `${label}-test-`));
  const origin = path.join(root, 'origin.git'), repo = path.join(root, 'repo');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin], { env: ENV });
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: ENV });
  gitIn(repo, 'remote', 'add', 'origin', origin);
  for (const name of CODE) {
    mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    copyFileSync(path.join(ROOT, name), path.join(repo, name));
  }
  write(repo, '.gitignore', '.cache/\n');
  for (const [name, raw] of Object.entries(SOURCE_FILES)) write(repo, `${SOURCE_DIR}/${name}`, raw);
  const manifestRaw = sourceManifest();
  write(repo, `${SOURCE_DIR}/manifest.json`, manifestRaw);
  write(repo, `${SOURCE_DIR}/README.md`, 'synthetic\n');
  write(repo, 'release/9.9.json', bytes(config(manifestRaw)));
  const commit = commitAll(repo, 'synthetic publication');
  gitIn(repo, 'push', '-q', 'origin', 'main');
  gitIn(repo, 'fetch', '-q', 'origin');
  return { root, origin, repo, commit, manifestRaw };
}

export function commitAll(repo, message) {
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return gitIn(repo, 'rev-parse', 'HEAD');
}
