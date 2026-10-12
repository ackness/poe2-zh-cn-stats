import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const USER_AGENT = 'poe2-zh-cn-stats/0.1 (+https://github.com/ackness/poe2-zh-cn-stats)';
const MAX_BYTES = 16 * 1024 * 1024;
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function download(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/json, text/html;q=0.9' },
    redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} for ${url}${response.headers.get('retry-after') ? `; Retry-After=${response.headers.get('retry-after')}` : ''}`);
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > MAX_BYTES) throw new Error(`Response exceeds ${MAX_BYTES} bytes: ${url}`);
    chunks.push(chunk);
  }
  return {
    bytes: Buffer.concat(chunks), status: response.status,
    content_type: response.headers.get('content-type'),
    last_modified: response.headers.get('last-modified'),
    etag: response.headers.get('etag'),
  };
}

function validateConfig(config) {
  if (config.trade?.en !== 'https://www.pathofexile.com/api/trade2/data/stats'
      || config.trade?.cn !== 'https://poe.game.qq.com/api/trade2/data/stats') {
    throw new Error('Trade sources must be the two official PoE2 stat catalogs');
  }
  const pages = config.poe2db?.pages;
  if (!Array.isArray(pages) || !pages.length || pages.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_-]+$/.test(p))
      || new Set(pages).size !== pages.length) throw new Error('Invalid or duplicate PoE2DB page slugs');
  const interval = config.poe2db.request_interval_ms;
  if (!Number.isInteger(interval) || interval < 1000) throw new Error('PoE2DB requests must be spaced at least 1000ms apart');
}

function requireCatalog(value, source) {
  if (!Array.isArray(value?.result) || !value.result.some(group =>
    group?.id !== 'pseudo' && Array.isArray(group?.entries) && group.entries.length > 0)) {
    throw new Error(`Empty or invalid non-pseudo stat catalog: ${source}`);
  }
}

// No automatic retries, credentials, challenge handling, or undocumented endpoints.
// Mandatory trade failures abort the candidate. Supplemental failures are receipts,
// never permission to silently relabel old data as a fresh download.
export async function fetchSnapshot(root, { tradeOnly = false, log = console.log } = {}) {
  const configText = await readFile(path.join(root, 'sources.json'), 'utf8');
  const config = JSON.parse(configText);
  validateConfig(config);
  const started = new Date().toISOString();
  const id = started.replace(/[-:.]/g, '');
  const directory = path.join(root, '.cache', `candidate-${id}`);
  await mkdir(path.join(directory, 'raw'), { recursive: true });
  const manifest = {
    schema_version: 1, id, captured_at: started,
    game_patch: null,
    note: 'HTTP Last-Modified is not a game patch version. Sources can be on different patches.',
    config_sha256: sha256(configText), config, sources: [], pages: [], errors: [],
  };
  async function capture(key, url, kind) {
    log(`GET ${url}`);
    const { bytes, ...headers } = await download(url);
    if (kind === 'json') {
      const value = JSON.parse(bytes.toString('utf8'));
      requireCatalog(value, key);
    }
    const file = `raw/${key}.${kind}.gz`;
    await writeFile(path.join(directory, file), gzipSync(bytes, { level: 9 }));
    manifest.sources.push({ key, url, file, fetched_at: new Date().toISOString(),
      sha256: sha256(bytes), bytes: bytes.length, ...headers });
  }
  try {
    await capture('trade-en', config.trade.en, 'json');
    await capture('trade-cn', config.trade.cn, 'json');
    if (!tradeOnly) {
      const robotsUrl = 'https://poe2db.tw/robots.txt';
      let canFetch = false;
      try {
        await capture('poe2db-robots', robotsUrl, 'txt');
        const robotsSource = manifest.sources.find(s => s.key === 'poe2db-robots');
        const robots = gunzipSync(await readFile(path.join(directory, robotsSource.file))).toString('utf8');
        // Pin the reviewed policy rather than interpreting changed robots rules
        // permissively. A policy change requires maintainer review.
        const rules = robots.split(/\r?\n/).map(l => l.replace(/#.*/, '').trim()).filter(Boolean);
        if (JSON.stringify(rules) !== JSON.stringify(['User-agent: *', 'Disallow: /*/marked', 'Disallow: /*/markdown_history'])) {
          throw new Error('PoE2DB robots policy changed; review it before fetching pages');
        }
        canFetch = true;
      } catch (error) {
        manifest.errors.push({ source: 'poe2db', url: robotsUrl, error: error.message });
      }
      if (canFetch) for (const slug of config.poe2db.pages) {
        const page = { slug, en: null, cn: null };
        for (const locale of ['en', 'cn']) {
          await delay(config.poe2db.request_interval_ms);
          const key = `poe2db-${slug}-${locale}`;
          const url = `https://poe2db.tw/${locale === 'en' ? 'us' : 'cn'}/${slug}`;
          try {
            await capture(key, url, 'html');
            page[locale] = key;
          } catch (error) {
            manifest.errors.push({ source: 'poe2db', url, error: error.message });
            // Stop on a denied/rate-limited request; do not rotate hosts or headers.
            if (/HTTP (401|403|429)\b/.test(error.message)) canFetch = false;
          }
          if (!canFetch) break;
        }
        manifest.pages.push(page);
        if (!canFetch) break;
      }
    }
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { directory, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readSnapshot(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.sources) || !Array.isArray(manifest.pages)
      || !/^[0-9TZ]+$/.test(manifest.id)) throw new Error('Invalid snapshot manifest');
  const contents = new Map();
  for (const source of manifest.sources) {
    if (!/^raw\/[A-Za-z0-9_-]+\.(json|html|txt)\.gz$/.test(source.file) || contents.has(source.key)) {
      throw new Error(`Invalid or duplicate source: ${source.key}`);
    }
    const bytes = gunzipSync(await readFile(path.join(directory, source.file)), { maxOutputLength: MAX_BYTES });
    if (sha256(bytes) !== source.sha256 || bytes.length !== source.bytes) throw new Error(`Source checksum mismatch: ${source.key}`);
    contents.set(source.key, bytes.toString('utf8'));
  }
  if (!contents.has('trade-en') || !contents.has('trade-cn')) throw new Error('Both official trade sources are required');
  for (const key of ['trade-en', 'trade-cn']) requireCatalog(JSON.parse(contents.get(key)), key);
  return { manifest, contents };
}

