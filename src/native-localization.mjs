import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { strictJson } from './strict-json.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const require = (condition, message) => { if (!condition) throw new Error(message); };
const same = (left, right) => canonical(left) === canonical(right);
const fields = (value, expected, label) => require(object(value)
  && same(Object.keys(value).sort(), [...expected].sort()), `Invalid ${label} fields`);
const lexicalOrder = (left, right) => {
  const a = Array.from(left, c => c.codePointAt(0)), b = Array.from(right, c => c.codePointAt(0));
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
};
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort(lexicalOrder).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const nativeBytes = value => Buffer.from(canonical(value) + '\n');

const PAYLOADS = ['descriptions.json', 'diagnostics.json', 'source-lock.json'];
const MAX_PAYLOAD = 256 * 1024 * 1024;
async function readBounded(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    require(stat.isFile() && stat.size <= limit, 'Native input is not a bounded regular file');
    const data = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < data.length) {
      const result = await handle.read(data, length, data.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    require(length <= stat.size, 'Native input grew beyond declared bound');
    return data.subarray(0, length);
  } finally { await handle.close(); }
}

function resource(value) {
  require(text(value) && /^Data\/StatDescriptions\/(?:[^/\\:\x00-\x1f]+\/)*[^/\\:\x00-\x1f]+\.csd$/u.test(value)
    && value.split('/').every(part => part !== '.' && part !== '..'), 'Unsafe native resource path');
}
function span(value, parent, label) {
  fields(value, ['byte_start', 'byte_end', 'line_start', 'line_end'], label);
  require(Object.values(value).every(integer) && value.byte_start >= parent.byte_start
    && value.byte_end >= value.byte_start && value.byte_end <= parent.byte_end
    && value.byte_start % 2 === 0 && value.byte_end % 2 === 0
    && value.line_start >= 1 && value.line_end >= value.line_start, `Invalid ${label}`);
}
const strings = value => Array.isArray(value) && value.every(text);
function validateBranch(branch, parent) {
  fields(branch, ['span', 'condition_tokens_raw', 'restrictions_raw', 'template_raw', 'placeholders',
    'template_syntax_diagnostics', 'quantifier_tokens_raw', 'quantifiers_lexical'], 'branch');
  span(branch.span, parent, 'branch span');
  require(strings(branch.condition_tokens_raw) && strings(branch.restrictions_raw)
    && typeof branch.template_raw === 'string' && strings(branch.quantifier_tokens_raw)
    && Array.isArray(branch.placeholders) && Array.isArray(branch.template_syntax_diagnostics)
    && Array.isArray(branch.quantifiers_lexical), 'Invalid native branch');
  for (const item of branch.placeholders) {
    fields(item, ['token_raw', 'index_token_raw', 'format_raw', 'syntax_status', 'template_character_span'], 'placeholder');
    const offsets = item.template_character_span;
    require(Array.isArray(offsets) && offsets.length === 2 && offsets.every(integer) && offsets[0] <= offsets[1]
      && offsets[1] <= Array.from(branch.template_raw).length
      && Array.from(branch.template_raw).slice(...offsets).join('') === item.token_raw, 'Invalid native placeholder span');
    require(['recognized-lexical', 'unresolved-placeholder-syntax'].includes(item.syntax_status)
      && (item.index_token_raw === null || typeof item.index_token_raw === 'string')
      && (item.format_raw === null || typeof item.format_raw === 'string'), 'Invalid placeholder syntax declaration');
    const syntax = /^\{([0-9]*)(?::([^{}]*))?\}$/u.exec(item.token_raw);
    require(syntax ? item.syntax_status === 'recognized-lexical' && item.index_token_raw === syntax[1]
      && item.format_raw === (syntax[2] ?? null) : item.syntax_status === 'unresolved-placeholder-syntax'
      && item.index_token_raw === null && item.format_raw === null, 'Native placeholder token mismatch');
  }
  for (const item of branch.quantifiers_lexical) {
    fields(item, ['name_raw', 'argument_tokens_raw'], 'quantifier');
    require(text(item.name_raw) && strings(item.argument_tokens_raw), 'Invalid native quantifier');
  }
  require(same(branch.quantifiers_lexical.flatMap(item => [item.name_raw, ...item.argument_tokens_raw]),
    branch.quantifier_tokens_raw), 'Native quantifier token mismatch');
}

