// Persistent editorial metadata over immutable native catalogs. No source
// pairing, region inference, locale conversion, network calls or activation.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { createCatalogLookup, displayTemplate } from './native-catalog.mjs';
import { strictJson } from './strict-json.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const require = (ok, message) => { if (!ok) throw new Error(message); };
const serialize = value => JSON.stringify(value, null, 2) + '\n';
const ordered = value => Array.isArray(value) ? value.map(ordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, ordered(value[k])])) : value;
const canonical = value => JSON.stringify(ordered(value));
const pin = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const identityKey = identity => canonical(identity);
export const entryId = (identity, english, context) => hash(canonical([identity, english, context]));
const annotationSchema = 'poe2-native-translation-edits/v1';
const workbenchSchema = 'poe2-translation-workbench/v1';
const runtimeSchema = 'poe2-reviewed-native-supplements/v1';

function parseEdits(document) {
  require(document?.schema === annotationSchema && Array.isArray(document.entries), 'Invalid native translation edits');
  const edits = new Map();
  for (const row of document.entries) {
    require(pin(row.entry_id) && !edits.has(row.entry_id), 'Invalid/duplicate translation entry_id');
    require(row.identity?.game === 'poe2' && ['international', 'china'].includes(row.identity.realm)
      && ['zh-CN', 'zh-TW'].includes(row.identity.locale) && typeof row.english === 'string' && row.english.trim()
      && row.context && typeof row.context === 'object'
      && row.entry_id === entryId(row.identity, row.english, row.context), 'Edit identity/English/context differs from entry_id');
    require(pin(row.based_on?.catalog_sha256) && typeof row.based_on.game_patch === 'string'
      && /^\d+(?:\.\d+)+$/u.test(row.based_on.game_patch), 'An edit requires its exact catalog and patch');
    require(['agent', 'human'].includes(row.origin) && typeof row.author === 'string' && row.author.trim()
      && typeof row.note === 'string' && row.note.trim(), 'A translation requires origin, author and note');
    require(typeof row.text === 'string' && row.text.trim() && /\p{Script=Han}/u.test(row.text), 'A translation requires Chinese text');
    require(['draft', 'reviewed', 'rejected'].includes(row.status), 'Invalid edit status');
    if (row.status === 'reviewed') require(typeof row.review?.by === 'string' && row.review.by.trim()
      && typeof row.review.note === 'string' && row.review.note.trim(), 'Reviewed translations require reviewer and review note');
    // Inputs are explicit editorial records; derived workbench fields are ignored.
    edits.set(row.entry_id, { entry_id: row.entry_id, identity: row.identity, english: row.english,
      context: row.context, based_on: row.based_on, origin: row.origin,
      author: row.author, note: row.note, text: row.text, status: row.status, review: row.review ?? null });
  }
  return edits;
}

function officialState(row) {
  if (row.reason === 'target-binding-rejected' || row.reason === 'missing-english-id'
    || row.reason === 'missing-localized-id') return 'unverified';
  if (!row.english?.trim()) return 'not-applicable';
  if (row.status === 'translated') return 'available';
  if (['unchanged-text', 'empty-localized-text'].includes(row.reason)) return 'missing';
  // A non-Han proper name or rejected template is not proof of missing official translation.
  return 'unverified';
}

function safetyIssue(english, text) {
  const en = displayTemplate(english), zh = displayTemplate(text);
  if (!en.syntax_valid || !zh.syntax_valid) return 'template-syntax';
  // Native implicit slots need the shared renderer; do not infer their numbering here.
  if ([...en.placeholders, ...zh.placeholders].some(p => p.index_raw === ''
    || ![null, 'd', '+d', '-d'].includes(p.format_raw))) return 'template-requires-renderer';
  const slots = t => t.placeholders.map(p => canonical([p.index_raw, p.format_raw, p.sign_raw])).sort();
  if (!same(slots(en), slots(zh)) || en.hash_slots !== zh.hash_slots) return 'placeholder-mismatch';
  if (!same(en.references.map(r => r.key_raw).sort(), zh.references.map(r => r.key_raw).sort())) return 'reference-mismatch';
  if (!same(en.literal_numbers, zh.literal_numbers)) return 'literal-number-mismatch';
  return null;
}

