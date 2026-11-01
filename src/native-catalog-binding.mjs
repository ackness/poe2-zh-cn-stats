// Verify the source owner's v2 text applicability receipt against pinned rows.
// This does not decode DAT, infer client identity, or interpret foreign rows.
import { createHash } from 'node:crypto';
import { canonical, nativeBytes } from './native-localization.mjs';

const require = (ok, message) => { if (!ok) throw new Error(message); };
const same = (a, b) => canonical(a) === canonical(b);
const sha = raw => createHash('sha256').update(raw).digest('hex');
const policy = 'stable-key-current-english-all-nontext/v1';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isSafeInteger(v);

function typed(value, column) {
  const type = column.schema.type;
  if (value === null) return ['string', 'row', 'foreignrow'].includes(type);
  if (Array.isArray(value)) return (column.schema.array || ['array', 'enumrow'].includes(type))
    && value.every(v => integer(v) && (type !== 'foreignrow' && type !== 'row' || v >= 0));
  if (column.schema.array || type === 'array') return false;
  if (type === 'string') return typeof value === 'string';
  if (type === 'bool') return typeof value === 'boolean';
  if (['f32', 'f64'].includes(type)) return typeof value === 'number' && Number.isFinite(value);
  if (['row', 'foreignrow', 'enumrow'].includes(type)) return integer(value) && value >= 0;
  const bits = /^([iu])(8|16|32|64)$/u.exec(type);
  if (!bits || !integer(value)) return false;
  const width = Number(bits[2]);
  return bits[1] === 'u' ? value >= 0 && (width === 64 || value < 2 ** width)
    : width === 64 || value >= -(2 ** (width - 1)) && value < 2 ** (width - 1);
}

function validateTable(table, name) {
  require(table?.table === name && Array.isArray(table.physical_fields) && Array.isArray(table.columns)
    && Array.isArray(table.rows) && table.physical_fields.every(f => typeof f === 'string')
    && new Set(table.physical_fields).size === table.physical_fields.length, `Invalid observed table: ${name}`);
  const columns = new Map();
  table.columns.forEach((column, index) => {
    require(column.source_column === index && object(column.schema) && Array.isArray(column.physical_fields), `Invalid observed column: ${name}/${index}`);
    for (const field of column.physical_fields) {
      require(!columns.has(field) && table.physical_fields.includes(field), `Duplicate/unknown observed column: ${name}.${field}`);
      columns.set(field, column);
    }
  });
  require(columns.size === table.physical_fields.length, `Incomplete observed columns: ${name}`);
  require(table.validation?.rows === table.rows.length && Number.isSafeInteger(table.validation.schema_row_bytes)
    && table.validation.schema_row_bytes > 0 && table.validation.actual_row_bytes === table.validation.schema_row_bytes, `Invalid observed row layout: ${name}`);
  for (const [index, row] of table.rows.entries()) {
    require(row._row === index && object(row.values) && same(Object.keys(row.values).sort(), [...table.physical_fields].sort()), `Invalid observed physical row: ${name}/${index}`);
    for (const [field, column] of columns) require(typed(row.values[field], column), `Observed typed column drift: ${name}/${index}/${field}`);
  }
}

function groups(table, key) {
  const result = new Map();
  for (const row of table.rows) {
    const id = row.values[key];
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(row);
  }
  return result;
}