function validateDocument(document, identity, summary) {
  fields(document, ['format', 'roots', 'files', 'language_policy', 'selection_policy', 'handler_policy'], 'description document');
  require(document.format === 'repoe-native-description-branches/v1' && strings(document.roots)
    && document.roots.length && new Set(document.roots).size === document.roots.length && object(document.files)
    && Object.keys(document.files).length > 0 && Object.keys(document.files).length <= 128, 'Invalid native description format');
  require(same(Object.keys(document.files).sort(), Object.keys(identity.raw_resources).sort()), 'Native raw inventory mismatch');
  let descriptions = 0, branches = 0;
  const languages = new Set(), handlers = new Set(), expectedDiagnostics = [];
  let rawBytes = 0;
  for (const [name, file] of Object.entries(document.files)) {
    resource(name);
    fields(file, ['path', 'encoding', 'bytes', 'sha256', 'records', 'stat_index'], 'native file');
    require(file.path === name && file.encoding === 'BOM UTF-16LE' && integer(file.bytes) && file.bytes >= 2
      && file.bytes <= 32 * 1024 * 1024 && digest(file.sha256) && Array.isArray(file.records)
      && object(file.stat_index) && same({ bytes: file.bytes, sha256: file.sha256 }, identity.raw_resources[name]), 'Invalid native file identity');
    rawBytes += file.bytes; require(rawBytes <= 64 * 1024 * 1024, 'Native raw source exceeds producer byte limit');
    const index = new Map();
    let offset = 2;
    for (let ri = 0; ri < file.records.length; ri++) {
      const record = file.records[ri];
      require(object(record), 'Invalid native record');
      span(record.span, { byte_start: 2, byte_end: file.bytes }, 'record span');
      require(record.span.byte_start === offset, 'Native records do not cover source contiguously');
      offset = record.span.byte_end;
      require(['description', 'include', 'no_description', 'no_identifiers', 'caption', 'blank'].includes(record.kind), 'Unknown native record kind');
      if (record.kind === 'include') {
        fields(record, ['kind', 'span', 'line_raw', 'literal_target', 'target'], 'include');
        resource(record.target);
        require(text(record.literal_target) && typeof record.line_raw === 'string'
          && record.literal_target.replaceAll('\\', '/') === record.target
          && record.line_raw.trim() === `include "${record.literal_target}"`
          && Object.hasOwn(document.files, record.target), 'Invalid or missing native include');
      } else if (record.kind !== 'description') {
        fields(record, ['kind', 'span', ...(record.kind === 'blank' ? [] : ['line_raw']),
          ...(record.kind === 'no_description' ? ['ids'] : [])], 'directive');
        if (record.kind === 'no_description') require(strings(record.ids) && record.ids.length
          && typeof record.line_raw === 'string' && same(record.line_raw.trim().split(/\s+/u), ['no_description', ...record.ids]), 'Invalid native suppression');
        if (record.kind === 'no_identifiers') require(typeof record.line_raw === 'string'
          && record.line_raw.trim() === 'no_identifiers', 'Invalid native identifier directive');
        if (record.kind === 'caption') require(typeof record.line_raw === 'string'
          && /^"[^"\r\n]*"$/u.test(record.line_raw.trim()), 'Invalid native caption');
      }
      if (record.kind !== 'description') continue;
      fields(record, ['kind', 'header_raw', 'ids', 'groups', 'span', 'raw_slice_sha256'], 'description');
      require(text(record.header_raw) && /^\s*description(?:\s|$)/u.test(record.header_raw)
        && strings(record.ids) && record.ids.length && Array.isArray(record.groups) && record.groups.length
        && digest(record.raw_slice_sha256), 'Invalid native description');
      descriptions++;
      for (const id of record.ids) { if (!index.has(id)) index.set(id, []); index.get(id).push(ri); }
      for (let gi = 0; gi < record.groups.length; gi++) {
        const group = record.groups[gi];
        fields(group, ['declared_language', 'language_origin', 'language_declaration_span', 'declared_branch_count', 'branches', 'span'], 'language group');
        span(group.span, record.span, 'group span');
        require((group.declared_language === null || text(group.declared_language)) && Array.isArray(group.branches)
          && integer(group.declared_branch_count) && group.declared_branch_count === group.branches.length
          && group.language_origin === (group.declared_language === null ? 'implicit-default' : 'explicit-lang'), 'Invalid native language group');
        if (group.declared_language === null) require(group.language_declaration_span === null, 'Implicit default has explicit language span');
        else {
          span(group.language_declaration_span, record.span, 'language declaration span');
          languages.add(group.declared_language);
        }
        for (let bi = 0; bi < group.branches.length; bi++) {
          const branch = group.branches[bi];
          validateBranch(branch, record.span);
          require(branch.condition_tokens_raw.length === record.ids.length, 'Native condition arity mismatch');
          for (const item of branch.quantifiers_lexical) handlers.add(item.name_raw);
          for (const item of branch.template_syntax_diagnostics) {
            fields(item, ['code', 'template_character_span'], 'template diagnostic');
            require(text(item.code) && Array.isArray(item.template_character_span) && item.template_character_span.length === 2
              && item.template_character_span.every(integer) && item.template_character_span[0] <= item.template_character_span[1]
              && item.template_character_span[1] <= Array.from(branch.template_raw).length, 'Invalid template diagnostic span');
            expectedDiagnostics.push({ ...item, path: name, record: ri, group: gi, branch: bi, raw_span: branch.span,
              disposition: 'retained raw; no repair or formatter interpretation' });
          }
          branches++;
        }
      }
    }
    require(offset === file.bytes && same(Object.fromEntries(index), file.stat_index), 'Invalid native source coverage/index');
  }
  const reachable = new Set();
  const active = new Set(), heights = new Map();
  function visit(name) {
    require(Object.hasOwn(document.files, name) && !active.has(name) && active.size <= 16, 'Missing, cyclic or deep native includes');
    if (heights.has(name)) return heights.get(name);
    active.add(name);
    reachable.add(name);
    let height = 0;
    for (const record of document.files[name].records) if (record.kind === 'include') height = Math.max(height, 1 + visit(record.target));
    active.delete(name); heights.set(name, height);
    require(height <= 16, 'Deep native includes');
    return height;
  }
  for (const root of document.roots) visit(root);
  require(same([...reachable].sort(), Object.keys(document.files).sort()), 'Native resource outside literal closure');
  require(summary.files === reachable.size && summary.descriptions === descriptions && summary.branches === branches, 'Native summary mismatch');
  require(same(summary.explicit_languages, [...languages].sort(lexicalOrder))
    && same(summary.quantifier_names, [...handlers].sort(lexicalOrder)), 'Native language/handler summary mismatch');
  return expectedDiagnostics;
}