function editState(edit, entry) {
  if (!edit) return { status: 'absent', reason: null };
  if (edit.status === 'rejected') return { status: 'rejected', reason: 'editor-rejected' };
  if (edit.based_on.catalog_sha256 !== entry.current.catalog_sha256 || edit.based_on.game_patch !== entry.current.game_patch)
    return { status: 'needs-review', reason: 'source-revision-changed' };
  if (typeof entry.english !== 'string' || !entry.english.trim()) return { status: 'needs-review', reason: 'missing-english' };
  const issue = safetyIssue(entry.english, edit.text);
  if (issue) return { status: 'needs-review', reason: issue };
  return { status: edit.status, reason: null };
}

function agentBlocker(row, state = officialState(row)) {
  const internal = /\[(?:DNT[^\]]*|UNUSED)\]|\bWIP\b|^(?:NAME|TBD|\?+)$/u.test(row.english ?? '');
  return state !== 'missing' ? 'official-' + state : internal ? 'internal-placeholder' : safetyIssue(row.english, row.english);
}

// Keep the original sidecar Buffer only here, once per input. Entries and runtime
// sources carry pins, never physical tables, FK witnesses or copied sidecars.
function validatedCatalogs(inputs) {
  require(Array.isArray(inputs) && inputs.length > 0, 'At least one pinned catalog is required');
  const families = new Set();
  return inputs.map(input => {
    require(pin(input.sha256) && hash(input.bytes) === input.sha256, 'Catalog SHA256 mismatch');
    const catalog = strictJson(input.bytes);
    require(['international', 'china'].includes(catalog.realm) && /^\d+(?:\.\d+)+$/u.test(catalog.game_patch), 'Known target realm/patch required');
    const official = createCatalogLookup(catalog, { ...catalog, verification: input.verification });
    const family = canonical([catalog.game, catalog.realm, catalog.locale]);
    require(!families.has(family), 'Only one current catalog per realm/locale; combine selected tables upstream');
    families.add(family);
    const source = { game: catalog.game, realm: catalog.realm, locale: catalog.locale,
      game_patch: catalog.game_patch, catalog_sha256: input.sha256, manifest_sha256: input.manifest_sha256 ?? null,
      observed_client: catalog.observed_client ?? null,
      ...(catalog.fk_verification ? { fk_verification: catalog.fk_verification } : {}) };
    return { catalog, official, source, family };
  });
}

/** Each input is {bytes, sha256, verification?: original Buffer, manifest_sha256?}. */
export function reconcileNativeTranslations(inputs, document = { schema: annotationSchema, entries: [] }, previous = null) {
  return reconcile(validatedCatalogs(inputs), document, previous);
}

