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

// A synthetic input package of display tables: `tables` is {Table: {Id: [english, localized]}} (a
// localized value of undefined leaves the row out of the localized package). `language` and `realm`
// go into the localized source identity; `defaultRealm` into the default one. `localizedIdentity`
// overrides fields of the localized source identity (e.g. another game_patch).
export function tablePackage({ tables, language = 'Simplified Chinese', realm = 'china', defaultRealm = realm,
  localizedDir = 'display-tables/simplified-chinese/', extra = {}, tag = 'inputs/9.9-1', scopes, localizedIdentity = {}, gamePatch = '9.9',
  editTables = () => {} } = {}) {
  const side = localized => {
    const doc = Object.fromEntries(Object.entries(tables).map(([table, rows]) => {
      const field = table === 'GemEffects' ? 'SupportText' : table === 'ActiveSkills' ? 'Description' : 'Name';
      return [table, { table, rows: Object.entries(rows).filter(([, pair]) => !localized || pair[1] !== undefined)
        .map(([id, pair], index) => ({ _row: index, values: { Id: id, [field]: pair[localized ? 1 : 0] } })) }];
    }));
    editTables(doc, localized);
    const tablesRaw = Buffer.from(JSON.stringify(doc)), lockRaw = Buffer.from('{"schema_version":1}');
    const manifest = Buffer.from(JSON.stringify({ format: localized ? 'repoe-localized-tables/v1' : 'repoe-native-tables/v1',
      files: { 'source-lock.json': pin(lockRaw), 'tables.json': pin(tablesRaw) },
      source_identity: { game: 'poe2', game_patch: gamePatch, realm: localized ? realm : defaultRealm, source: localized ? 'localized' : 'default',
        source_lock_sha256: sha(lockRaw), acquisition: { status: 'unreviewed-acquisition-draft', evidence: [] },
        ...(localized ? { language, ...localizedIdentity } : {}) } }));
    return { manifest, files: { 'manifest.json': manifest, 'source-lock.json': lockRaw, 'tables.json': tablesRaw } };
  };
  const english = side(false), localized = side(true);
  const members = { ...extra };
  for (const [name, raw] of Object.entries(english.files)) members[`display-tables/default/${name}`] = raw;
  for (const [name, raw] of Object.entries(localized.files)) members[localizedDir + name] = raw;
  const root = Buffer.from(JSON.stringify({ schema: 'repoe-release-input/v1', name: 'text', target: { game: 'poe2', game_patch: gamePatch, realm },
    files: Object.fromEntries(Object.entries(members).map(([name, raw]) => [name, pin(raw)])) }));
  const zip = storedZip({ 'manifest.json': root, ...members });
  const tableScopes = { GemEffects: 'GemEffects.SupportText', ActiveSkills: 'ActiveSkills.Description',
    MonsterVarieties: 'MonsterVarieties.Name', ItemClasses: 'ItemClasses.Name' };
  return { zip, spec: { repository: 'ackness/repoe', tag, asset: 'repoe-input-text-9.9.zip', ...pin(zip),
    default: 'display-tables/default/', default_manifest_sha256: sha(english.manifest),
    localized: localizedDir, localized_manifest_sha256: sha(localized.manifest),
    scopes: scopes ?? Object.keys(tables).map(table => tableScopes[table]) } };
}
