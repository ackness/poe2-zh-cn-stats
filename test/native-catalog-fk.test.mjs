import test from 'node:test';
import assert from 'node:assert/strict';
import { Correspondence } from '../src/native-catalog-fk-binding.mjs';

const roles = ['source_default', 'source_localized', 'target'];
const fields = { BaseItemTypes: { Name: 'name', Inflection: 'inflection' }, Mods: { Name: 'name' } };
function table(name, rows) {
  const physical = Array.from({ length: name === 'BaseItemTypes' ? 34 : 81 }, (_, i) => 'Physical' + i);
  physical[0] = 'Id'; physical[name === 'BaseItemTypes' ? 4 : 9] = 'Name';
  const refs = name === 'BaseItemTypes' ? { 8: ['Implicit_Mods', 'Mods', true], 13: ['ItemVisualIdentity', 'ItemVisualIdentity', false], 21: ['FragmentBaseItemType', 'BaseItemTypes', false] }
    : { 2: ['ModType', 'ModType', false] };
  for (const [index, [field]] of Object.entries(refs)) physical[index] = field;
  const columns = physical.map((field, i) => ({ source_column: i, physical_fields: [field], schema: refs[i]
    ? { type: 'foreignrow', references: { table: refs[i][1] }, array: refs[i][2] }
    : { type: ['Id', 'Name'].includes(field) ? 'string' : 'i32', references: null, array: false } }));
  const blank = Object.fromEntries(columns.map(c => [c.physical_fields[0], c.schema.array ? [] : c.schema.type === 'foreignrow' ? null : c.schema.type === 'string' ? '' : 0]));
  return { table: name, physical_fields: physical, columns, rows: rows.map((values, i) => ({ _row: i, values: { ...structuredClone(blank), ...values } })) };
}
function fixture(a, b) {
  const sides = Object.fromEntries(roles.map(r => [r, { BaseItemTypes: table('BaseItemTypes', r === 'target' ? b : a) }]));
  const namespaces = Object.fromEntries(roles.map((r, i) => [r, { BaseItemTypes: { role: r, table: 'BaseItemTypes', manifest_sha256: String(i + 1).repeat(64), payload_sha256: 'a'.repeat(64) } }]));
  return { sides, namespaces, engine: () => new Correspondence(sides, namespaces, fields) };
}
test('v3 equivalent reordered multi-node and self cycles complete before accepting', () => {
  let f = fixture([{ Id: 'A', FragmentBaseItemType: 1 }, { Id: 'B', FragmentBaseItemType: 0 }], [{ Id: 'B', FragmentBaseItemType: 1 }, { Id: 'A', FragmentBaseItemType: 0 }]);
  let witness = f.engine().edge('BaseItemTypes', 'FragmentBaseItemType', 0, 1, 'target');
  assert.deepEqual(witness.reason_codes, []); assert.equal(witness.closure_nodes, 2);
  f = fixture([{ Id: 'A', FragmentBaseItemType: 0 }], [{ Id: 'A', FragmentBaseItemType: 0 }]);
  witness = f.engine().edge('BaseItemTypes', 'FragmentBaseItemType', 0, 0, 'target');
  assert.deepEqual(witness.reason_codes, []); assert.equal(witness.closure_nodes, 1);
});
test('v3 late scalar/English cycle drift rejects both roots regardless of order', () => {
  const a = [{ Id: 'A', FragmentBaseItemType: 1 }, { Id: 'B', FragmentBaseItemType: 0 }];
  for (const patch of [{ Physical2: 9 }, { Name: 'Changed English' }]) for (const order of [[0, 1], [1, 0]]) {
    const b = structuredClone(a); Object.assign(b[1], patch); const engine = fixture(a, b).engine();
    for (const root of order) assert(engine.edge('BaseItemTypes', 'FragmentBaseItemType', root, root, 'target').reason_codes.includes('fk-required-structure-mismatch'));
  }
});
test('v3 ordered references, missing lengths, duplicate identities and bad bounds reject', () => {
  const f = fixture([{ Id: 'A' }], [{ Id: 'A' }]);
  for (const r of roles) { f.sides[r].Mods = table('Mods', [{ Id: 'X' }, { Id: 'Y' }]); f.namespaces[r].Mods = { ...f.namespaces[r].BaseItemTypes, table: 'Mods' }; }
  let engine = f.engine();
  for (const [a, b, reason] of [[[0, 1], [1, 0], 'fk-key-mismatch'], [[0, 1], [0], 'fk-array-shape-mismatch'], [[0], [7], 'fk-row-out-of-range']])
    assert(engine.edge('BaseItemTypes', 'Implicit_Mods', a, b, 'target').reason_codes.includes(reason));
  f.sides.target.Mods.rows[1].values.Id = 'X'; engine = f.engine();
  assert(engine.edge('BaseItemTypes', 'Implicit_Mods', [0], [0], 'target').reason_codes.includes('fk-invalid-or-duplicate-key'));
});
test('v3 witnesses bind role and exact package/payload, never stable key alone', () => {
  const f = fixture([{ Id: 'A' }], [{ Id: 'A' }]);
  const first = f.engine().edge('BaseItemTypes', 'FragmentBaseItemType', 0, 0, 'target').closure_sha256;
  f.namespaces.target.BaseItemTypes.payload_sha256 = 'b'.repeat(64);
  assert.notEqual(first, f.engine().edge('BaseItemTypes', 'FragmentBaseItemType', 0, 0, 'target').closure_sha256);
  f.namespaces.target.BaseItemTypes.role = 'source_default'; assert.throws(f.engine, /namespace/u);
});
test('v3 Key3 must remain the declared ItemVisualIdentity physical column 65', () => {
  const sides = {}, namespaces = {};
  for (const role of roles) {
    const physical = Array.from({ length: 66 }, (_, i) => 'Physical' + i);
    const refs = { 17: ['StartSkillGem', 'BaseItemTypes'], 23: ['StartWeapons', 'BaseItemTypes'], 60: ['StartingWeapon', 'BaseItemTypes'], 64: ['Key3', 'ItemVisualIdentity'] };
    physical[0] = 'Id';
    for (const [at, [field]] of Object.entries(refs)) physical[at] = field;
    sides[role] = { Characters: { table: 'Characters', physical_fields: physical, rows: [], columns: physical.map((f, i) => ({ physical_fields: [f], schema: {
      type: refs[i] ? 'foreignrow' : 'string', array: i === 23, references: refs[i] ? { table: refs[i][1] } : null,
    } })) } };
    namespaces[role] = { Characters: { role, table: 'Characters', manifest_sha256: 'a'.repeat(64), payload_sha256: 'b'.repeat(64) } };
  }
  assert.throws(() => new Correspondence(sides, namespaces, {}), /Characters.Key3/u);
});