function reconcile(catalogs, document, previous = null) {
  const edits = parseEdits(document), old = new Map(), entries = new Map();
  const families = new Set(catalogs.map(c => c.family)), sources = catalogs.map(c => c.source);
  if (previous !== null) {
    require(previous.schema === workbenchSchema && Array.isArray(previous.entries), 'Invalid previous workbench');
    for (const entry of previous.entries) {
      require(entry.entry_id === entryId(entry.identity, entry.english, entry.context) && !old.has(entry.entry_id)
        && Array.isArray(entry.seen_in), 'Invalid/duplicate previous workbench identity');
      old.set(entry.entry_id, entry);
    }
  }
  for (const { catalog, source } of catalogs) {
    for (const row of catalog.records) {
      const identity = { game: catalog.game, realm: catalog.realm, locale: catalog.locale,
        table: row.table, field: row.field, id: row.id };
      const id = entryId(identity, row.english, row.context.english), before = old.get(id);
      require(!entries.has(id), 'Duplicate workbench identity');
      const state = officialState(row), current = { game_patch: catalog.game_patch, catalog_sha256: source.catalog_sha256 };
      const seen = [...(before?.seen_in ?? [])];
      if (!seen.some(r => same(r, current))) seen.push(current);
      const entry = { entry_id: id, identity, english: row.english, context: row.context.english, current, seen_in: seen,
        official_translation: { status: state, reason: row.reason, text: row.localized,
          english_row: row.english_row, localized_row: row.localized_row },
        regional_scope: { target_realm: catalog.realm, observed_realm: catalog.observed_client?.realm ?? (catalog.schema.endsWith('/v1') ? catalog.realm : null),
          status: row.reason === 'target-binding-rejected' || row.english_row === null ? 'unverified-difference' : 'target-bound',
          exclusive: null, reason_codes: row.applicability?.reason_codes ?? [],
          observed_candidates: row.applicability?.reason_codes.includes('target-missing-key') ? row.candidates : null },
        translation: edits.get(id) ?? null, lifecycle: 'current' };
      entry.translation_review = editState(entry.translation, entry);
      entry.agent_blocker = agentBlocker(row, state);
      entry.agent_eligible = entry.agent_blocker === null;
      const usable = entry.agent_eligible && entry.translation_review.status === 'reviewed';
      entry.effective_translation = { text: state === 'available' ? row.localized : usable ? entry.translation.text : null,
        origin: state === 'available' ? 'official' : usable ? entry.translation.origin : null };
      entry.supplement_differs = state === 'available' && entry.translation !== null && entry.translation.text !== row.localized;
      entry.workflow_status = state === 'available' ? 'official' : state === 'not-applicable' ? 'not-applicable'
        : !entry.agent_eligible ? 'source-review' : entry.translation_review.status === 'reviewed' ? 'supplemented'
        : ['draft', 'needs-review', 'rejected'].includes(entry.translation_review.status) ? entry.translation_review.status : 'pending';
      entries.set(id, entry);
    }
  }
  const currentIdentities = new Set([...entries.values()].map(r => identityKey(r.identity)));
  for (const [id, entry] of old) if (!entries.has(id)) {
    const inScope = families.has(canonical([entry.identity.game, entry.identity.realm, entry.identity.locale]));
    entries.set(id, { ...entry, lifecycle: inScope ? 'retired' : 'out-of-scope',
      workflow_status: inScope && currentIdentities.has(identityKey(entry.identity)) ? 'needs-review' : 'retired',
      translation: edits.get(id) ?? null, agent_eligible: false,
      translation_review: { status: 'needs-review', reason: inScope ? 'english-context-or-membership-changed' : 'catalog-not-supplied' },
      effective_translation: { text: null, origin: null } });
  }
  const rows = [...entries.values()].sort((a, b) => a.entry_id.localeCompare(b.entry_id));
  const queues = {};
  for (const entry of rows) (queues[entry.workflow_status] ??= []).push(entry.entry_id);
  queues['regional-review'] = rows.filter(r => r.lifecycle === 'current' && r.regional_scope.status === 'unverified-difference').map(r => r.entry_id);
  const orphaned = [...edits.values()].filter(row => !entries.has(row.entry_id));
  return { schema: workbenchSchema, sources, entries: rows, queues, orphaned_edits: orphaned,
    policy: 'Official translations win. Only reviewed supplements for exact catalog/patch/realm/locale/ID/English/context apply. Missing target rows are not proof of China-exclusive content. Drafts never become official or numeric facts.' };
}

const runtimeSource = source => ({ game: source.game, game_patch: source.game_patch, realm: source.realm,
  locale: source.locale, catalog_sha256: source.catalog_sha256,
  verification: source.fk_verification ? { bytes: source.fk_verification.bytes, sha256: source.fk_verification.sha256 } : null });

function compact(book) {
  const sources = book.sources.map(runtimeSource);
  const records = book.entries.filter(r => r.lifecycle === 'current' && r.agent_eligible
    && r.translation_review.status === 'reviewed' && ['agent', 'human'].includes(r.effective_translation.origin))
    .map(r => ({ source: sources.findIndex(s => s.catalog_sha256 === r.current.catalog_sha256
      && s.realm === r.identity.realm && s.locale === r.identity.locale), entry_id: r.entry_id,
    table: r.identity.table, field: r.identity.field, id: r.identity.id, english: r.english, context: r.context,
    text: r.translation.text, origin: r.translation.origin, author: r.translation.author, note: r.translation.note,
    status: 'reviewed', review: r.translation.review }));
  return { schema: runtimeSchema, status: 'candidate', production_ready: false, sources, records };
}

