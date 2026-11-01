// Explicit community interpretation; complete reachable constraints precede acceptance.
import { createHash } from 'node:crypto';
import { canonical, nativeBytes } from './native-localization.mjs';
import { verifyObservedBindings } from './native-catalog-binding.mjs';

export const FK_POLICY = 'stable-key-pinned-fk-structure/v1';
export function projectFkBinding(binding) {
  const { closures, namespaces, ...summary } = binding;
  return { ...summary, tables: Object.fromEntries(Object.entries(binding.tables).map(([name, table]) => [name, {
    ...table, records: table.records.map(({ strict_v2, fk_witnesses, ...record }) => record),
  }])) };
}
const interpretation = 'community-reader-language-fallback/v1';
const roles = ['source_default', 'source_localized', 'target'];
const dependencies = ['ItemVisualIdentity', 'ModType', 'Stats'];
const edges = {
  BaseItemTypes: { Implicit_Mods: 'Mods', ItemVisualIdentity: 'ItemVisualIdentity', FragmentBaseItemType: 'BaseItemTypes' },
  Mods: { ModType: 'ModType' }, Characters: { StartSkillGem: 'BaseItemTypes', StartWeapons: 'BaseItemTypes', StartingWeapon: 'BaseItemTypes', Key3: 'ItemVisualIdentity' },
  AlternateQualityTypes: { Item: 'BaseItemTypes' }, ModType: { Stat: 'Stats' },
  ItemVisualIdentity: { UniqueStat1: 'Stats', UniqueStat2: 'Stats', UniqueStat3: 'Stats', UniqueStat4: 'Stats' },
};
const ordinals = { BaseItemTypes: { Implicit_Mods: 8, ItemVisualIdentity: 13, FragmentBaseItemType: 21 }, Mods: { ModType: 2 },
  Characters: { StartSkillGem: 17, StartWeapons: 23, StartingWeapon: 60, Key3: 65 }, AlternateQualityTypes: { Item: 2 }, ModType: { Stat: 1 },
  ItemVisualIdentity: { UniqueStat1: 65, UniqueStat2: 66, UniqueStat3: 67, UniqueStat4: 68 } };
const sha = raw => createHash('sha256').update(raw).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const require = (ok, message) => { if (!ok) throw new Error(message); };
const keyField = name => name === 'Words' ? 'HASH32' : name === 'ModType' ? 'Name' : 'Id';
const reader = { repository: 'https://github.com/repoe-fork/pypoe', revision: '66d1d7442c5718260e1a8efd24989d22987e91af',
  path: 'PyPoE/poe/file/dat.py', sha256: '19f114e1a763a177a2c9a9aa36af9798341ef1a7f496219fdb8fcd54fb823d43', symbol: 'RelationalReader.__getitem__', lines: [1173, 1187] };
const interpretationDeclaration = { id: interpretation, authority: 'community-interpretation', official_client_semantics_verified: false, reader };

function validateDependency(table, name) {
  const widths = { string: 8, foreignrow: 16, row: 8, enumrow: 4, bool: 1, i32: 4, u32: 4, u16: 2, f32: 4 };
  require(table.table === name && table.physical_fields.length === table.columns.length && table.validation.rows === table.rows.length, 'Invalid dependency shape');
  let rowBytes = 0;
  table.columns.forEach((c, i) => {
    require(c.source_column === i && same(c.physical_fields, [table.physical_fields[i]]) && !c.schema.interval, 'Invalid dependency physical column');
    const width = c.schema.array || c.schema.type === 'array' ? 16 : widths[c.schema.type];
    require(width, 'Unsupported dependency wire type'); rowBytes += width;
  });
  require(table.validation.schema_row_bytes === rowBytes && table.validation.actual_row_bytes === rowBytes, 'Dependency framing differs');
  const scalar = (value, type) => {
    if (type === 'string') return typeof value === 'string';
    if (type === 'bool') return typeof value === 'boolean';
    if (value === null) return !['u16', 'byte'].includes(type);
    if (type === 'f32') return typeof value === 'number' && Number.isFinite(value);
    if (!Number.isSafeInteger(value)) return false;
    const bounds = { byte: [-128, 127], i32: [-2147483648, 2147483647], enumrow: [-2147483648, 2147483647], u32: [0, 4294967295], u16: [0, 65535] };
    return bounds[type] ? value >= bounds[type][0] && value <= bounds[type][1] : ['row', 'foreignrow'].includes(type) && value >= 0;
  };
  table.rows.forEach((row, i) => {
    require(row._row === i && same(Object.keys(row.values).sort(), [...table.physical_fields].sort()), 'Dependency row fields differ');
    table.columns.forEach(c => {
      const value = row.values[c.physical_fields[0]], s = c.schema;
      require(s.array || s.type === 'array' ? Array.isArray(value) && value.every(v => scalar(v, s.type === 'array' ? 'byte' : s.type)) : scalar(value, s.type), 'Dependency typed value differs');
    });
  });
}