/** Retain verified bytes before parsing; no API, renderer, Git or source checkout access. */
export async function readNativeDescriptions(directory, expectedManifestSha256) {
  require(digest(expectedManifestSha256), 'External native manifest SHA-256 required');
  directory = await realpath(directory);
  const entries = await readdir(directory, { withFileTypes: true });
  require(same(entries.map(item => item.name).sort(), [...PAYLOADS, 'manifest.json'].sort())
    && entries.every(item => item.isFile() && !item.isSymbolicLink()), 'Invalid native package inventory');
  const manifestBytes = await readBounded(path.join(directory, 'manifest.json'), 1024 * 1024);
  require(sha(manifestBytes) === expectedManifestSha256, 'Native manifest differs from external pin');
  const manifest = strictJson(manifestBytes);
  require(manifest.format === 'repoe-native-descriptions/v1' && manifest.status === 'partial-candidate'
    && manifest.production_ready === false && object(manifest.source_identity) && object(manifest.summary)
    && object(manifest.files) && same(Object.keys(manifest.files).sort(), [...PAYLOADS].sort()), 'Unsupported native package');
  const retained = new Map();
  let total = 0;
  for (const name of PAYLOADS) {
    const fp = manifest.files[name];
    fields(fp, ['bytes', 'sha256'], 'native payload fingerprint');
    require(integer(fp.bytes) && fp.bytes > 0 && digest(fp.sha256) && fp.bytes <= MAX_PAYLOAD, 'Invalid native payload bound');
    total += fp.bytes; require(total <= MAX_PAYLOAD, 'Native package exceeds total byte limit');
    const data = await readBounded(path.join(directory, name), fp.bytes);
    require(data.length === fp.bytes && sha(data) === fp.sha256, `Native payload identity mismatch: ${name}`);
    retained.set(name, data);
  }
  const identity = manifest.source_identity;
  require(identity.game === 'poe2' && ['international', 'china'].includes(identity.realm)
    && text(identity.game_patch) && object(identity.raw_resources) && text(identity.source)
    && digest(identity.selected_source_sha256) && digest(identity.source_lock_sha256), 'Invalid native source identity');
  require(sha(retained.get('source-lock.json')) === identity.source_lock_sha256, 'Native source lock identity mismatch');
  const lock = strictJson(retained.get('source-lock.json'));
  require(lock.schema_version === 1 && object(lock.sources) && Object.hasOwn(lock.sources, identity.source), 'Invalid native source lock');
  const selected = lock.sources[identity.source];
  require(sha(nativeBytes(selected)) === identity.selected_source_sha256 && selected.kind === 'official-client-resource-candidate'
    && selected.game === identity.game && selected.realm === identity.realm && selected.game_patch === identity.game_patch
    && same(selected.acquisition, identity.acquisition) && object(selected.resources)
    && same(Object.keys(selected.resources).sort(), Object.keys(identity.raw_resources).sort())
    && Object.entries(identity.raw_resources).every(([name, fp]) => same(fp,
      { bytes: selected.resources[name]?.bytes, sha256: selected.resources[name]?.sha256 })), 'Native selected-source mismatch');
  require(['unreviewed-acquisition-draft', 'reviewed-source-input'].includes(identity.acquisition?.status), 'Invalid native source status');
  const document = strictJson(retained.get('descriptions.json'));
  require(same(selected.roots, document.roots), 'Native selected-root mismatch');
  const expectedDiagnostics = validateDocument(document, identity, manifest.summary);
  const diagnostics = strictJson(retained.get('diagnostics.json'));
  fields(diagnostics, ['diagnostics'], 'diagnostic document');
  require(Array.isArray(diagnostics.diagnostics) && diagnostics.diagnostics.length === manifest.summary.diagnostics
    && same(diagnostics.diagnostics, expectedDiagnostics), 'Native diagnostic reference/count mismatch');
  return { manifest, manifestBytes, manifestSha256: expectedManifestSha256, document, diagnostics: diagnostics.diagnostics };
}