/** Export only effective current reviewed supplements; no history/evidence payloads. */
export function exportReviewedSupplements(inputs, edits = { schema: annotationSchema, entries: [] }) {
  return compact(reconcile(validatedCatalogs(inputs), edits));
}

function runtimeLookup(catalogs, runtime) {
  require(runtime?.schema === runtimeSchema && runtime.status === 'candidate' && runtime.production_ready === false
    && Array.isArray(runtime.sources) && Array.isArray(runtime.records), 'Invalid reviewed supplement runtime');
  const scopes = new Map(catalogs.map(c => [c.family, c])), used = new Set();
  const sources = runtime.sources.map(source => {
    const family = canonical([source.game, source.realm, source.locale]), current = scopes.get(family);
    require(current && !used.has(family) && same(source, runtimeSource(current.source)), 'Unknown/duplicate/stale runtime source');
    used.add(family); return current;
  });
  require(used.size === catalogs.length, 'Runtime source inventory differs');
  const catalogRows = sources.map(c => new Map(c.catalog.records.map(row => [canonical([row.table, row.field, row.id]), row])));
  const entries = new Map(), identities = new Set();
  for (const record of runtime.records) {
    require(Number.isSafeInteger(record.source) && sources[record.source], 'Unknown runtime record source');
    const { catalog, source } = sources[record.source];
    const identity = { game: catalog.game, realm: catalog.realm, locale: catalog.locale,
      table: record.table, field: record.field, id: record.id };
    const based_on = { game_patch: source.game_patch, catalog_sha256: source.catalog_sha256 };
    const edit = parseEdits({ schema: annotationSchema, entries: [{ ...record, identity, based_on }] }).get(record.entry_id);
    const row = catalogRows[record.source].get(canonical([record.table, record.field, record.id]));
    require(record.status === 'reviewed' && row && row.english === record.english && same(row.context.english, record.context),
      'Runtime supplement English/context/identity differs');
    require(agentBlocker(row) === null && safetyIssue(row.english, record.text) === null, 'Runtime supplement is not effective for source');
    require(!entries.has(record.entry_id) && !identities.has(identityKey(identity)), 'Duplicate runtime supplement identity');
    entries.set(record.entry_id, edit); identities.add(identityKey(identity));
  }
  return query => {
    const scope = scopes.get(canonical(['poe2', query?.realm, query?.locale]));
    require(scope, 'Supplement query realm/locale differs');
    const { catalog, official } = scope;
    require(query.game_patch === catalog.game_patch, 'Supplement query game_patch differs');
    const result = official(query);
    if (result.status === 'translated') return { ...result, origin: 'official' };
    if (!Object.hasOwn(query, 'id') || !Object.hasOwn(query, 'context')) return { ...result, origin: null };
    const identity = { game: catalog.game, realm: catalog.realm, locale: catalog.locale, table: query.table, field: query.field, id: query.id };
    const edit = entries.get(entryId(identity, query.english, query.context));
    return edit ? { status: 'translated', text: edit.text, origin: edit.origin,
      reason: 'reviewed-supplement', ids: [query.id] } : { ...result, origin: null };
  };
}

/** Pinned compact runtime + pinned original catalogs; validate once, then query. */
export function createReviewedSupplementLookup(inputs, runtime) {
  require(pin(runtime?.sha256) && hash(runtime.bytes) === runtime.sha256, 'Runtime SHA256 mismatch');
  return runtimeLookup(validatedCatalogs(inputs), strictJson(runtime.bytes));
}

/** Existing edits API, with the same validation/policy as the compact consumer. */
export function createSupplementedLookup(input, edits = { schema: annotationSchema, entries: [] }) {
  const catalogs = validatedCatalogs([input]);
  return runtimeLookup(catalogs, compact(reconcile(catalogs, edits)));
}