export class Correspondence {
  constructor(sides, namespaces, catalogFields) {
    require(same(Object.keys(sides).sort(), [...roles].sort()) && same(Object.keys(namespaces).sort(), [...roles].sort()), 'Explicit three-sided FK namespace required');
    this.sides = sides; this.namespaces = namespaces; this.fields = catalogFields; this.groups = {}; this.closures = {};
    for (const role of roles) {
      this.groups[role] = {};
      require(same(Object.keys(namespaces[role]).sort(), Object.keys(sides[role]).sort()), 'Incomplete FK namespace');
      for (const [name, table] of Object.entries(sides[role])) {
        const pin = namespaces[role][name];
        require(pin.role === role && pin.table === name && ['manifest_sha256', 'payload_sha256'].every(k => /^[a-f0-9]{64}$/u.test(pin[k])), 'Invalid FK package namespace');
        const original = sides.source_default[name];
        require(original && same(table.columns, original.columns) && same(table.physical_fields, original.physical_fields), 'FK physical schema differs between roles');
        const grouped = new Map();
        table.rows.forEach((row, i) => { require(row._row === i, 'Noncontiguous FK rows'); const key = row.values[keyField(name)];
          if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); });
        this.groups[role][name] = grouped;
        for (const [field, target] of Object.entries(edges[name] ?? {})) {
          const column = table.columns.find(c => c.physical_fields.includes(field))?.schema;
          require(column?.references?.table === target && ['row', 'foreignrow'].includes(column.type)
            && table.physical_fields[ordinals[name][field]] === field, `FK policy differs from pinned schema: ${name}.${field}`);
        }
      }
    }
  }
  resolve(role, name, pointer) {
    const table = this.sides[role][name];
    if (!table) return [null, 'fk-missing-table'];
    if (!Number.isSafeInteger(pointer) || pointer < 0 || pointer >= table.rows.length) return [null, 'fk-row-out-of-range'];
    const row = table.rows[pointer], key = row.values[keyField(name)];
    if (key === null || key === '' || this.groups[role][name].get(key)?.length !== 1) return [null, 'fk-invalid-or-duplicate-key'];
    return [row, null];
  }
  isArray(name, field) { return this.sides.source_default[name].columns.find(c => c.physical_fields.includes(field)).schema.array; }
  edge(table, field, left, right, rightRole) {
    require(['source_localized', 'target'].includes(rightRole), 'Invalid comparison role');
    const target = edges[table][field], [aa, bb] = this.isArray(table, field) ? [left, right] : [[left], [right]];
    const witness = { field, target_table: target, right_role: rightRole, left_rows: aa, right_rows: bb, left_keys: [], right_keys: [], reason_codes: [] };
    if (!Array.isArray(aa) || !Array.isArray(bb) || aa.length !== bb.length) return { ...witness, reason_codes: ['fk-array-shape-mismatch'], closure_nodes: 0, closure_sha256: null };
    const queue = [], nodes = [], visited = new Set(), reasons = [];
    const enqueue = (name, x, y) => {
      if (x === null || y === null) { if (x !== y) reasons.push('fk-null-mismatch'); return [null, null]; }
      const [a, ae] = this.resolve('source_default', name, x), [b, be] = this.resolve(rightRole, name, y);
      if (ae || be) { reasons.push(...[ae, be].filter(Boolean)); return [null, null]; }
      const ak = a.values[keyField(name)], bk = b.values[keyField(name)];
      if (!same(ak, bk)) reasons.push('fk-key-mismatch'); else queue.push([name, x, y]);
      return [ak, bk];
    };
    aa.forEach((x, i) => { const [a, b] = enqueue(target, x, bb[i]); witness.left_keys.push(a); witness.right_keys.push(b); });
    while (queue.length) {
      const [name, x, y] = queue.pop(), visitKey = JSON.stringify([name, x, y]);
      if (visited.has(visitKey)) continue;
      visited.add(visitKey); require(visited.size <= 100000, 'FK closure exceeds bounded table scope');
      const a = this.sides.source_default[name].rows[x].values, b = this.sides[rightRole][name].rows[y].values;
      const ignored = rightRole === 'source_localized' ? Object.keys(this.fields[name] ?? {}) : [], differences = [], nodeEdges = [];
      for (const column of this.sides.source_default[name].physical_fields) {
        if (ignored.includes(column)) continue;
        if (!edges[name]?.[column]) { if (!same(a[column], b[column])) differences.push(column); continue; }
        const dest = edges[name][column], [av, bv] = this.isArray(name, column) ? [a[column], b[column]] : [[a[column]], [b[column]]];
        const detail = { field: column, target_table: dest, left_rows: av, right_rows: bv, left_keys: [], right_keys: [] };
        if (!Array.isArray(av) || !Array.isArray(bv) || av.length !== bv.length) reasons.push('fk-array-shape-mismatch');
        else av.forEach((xx, i) => { const [ak, bk] = enqueue(dest, xx, bv[i]); detail.left_keys.push(ak); detail.right_keys.push(bk); });
        nodeEdges.push(detail);
      }
      if (differences.length) reasons.push('fk-required-structure-mismatch');
      nodes.push({ table: name, key: a[keyField(name)], left_row: x, right_row: y, left_namespace: this.namespaces.source_default[name],
        right_namespace: this.namespaces[rightRole][name], differing_fields: differences, edges: nodeEdges });
    }
    nodes.sort((a, b) => a.table < b.table ? -1 : a.table > b.table ? 1 : a.left_row - b.left_row || a.right_row - b.right_row);
    const closure = { right_role: rightRole, nodes }, hash = sha(nativeBytes(closure));
    this.closures[hash] = closure;
    return { ...witness, reason_codes: [...new Set(reasons)].sort(), closure_nodes: nodes.length, closure_sha256: hash };
  }
  compare(name, a, b, role) {
    const differing = [], witnesses = [], ignored = Object.keys(this.fields[name]);
    for (const field of this.sides.source_default[name].physical_fields) {
      if (ignored.includes(field)) continue;
      if (edges[name]?.[field]) { const w = this.edge(name, field, a[field], b[field], role); witnesses.push(w); if (w.reason_codes.length) differing.push(field); }
      else if (!same(a[field], b[field])) differing.push(field);
    }
    return [differing, witnesses];
  }
  bind(strictBinding) {
    const result = structuredClone(strictBinding);
    result.policy_id = FK_POLICY;
    result.reference_policy = 'Only declared pinned FK edges use ordered stable-key full reachable structure; all other physical values remain strict.';
    result.interpretation = { id: interpretation, authority: 'community-interpretation', official_client_semantics_verified: false };
    for (const [name, table] of Object.entries(result.tables)) for (const record of table.records) {
      record.strict_v2 = Object.fromEntries(['decision', 'reason_codes', 'comparison', 'differing_fields'].map(k => [k, record[k]]));
      record.fk_witnesses = { source: [], target: [] };
      const rowLists = [record.source_default_rows, record.source_localized_rows, record.target_rows];
      if (!rowLists.every(r => r.length === 1)) continue;
      const [a, b, c] = roles.map((role, i) => this.sides[role][name].rows[rowLists[i][0]].values);
      const [sd, sw] = this.compare(name, a, b, 'source_localized'), [td, tw] = this.compare(name, a, c, 'target');
      const ed = record.strict_v2.differing_fields.target_english;
      record.fk_witnesses = { source: sw, target: tw };
      record.differing_fields = { source_nontext: sd, target_nontext: td, target_english: ed };
      record.comparison = { source_nontext_equal: !sd.length, target_nontext_equal: !td.length, target_english_equal: !ed.length };
      const reasons = Object.entries(record.differing_fields).filter(([, fs]) => fs.length).map(([label]) => label + '-mismatch');
      reasons.push(...[...new Set([...sw, ...tw].flatMap(w => w.reason_codes))].sort());
      if (record.id === null || record.id === '') reasons.push('invalid-stable-key');
      record.reason_codes = reasons; record.decision = reasons.length ? 'rejected' : 'accepted';
      if (record.decision === 'accepted' && record.strict_v2.decision === 'rejected') record.binding_kind = 'fk-structure-bound';
    }
    result.closures = Object.fromEntries(Object.entries(this.closures).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    result.namespaces = this.namespaces;
    return result;
  }
}