function signature(branch) {
  const characters = Array.from(branch.template_raw);
  return canonical({ conditions: branch.condition_tokens_raw, restrictions: branch.restrictions_raw,
    handlers: branch.quantifier_tokens_raw, slots: branch.placeholders.map(p => [p.index_token_raw, p.format_raw,
      /[+-]$/u.exec(characters.slice(0, p.template_character_span[0]).join('').trimEnd())?.[0] ?? ''])
      .sort((a, b) => lexicalOrder(canonical(a), canonical(b))) });
}
function reason(branch) {
  if (branch.template_syntax_diagnostics.length || branch.placeholders.some(p => p.syntax_status !== 'recognized-lexical')) return 'unresolved-template-syntax';
  if (branch.placeholders.some(p => !/^[0-9]+$/u.test(p.index_token_raw))) return 'implicit-placeholder-index';
  return null;
}
const literals = branch => {
  let text = branch.template_raw.replace(/\{[^{}]*\}/gu, '').replace(/\[[^\]]*\]/gu, '');
  return (text.match(/[+-]?\d+(?:\.\d+)?/gu) ?? []).sort();
};

/** Contextual native-ID candidates; no trade-ID inference or source precedence. */
export function buildNativeLocalization({ manifest, manifestSha256, document, diagnostics }) {
  const pairs = [], excluded = [];
  let descriptions = 0;
  const reference = (file, record, group, branch) => ({ file, record, group, branch });
  for (const file of Object.keys(document.files).sort(lexicalOrder)) {
    const records = document.files[file].records;
    for (let ri = 0; ri < records.length; ri++) {
      const record = records[ri]; if (record.kind !== 'description') continue;
      descriptions++;
      const defaults = record.groups.map((g, i) => [g, i]).filter(([g]) => g.declared_language === null);
      const chinese = record.groups.map((g, i) => [g, i]).filter(([g]) => g.declared_language === 'Simplified Chinese');
      const scope = { file, record: ri, stat_ids: record.ids };
      if (defaults.length !== 1 || !chinese.length) {
        excluded.push({ ...scope, reason: defaults.length !== 1 ? 'nonunique-implicit-default' : 'missing-simplified-chinese-group' });
        continue;
      }
      const buckets = new Map();
      for (const [language, groups] of [['implicit-default', defaults], ['Simplified Chinese', chinese]]) {
        for (const [group, gi] of groups) for (let bi = 0; bi < group.branches.length; bi++) {
          const branch = group.branches[bi]; const key = signature(branch);
          if (!buckets.has(key)) buckets.set(key, { 'implicit-default': [], 'Simplified Chinese': [] });
          buckets.get(key)[language].push({ branch, reference: reference(file, ri, gi, bi) });
        }
      }
      for (const bucket of buckets.values()) {
        const en = bucket['implicit-default'], cn = bucket['Simplified Chinese'];
        if (en.length !== 1 || cn.length !== 1) {
          excluded.push({ ...scope, reason: en.length > 1 || cn.length > 1 ? 'nonunique-branch-signature' : 'unmatched-branch-signature',
            default_refs: en.map(item => item.reference), chinese_refs: cn.map(item => item.reference) });
          continue;
        }
        const issue = reason(en[0].branch) ?? reason(cn[0].branch)
          ?? (!/\p{Script=Han}/u.test(cn[0].branch.template_raw) ? 'no-han-in-declared-chinese' : null)
          ?? (!same(literals(en[0].branch), literals(cn[0].branch)) ? 'literal-number-mismatch' : null);
        if (issue) { excluded.push({ ...scope, reason: issue, default_refs: [en[0].reference], chinese_refs: [cn[0].reference] }); continue; }
        pairs.push({ ...scope, default_reference: en[0].reference, chinese_reference: cn[0].reference,
          default_language_origin: 'implicit-default; English interpretation is a project convention, not an explicit lang token',
          declared_chinese_language: 'Simplified Chinese', default_template_raw: en[0].branch.template_raw,
          chinese_template_raw: cn[0].branch.template_raw, conditions_raw: en[0].branch.condition_tokens_raw,
          restrictions_raw: en[0].branch.restrictions_raw, quantifier_tokens_raw: en[0].branch.quantifier_tokens_raw,
          placeholders: { default: en[0].branch.placeholders, chinese: cn[0].branch.placeholders },
          raw_spans: { default: en[0].branch.span, chinese: cn[0].branch.span } });
      }
    }
  }
  return { format: 'poe2-native-localization-candidate/v1', status: 'structurally-matched-candidates', production_ready: false,
    input: { manifest_sha256: manifestSha256, source_identity: manifest.source_identity, producer: manifest.producer },
    policy: { language_pairing: 'same file/description, exact conditions/restrictions/ordered handlers and placeholder multiset; unique on both sides',
      precedence: 'none; includes and suppressions remain in the canonical input', trade_id_mapping: 'none',
      cn_numerical_equivalence: 'not established by international Simplified Chinese text' },
    roots: document.roots, pairs, excluded, source_diagnostics: diagnostics,
    summary: { descriptions, pairs: pairs.length, excluded: excluded.length, source_diagnostics: diagnostics.length } };
}

export async function generateNativeLocalization(directory, expectedManifestSha256) {
  const result = buildNativeLocalization(await readNativeDescriptions(directory, expectedManifestSha256));
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = {};
  const names = (await readdir(path.join(root, 'src'))).filter(name => name.endsWith('.mjs')).sort();
  for (const name of [...names.map(name => `src/${name}`), 'package.json', 'package-lock.json']) {
    files[name] = sha(await readBounded(path.join(root, name), 1024 * 1024));
  }
  return { ...result, consumer: { name: 'poe2-native-localization-compiler/v1', node_version: process.versions.node, files } };
}

export async function checkNativeLocalizationCandidate(candidate, expected) {
  const actual = await readBounded(candidate, expected.length);
  require(actual.equals(expected), 'Native localization candidate differs from verified offline derivation');
}