/** Recompute exactly the frozen source-owner policy; row ordinals are evidence. */
export function verifyObservedBindings(observed, owners, tables, catalogFields) {
  const binding = observed.binding, declaration = observed.manifest.target_binding;
  require(binding?.policy_id === policy && declaration?.policy_id === policy
    && declaration.file === 'target_binding.json' && binding.row_addresses_are_identity === false, 'Unsupported target binding policy');
  const target = binding.target_identity;
  require(target?.game === 'poe2' && /^\d+(?:\.\d+){2,5}$/u.test(target.game_patch)
    && ['international', 'china'].includes(target.realm), 'Invalid target runtime identity');
  for (const k of ['game', 'game_patch', 'realm']) require(declaration[k] === target[k], 'Target declaration identity differs');
  const verified = {};
  for (const name of tables) {
    const source = owners[name], current = source?.tables[name], defaults = observed.defaultTables[name], localized = observed.tables[name];
    require(current && defaults && localized, `Missing bound table: ${name}`);
    for (const table of [current, defaults, localized]) validateTable(table, name);
    require(same(current.columns, defaults.columns) && same(current.columns, localized.columns)
      && same(current.physical_fields, defaults.physical_fields) && same(current.physical_fields, localized.physical_fields), `Bound physical schema differs: ${name}`);
    for (const k of ['revision', 'sha256', 'native_specification_sha256']) require(source.schema?.[k] === observed.schema?.[k], `Bound schema identity differs: ${name}/${k}`);
    for (const k of ['game', 'game_patch', 'realm']) require(source.identity[k] === target[k], 'Target English package identity differs');
    const entry = binding.tables?.[name], textFields = Object.keys(catalogFields[name]);
    const nontext = defaults.physical_fields.filter(f => !textFields.includes(f));
    const key = name === 'Words' ? 'HASH32' : 'Id';
    require(entry?.key_field === key && same(entry.text_fields, textFields) && same(entry.nontext_fields, nontext)
      && Array.isArray(entry.records), `Bound field scope differs: ${name}`);
    const file = source.tablePayloads[name], payload = source.manifest.files[file];
    const raw = source.identity.raw_resources[current.raw_resource];
    // The binding contract pins these three schema identities. Additional package
    // metadata remains in provenance and is already sealed by the manifest hash.
    const schema = Object.fromEntries(['revision', 'sha256', 'native_specification_sha256'].map(k => [k, source.schema[k]]));
    const pins = { ...target, language: 'English', manifest_sha256: source.provenance.manifest_sha256,
      payload: file, payload_bytes: payload.bytes, payload_sha256: payload.sha256,
      table_pointer: file === 'tables.json' ? '/' + name : '', raw_resource: current.raw_resource,
      raw_identity: raw, schema, columns_sha256: sha(nativeBytes(current.columns.map(c => c.schema))) };
    require(same(entry.target_pins, pins), `Target pins differ: ${name}`);
    require(same(declaration.tables?.[name], { target_pins: pins, text_fields: textFields, nontext_fields: nontext }), `Target manifest/table declaration differs: ${name}`);
    const resourceEqual = same(observed.observedClient.resources[defaults.raw_resource], raw);
    require(entry.source_default_raw_equals_target === resourceEqual, `False resource binding: ${name}`);
    if (resourceEqual) require(same(defaults.rows, current.rows), `Equal raw resource has different decoded rows: ${name}`);
    const grouped = [defaults, localized, current].map(t => groups(t, key));
    const identities = new Set(grouped.flatMap(g => [...g.keys()])), seen = new Set(), records = [];
    for (const declared of entry.records) {
      const id = declared.id;
      require(identities.has(id) && !seen.has(id), `Incomplete/duplicate binding identity: ${name}`); seen.add(id);
      const rows = grouped.map(g => g.get(id) ?? []), reasons = [];
      ['source-default', 'source-localized', 'target'].forEach((role, i) => {
        if (!rows[i].length) reasons.push(role + '-missing-key');
        else if (rows[i].length !== 1) reasons.push(role + '-duplicate-key');
      });
      if (id === null || id === '') reasons.push('invalid-stable-key');
      let comparison = { source_nontext_equal: null, target_nontext_equal: null, target_english_equal: null };
      let differing = {}, english = {};
      const englishFields = [...textFields, ...(name === 'Words' ? ['Text'] : [])];
      if (rows[2].length === 1) english = Object.fromEntries(englishFields.map(f => [f, rows[2][0].values[f]]));
      if (rows.every(r => r.length === 1)) {
        const [a, b, c] = rows.map(r => r[0].values);
        differing = { source_nontext: nontext.filter(f => !same(a[f], b[f])),
          target_nontext: nontext.filter(f => !same(a[f], c[f])), target_english: englishFields.filter(f => !same(a[f], c[f])) };
        comparison = { source_nontext_equal: !differing.source_nontext.length,
          target_nontext_equal: !differing.target_nontext.length, target_english_equal: !differing.target_english.length };
        for (const [label, fields] of Object.entries(differing)) if (fields.length) reasons.push(label + '-mismatch');
      }
      const expected = { table: name, key_field: key, id, decision: reasons.length ? 'rejected' : 'accepted',
        binding_kind: resourceEqual ? 'resource-bound' : 'record-bound', reason_codes: reasons,
        source_default_rows: rows[0].map(r => r._row), source_localized_rows: rows[1].map(r => r._row),
        target_rows: rows[2].map(r => r._row), english, comparison, differing_fields: differing };
      require(same(declared, expected), `Target binding record differs from actual rows: ${name}/${id}`);
      records.push({ binding: expected, rows });
    }
    require(seen.size === identities.size, `Incomplete binding inventory: ${name}`);
    const summary = observed.manifest.summary;
    require(summary?.tables?.[name] === localized.rows.length && same(summary.bindings?.[name], {
      accepted: records.filter(r => r.binding.decision === 'accepted').length,
      rejected: records.filter(r => r.binding.decision === 'rejected').length }), `Observed binding summary differs: ${name}`);
    verified[name] = { records, target: current, localized, defaults, pins };
  }
  return { target, tables: verified, evidence: binding };
}