// Published snapshots are immutable. Rebuild into a new candidate, then switch
// CURRENT only after every artifact has passed verification.
export async function cloneCandidate(root, directory) {
  const { manifest } = await readSnapshot(directory);
  const rebuiltAt = new Date().toISOString();
  const id = rebuiltAt.replace(/[-:.]/g, '');
  const candidate = path.join(root, '.cache', `candidate-${id}`);
  await mkdir(path.join(root, '.cache'), { recursive: true });
  await mkdir(candidate);
  await cp(path.join(directory, 'raw'), path.join(candidate, 'raw'), { recursive: true });
  const rebuilt = { ...manifest, id, rebuilt_at: rebuiltAt, rebuilt_from: manifest.id };
  await writeFile(path.join(candidate, 'manifest.json'), JSON.stringify(rebuilt, null, 2) + '\n');
  return { directory: candidate, manifest: rebuilt };
}

export async function activateSnapshot(root, candidate, id) {
  if (!/^[0-9TZ]+$/.test(id)) throw new Error('Invalid snapshot ID');
  const snapshots = path.join(root, 'data', 'snapshots');
  await mkdir(snapshots, { recursive: true });
  await rename(candidate, path.join(snapshots, id));
  const pointer = path.join(root, 'data', `.CURRENT-${id}`);
  await writeFile(pointer, id + '\n');
  await rename(pointer, path.join(root, 'data', 'CURRENT'));
}

export async function currentSnapshot(root) {
  const id = (await readFile(path.join(root, 'data', 'CURRENT'), 'utf8')).trim();
  if (!/^[0-9TZ]+$/.test(id)) throw new Error('Invalid data/CURRENT');
  return path.join(root, 'data', 'snapshots', id);
}