async function readInput(file, expected) {
  if (expected) require(Number.isSafeInteger(expected.bytes) && expected.bytes >= 0 && pin(expected.sha256), 'Invalid declared input identity');
  const absolute = path.resolve(file);
  require(await realpath(absolute) === absolute, 'Input contains a symlink');
  const fd = await open(absolute, 'r');
  try {
    const stat = await fd.stat(); require(stat.isFile(), 'Input must be a regular file');
    if (expected) require(stat.size === expected.bytes, 'Input size differs from manifest');
    const bytes = await fd.readFile(); require(bytes.length === stat.size, 'Input size changed while reading');
    if (expected) require(bytes.length === expected.bytes && hash(bytes) === expected.sha256, 'Pinned input differs');
    return bytes;
  } finally { await fd.close(); }
}

async function readWorkbenchInputs(config) {
  require(config?.schema === 'poe2-translation-workbench-request/v1' && Array.isArray(config.catalogs)
    && config.catalogs.length > 0 && config.catalogs.length <= 4, 'Invalid workbench request');
  const inputs = [];
  for (const source of config.catalogs) {
    const raw = await readInput(source.manifest);
    require(pin(source.sha256) && hash(raw) === source.sha256, 'Manifest SHA256 mismatch');
    const manifest = strictJson(raw);
    require(['poe2-native-catalog-manifest/v1', 'poe2-native-catalog-manifest/v2', 'poe2-native-catalog-manifest/v3'].includes(manifest.schema)
      && manifest.status === 'candidate' && manifest.production_ready === false, 'Invalid catalog manifest');
    const catalogPin = manifest.files?.['catalog.json'];
    require(catalogPin && pin(catalogPin.sha256), 'Missing pinned catalog identity');
    const bytes = await readInput(path.join(path.dirname(source.manifest), 'catalog.json'), catalogPin);
    const catalog = strictJson(bytes);
    require(catalog.schema === manifest.schema.replace('-manifest', '')
      && ['game', 'game_patch', 'realm', 'locale'].every(k => catalog[k] === manifest[k]), 'Manifest/catalog identity differs');
    let verification;
    if (catalog.schema === 'poe2-native-catalog/v3') {
      const sidecar = manifest.files['verification.json'];
      require(sidecar && same(catalog.fk_verification, { file: 'verification.json', ...sidecar }), 'Manifest/catalog verification pin differs');
      verification = await readInput(path.join(path.dirname(source.manifest), 'verification.json'), sidecar);
    }
    inputs.push({ bytes, sha256: catalogPin.sha256, manifest_sha256: source.sha256, verification });
  }
  return inputs;
}

export async function writeWorkbench(config, out) { return writeWorkbenchOutput(config, out, false); }
export async function writeReviewedSupplements(config, out) { return writeWorkbenchOutput(config, out, true); }