function namespace(role, name, manifestSha, payloadPin, table, rawPin) {
  return { role, table: name, manifest_sha256: manifestSha, payload_sha256: payloadPin.sha256, raw_resource: table.raw_resource, raw_identity: rawPin };
}

/** File hashes are checked by readNamePackage before this independent recomputation. */
export function verifyFkBindings(observed, owners, tables, catalogFields) {
  const retained = observed.retained, manifest = observed.manifest;
  const strictManifest = retained['strict-manifest.json'], strictBinding = retained['strict-binding.json'];
  require(manifest.format === 'repoe-localized-tables/v3' && manifest.parent_manifest_sha256 === manifest.files['strict-manifest.json'].sha256
    && strictManifest.format === 'repoe-localized-tables/v2', 'Invalid strict v2 parent');
  for (const [file, pin] of Object.entries(strictManifest.files)) require(same(pin, manifest.files[file === 'target_binding.json' ? 'strict-binding.json' : file]), 'Frozen strict payload changed');
  const strictObserved = { ...observed, manifest: strictManifest, binding: strictBinding };
  const verified = verifyObservedBindings(strictObserved, owners, tables, catalogFields);
  const lock = retained['fk-policy-lock.json'], meta = retained['fk-dependencies.json'];
  require(lock.format === 'repoe-fk-policy-lock/v1' && lock.policy_id === FK_POLICY && lock.base_manifest_sha256 === manifest.parent_manifest_sha256
    && same(lock.edges, edges) && same(lock.interpretation, interpretationDeclaration) && same(meta.interpretation, interpretationDeclaration)
    && manifest.fk.policy_lock_sha256 === manifest.files['fk-policy-lock.json'].sha256, 'Wrong explicit FK policy/interpretation');
  const sides = { source_default: { ...observed.defaultTables }, source_localized: { ...observed.tables }, target: Object.fromEntries(tables.map(n => [n, owners[n].tables[n]])) };
  const namespaces = Object.fromEntries(roles.map(r => [r, {}]));
  for (const role of roles) for (const name of tables) {
    const table = sides[role][name], p = strictBinding.tables[name].target_pins;
    namespaces[role][name] = role === 'target' ? namespace(role, name, p.manifest_sha256, { sha256: p.payload_sha256 }, table, p.raw_identity)
      : namespace(role, name, manifest.parent_manifest_sha256, manifest.files[role === 'source_default' ? 'default-tables.json' : 'tables.json'], table, observed.observedClient.resources[table.raw_resource]);
  }
  const packageData = {};
  for (const [id, pkg] of Object.entries(meta.packages)) {
    const m = retained[pkg.manifest]; require(m && manifest.files[pkg.manifest], 'Missing pinned dependency manifest');
    const docs = {};
    for (const [original, file] of Object.entries(pkg.files)) { require(same(m.files[original], manifest.files[file]), 'Dependency payload pin differs'); docs[original] = retained[file]; }
    packageData[id] = { manifest: m, manifestSha: manifest.files[pkg.manifest].sha256, docs };
  }
  const source = packageData.source, lookup = source.docs['index-lookup.json'], acquisition = source.docs['acquisition.json'];
  require(source.manifestSha === lock.source_dependency.manifest_sha256 && same(source.manifest.observed_client, retained['transfer-receipt.json'].observed_client)
    && source.manifest.format === 'repoe-observed-fk-dependencies/v1' && lookup.index.stable === true
    && lookup.index.sha256 === observed.observedClient.index_sha256 && acquisition.index.prior_sha256 === observed.observedClient.index_sha256
    && acquisition.index.stable === true && same(acquisition.index.before, acquisition.index.after)
    && acquisition.lookup_receipt_sha256 === source.manifest.files['index-lookup.json'].sha256,
  'Dependency index/observation identity differs');
  require(same(Object.keys(lock.targets).sort(), [...dependencies].sort()) && same(Object.keys(source.docs['tables.json']).sort(), [...dependencies].sort()), 'Wrong dependency scope');
  for (const name of dependencies) for (const role of roles) {
    const selection = meta.roles[role][name], pkg = packageData[selection.package];
    require(pkg, 'Wrong dependency package namespace');
    const table = selection.table_pointer === '/' + name ? pkg.docs[selection.payload]?.[name] : selection.table_pointer === '' ? pkg.docs[selection.payload] : null;
    require(table?.table === name, 'Wrong dependency table pointer'); validateDependency(table, name);
    const resource = `data/balance/${name.toLowerCase()}.datc64`;
    require(table.raw_resource.toLowerCase() === resource, 'Wrong dependency resource namespace');
    const rawPin = (role === 'target' ? pkg.manifest.source_identity.raw_resources : pkg.manifest.raw_resources)[table.raw_resource];
    const expected = namespace(role, name, pkg.manifestSha, pkg.manifest.files[selection.payload], table, rawPin);
    require(same(selection.namespace, expected), 'Dependency role/package pin differs');
    if (role === 'target') {
      require(pkg.manifestSha === lock.targets[name].manifest_sha256 && selection.resolution === 'exact-English-target', 'Wrong target dependency package');
      for (const k of ['game', 'game_patch', 'realm']) require(pkg.manifest.source_identity[k] === verified.target[k], 'Dependency target identity differs');
      require((pkg.manifest.source_identity.language ?? 'English') === 'English', 'Dependency target language differs');
    } else {
      require(selection.package === 'source' && selection.index_sha256 === observed.observedClient.index_sha256, 'Wrong source dependency namespace');
      const found = lookup.tables.filter(t => t.table === name), raw = acquisition.local_preservation.resources.filter(t => t.table === name);
      require(found.length === 1 && found[0].default.status === 'present' && found[0].default.observed_exact_path === resource
        && raw.length === 1 && raw[0].path === resource && same(raw[0].identity, rawPin), 'Dependency acquisition differs');
      const absent = found[0].simplified_chinese, sc = `data/balance/simplified chinese/${name.toLowerCase()}.datc64`;
      require(absent.length === 1 && absent[0].status === 'absent' && absent[0].query_path.toLowerCase() === sc, 'Missing exact SC absence evidence');
      require(selection.resolution === (role === 'source_default' ? 'exact-default' : interpretation)
        && selection.absent_exact_path === (role === 'source_default' ? null : sc), 'Wrong community fallback declaration');
    }
    for (const k of ['revision', 'sha256', 'native_specification_sha256']) require(pkg.manifest.schema[k] === observed.schema[k], 'Dependency schema identity differs');
    sides[role][name] = table; namespaces[role][name] = expected;
  }
  const result = new Correspondence(sides, namespaces, catalogFields).bind(strictBinding);
  require(same(result, observed.binding), 'FK binding/witness differs from full independent recomputation');
  for (const name of tables) {
    require(same(observed.manifest.summary.bindings[name], { accepted: result.tables[name].records.filter(r => r.decision === 'accepted').length,
      rejected: result.tables[name].records.filter(r => r.decision === 'rejected').length }), 'FK summary differs');
    verified.tables[name].records.forEach((r, i) => { r.binding = result.tables[name].records[i]; });
  }
  verified.evidence = result;
  return verified;
}
