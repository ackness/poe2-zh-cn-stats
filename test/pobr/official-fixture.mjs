// A synthetic RePoE input package (repoe-release-input/v1) holding the synthetic native descriptions
// fixture under stat-descriptions/china/, resealed as realm china (only the lock and manifest change;
// the frozen reader verifies the result like any package). No acquired game rows.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { nativeBytes } from '../../src/native-localization.mjs';
import { storedZip } from '../../src/release/stored-zip.mjs';

const FIXTURE = new URL('../fixtures/native-descriptions/', import.meta.url);
const NAMES = ['descriptions.json', 'diagnostics.json', 'manifest.json', 'source-lock.json'];
export const MEMBER = 'stat-descriptions/china/';
const sha = raw => createHash('sha256').update(raw).digest('hex');
const pin = raw => ({ bytes: raw.length, sha256: sha(raw) });

// The four native files, resealed for `realm` (and with `evidence` as the acquisition evidence).
export function nativeFiles(realm = 'china', evidence = null) {
  const files = Object.fromEntries(NAMES.map(name => [name, readFileSync(new URL(name, FIXTURE))]));
  if (realm === 'international' && !evidence) return files;
  const lock = JSON.parse(files['source-lock.json']);
  lock.sources.synthetic.realm = realm;
  if (evidence) lock.sources.synthetic.acquisition.evidence = evidence;
  const lockRaw = nativeBytes(lock);
  const manifest = JSON.parse(files['manifest.json']);
  Object.assign(manifest.source_identity, { realm, acquisition: lock.sources.synthetic.acquisition, selected_source_sha256: sha(nativeBytes(lock.sources.synthetic)),
    source_lock_sha256: sha(lockRaw) });
  manifest.files['source-lock.json'] = pin(lockRaw);
  return { ...files, 'source-lock.json': lockRaw, 'manifest.json': nativeBytes(manifest) };
}

// {zip, spec}: the input package and its official-source pin. `files` overrides member files
// (null drops one), `extra` adds archive members, `root` edits the root manifest's file pins, and
// `receipt` adds capture/capture-receipt.json, pinned by the lock's client-capture-receipt evidence.
export function chinaPackage({ realm = 'china', files = {}, extra = {}, root = pins => pins, tag = 'inputs/9.9-1', receipt = null } = {}) {
  const receiptRaw = receipt ? Buffer.from(JSON.stringify(receipt)) : null;
  const evidence = receiptRaw ? [{ kind: 'client-capture-receipt', sha256: sha(receiptRaw) }] : null;
  const native = { ...nativeFiles(realm, evidence), ...files };
  const members = { ...extra, ...(receiptRaw ? { 'capture/capture-receipt.json': receiptRaw } : {}) };
  for (const [name, raw] of Object.entries(native)) if (raw) members[MEMBER + name] = raw;
  const pins = root(Object.fromEntries(Object.entries(members).map(([name, raw]) => [name, pin(raw)])));
  const manifest = Buffer.from(JSON.stringify({ schema: 'repoe-release-input/v1', name: 'china_text',
    target: { game: 'poe2', game_patch: '9.9', realm }, files: pins }));
  const zip = storedZip({ 'manifest.json': manifest, ...members });
  return { zip, spec: { repository: 'ackness/repoe', tag, asset: 'repoe-input-china_text-9.9.zip', ...pin(zip), member: MEMBER,
    manifest_sha256: sha(native['manifest.json'] ?? Buffer.alloc(0)) } };
}