async function writeWorkbenchOutput(config, out, runtimeOnly) {
  const inputs = await readWorkbenchInputs(config);
  const editsRaw = config.edits ? await readInput(config.edits) : Buffer.from(serialize({ schema: annotationSchema, entries: [] }));
  // A compact replay depends only on current catalog + edits. Retired/out-of-scope
  // history is retained by the full workbench and can never contribute runtime text.
  const previousRaw = !runtimeOnly && config.previous ? await readInput(config.previous) : null;
  const book = reconcileNativeTranslations(inputs, strictJson(editsRaw), previousRaw ? strictJson(previousRaw) : null);
  const runtime = compact(book);
  const output = path.resolve(out), cache = path.join(ROOT, '.cache');
  require(output.startsWith(cache + path.sep) && await realpath(path.dirname(output)) === path.dirname(output), 'Output must be a fresh repository cache directory');
  await mkdir(output); // Existing outputs are never overwritten.
  const runtimeFiles = { 'supplements.json': JSON.stringify(runtime) + '\n', 'request.json': serialize(config) };
  const files = runtimeOnly ? runtimeFiles : { 'workbench.json': serialize(book), 'queues.json': serialize(book.queues),
    'worklist.json': serialize({ schema: 'poe2-native-translation-worklist/v1', sources: book.sources,
      counts: Object.fromEntries(Object.entries(book.queues).map(([k, v]) => [k, v.length])),
      entries: book.entries.filter(r => r.lifecycle === 'current' && r.agent_eligible) }),
    'regional-candidates.json': serialize({ schema: 'poe2-native-regional-candidates/v1', sources: book.sources,
      note: 'Only missing-target-key observations. Neither region exclusivity nor patch identity is certified.',
      entries: book.entries.filter(r => r.lifecycle === 'current' && r.regional_scope.reason_codes.includes('target-missing-key')) }),
    'report.md': '# 原件补译工作表\n\n官方、补译、区服和版本状态分别保留。此候选未激活。\n\n'
      + '| 状态 | 条数 |\n| --- | ---: |\n' + Object.entries(book.queues).map(([k, v]) => `| ${k} | ${v.length} |`).join('\n')
      + '\n\n`regional-review` 与工作流状态可重叠；不是国服专属数量。使用 `workbench-list --file workbench.json --status pending` 查看完整条目。\n',
    'edits.json': editsRaw, ...runtimeFiles };
  for (const [file, bytes] of Object.entries(files)) await writeFile(path.join(output, file), bytes, { flag: 'wx' });
  const manifest = { schema: runtimeOnly ? 'poe2-reviewed-native-supplements-manifest/v1' : 'poe2-translation-workbench-manifest/v1', status: 'candidate', production_ready: false,
    edits_sha256: hash(editsRaw), previous_sha256: previousRaw ? hash(previousRaw) : null,
    files: Object.fromEntries(Object.entries(files).map(([file, bytes]) => [file, { bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }])),
    producer: Object.fromEntries(await Promise.all(['translation-workbench.mjs', 'native-catalog.mjs', 'native-catalog-binding.mjs', 'native-catalog-fk-binding.mjs', 'native-names.mjs', 'native-localization.mjs', 'strict-json.mjs']
      .map(async file => [file, hash(await readFile(path.join(ROOT, 'src', file)))]))) };
  await writeFile(path.join(output, 'manifest.json'), serialize(manifest), { flag: 'wx' });
  return { manifest, records: runtime.records.length,
    counts: Object.fromEntries(Object.entries(book.queues).map(([k, v]) => [k, v.length])), orphaned_edits: book.orphaned_edits.length };
}

export async function workbenchCommand(command, args) {
  require(['workbench', 'workbench-export', 'workbench-list'].includes(command), 'Unknown workbench command');
  const writing = command !== 'workbench-list';
  const allowed = writing ? ['--config', '--out'] : ['--file', '--status', '--realm', '--locale', '--limit'];
  const options = new Map();
  while (args.length) {
    const flag = args.shift();
    require(allowed.includes(flag) && !options.has(flag) && args[0] && !args[0].startsWith('--'), 'Unknown/incomplete workbench option');
    options.set(flag, args.shift());
  }
  if (writing) {
    require(options.has('--config') && options.has('--out'), `${command} requires --config and --out`);
    return (command === 'workbench' ? writeWorkbench : writeReviewedSupplements)(strictJson(await readInput(options.get('--config'))), options.get('--out'));
  }
  require(options.has('--file'), 'workbench-list requires --file');
  const book = strictJson(await readInput(options.get('--file')));
  require(book.schema === workbenchSchema, 'Invalid workbench');
  if (options.has('--status')) require(Object.hasOwn(book.queues, options.get('--status')), 'Unknown workbench status');
  if (options.has('--realm')) require(['china', 'international'].includes(options.get('--realm')), 'Unknown realm');
  if (options.has('--locale')) require(['zh-CN', 'zh-TW'].includes(options.get('--locale')), 'Unknown locale');
  const limit = options.has('--limit') ? Number(options.get('--limit')) : 50;
  require(Number.isSafeInteger(limit) && limit >= 1 && limit <= 10000, 'Invalid list limit');
  const ids = options.has('--status') ? new Set(book.queues[options.get('--status')]) : null;
  const rows = book.entries.filter(row => (!ids || ids.has(row.entry_id))
    && (!options.has('--realm') || row.identity.realm === options.get('--realm'))
    && (!options.has('--locale') || row.identity.locale === options.get('--locale')));
  return { total: rows.length, returned: Math.min(limit, rows.length), entries: rows.slice(0, limit) };
}
