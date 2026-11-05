import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeLocalization, canonical } from '../../src/native-localization.mjs';

// Synthetic branch envelopes only, not acquired game rows or source approval.
// Keep the source lexer's raw metadata, including its escaped-brace diagnostic.
function branch(template, conditions) {
  const characters = Array.from(template), consumed = new Set(), diagnostics = [];
  const placeholders = [...characters.join('').matchAll(/\{([^{}]*)\}/gu)].map(match => {
    const syntax = /^([0-9]*)(?::([^{}]*))?$/u.exec(match[1]);
    const start = Array.from(template.slice(0, match.index)).length, end = start + Array.from(match[0]).length;
    for (let i = start; i < end; i++) consumed.add(i);
    if (!syntax) diagnostics.push({ code: 'unresolved_placeholder_syntax', template_character_span: [start, end] });
    return { token_raw: match[0], index_token_raw: syntax?.[1] ?? null, format_raw: syntax?.[2] ?? null,
      syntax_status: syntax ? 'recognized-lexical' : 'unresolved-placeholder-syntax', template_character_span: [start, end] };
  });
  characters.forEach((c, i) => { if ('{}'.includes(c) && !consumed.has(i)) diagnostics.push({ code: 'unmatched_template_delimiter', template_character_span: [i, i + 1] }); });
  return { template_raw: template, placeholders, condition_tokens_raw: conditions, restrictions_raw: [],
    quantifier_tokens_raw: [], quantifiers_lexical: [], template_syntax_diagnostics: diagnostics,
    span: { byte_start: 2, byte_end: 2000, line_start: 1, line_end: 1 } };
}
function fixture(english, chinese, arity = 1) {
  const file = 'Data/StatDescriptions/stat_descriptions.csd', conditions = Array(arity).fill('#');
  const en = branch(english, conditions), cn = branch(chinese, conditions);
  const record = { kind: 'description', ids: Array.from({ length: arity }, (_, i) => `stat_${i}`),
    groups: [{ declared_language: null, branches: [en] }, { declared_language: 'Simplified Chinese', branches: [cn] }] };
  const input = { manifest: { source_identity: { game: 'poe2', realm: 'international', game_patch: 'synthetic-test' }, producer: { synthetic: 'a'.repeat(64) } },
    manifestSha256: 'b'.repeat(64), document: { roots: [file], files: { [file]: { records: [record] } } }, diagnostics: [] };
  return { input, record, en, cn };
}

test('placeholder contract: automatic numbering pairs with explicit equivalents and preserves every raw token/ref', () => {
  const { input } = fixture('Gain {} Life and {:d} Mana', '获得 {1:d} 魔力和 {0} 生命', 2);
  const before = canonical(input), result = buildNativeLocalization(input);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].default_template_raw, 'Gain {} Life and {:d} Mana');
  assert.deepEqual(result.pairs[0].placeholders.default.map(p => p.index_token_raw), ['', '']);
  assert.deepEqual(result.pairs[0].placeholders.chinese.map(p => p.index_token_raw), ['1', '0']);
  assert.deepEqual(result.pairs[0].default_reference, { file: input.document.roots[0], record: 0, group: 0, branch: 0 });
  assert.equal(canonical(input), before);
});

test('placeholder contract: explicit indices reset the next automatic index, including backward resets', () => {
  for (const [left, right, arity] of [
    ['{1} then {}', '先 {2} 后 {1}', 3],
    ['{} then {0:d} then {:+d}', '先 {1:+d} 后 {0:d} 和 {0}', 2],
    ['{1} then {} then {0} then {}', '甲 {1} 乙 {0} 丙 {2} 丁 {1}', 3],
  ]) assert.equal(buildNativeLocalization(fixture(left, right, arity).input).pairs.length, 1, left);
  const bad = buildNativeLocalization(fixture('{1} then {}', '先 {0} 后 {1}', 3).input);
  assert.equal(bad.pairs.length, 0); assert.ok(bad.excluded.every(r => r.reason === 'unmatched-branch-signature'));
});

test('placeholder contract: raw default-negative and explicit-positive formats and external signs remain distinct', () => {
  for (const format of ['d', '-d', '+d']) {
    const { input } = fixture(`Value {:${format}}`, `数值 {0:${format}}`);
    const result = buildNativeLocalization(input); assert.equal(result.pairs.length, 1);
    assert.equal(result.pairs[0].placeholders.default[0].format_raw, format);
  }
  for (const [left, right] of [['{:+d}', '数值 {0:d}'], ['−{}', '数值 {0}']]) {
    assert.equal(buildNativeLocalization(fixture(left, right).input).pairs.length, 0);
  }
});

test('placeholder contract: unknown formats, nonnumeric indices and explicit/automatic overflow stay excluded', () => {
  for (const [left, right, reason] of [
    ['{1}', '数值 {1}', 'placeholder-index-out-of-range'],
    ['{0} {}', '数值 {0} {}', 'placeholder-index-out-of-range'],
    ['{9007199254740993}', '数值 {9007199254740993}', 'placeholder-index-out-of-range'],
    ['{:x}', '数值 {:x}', 'unsupported-placeholder-format'],
    ['{:}', '数值 {:}', 'unsupported-placeholder-format'],
    ['{name}', '数值 {name}', 'unresolved-template-syntax'],
  ]) {
    const result = buildNativeLocalization(fixture(left, right).input);
    assert.equal(result.pairs.length, 0, left); assert.ok(result.excluded.some(r => r.reason === reason), `${left}: ${JSON.stringify(result.excluded)}`);
  }
});

test('placeholder contract: source escaped-brace diagnostics remain exclusions without source repairs', () => {
  const { input, en, cn } = fixture('{{literal}} {}', '{{字面}} {0}');
  assert.ok(en.template_syntax_diagnostics.length); assert.ok(cn.template_syntax_diagnostics.length);
  input.diagnostics = [{ code: 'unresolved_placeholder_syntax', raw: en.template_syntax_diagnostics }];
  const before = canonical(input), result = buildNativeLocalization(input);
  assert.equal(result.pairs.length, 0);
  assert.ok(result.excluded.every(r => r.reason === 'unresolved-template-syntax'));
  assert.deepEqual(result.source_diagnostics, input.diagnostics); assert.equal(canonical(input), before);
});

test('placeholder contract: literal numbers, ordered handlers, restrictions, collisions and missing groups are not relaxed', () => {
  const literal = buildNativeLocalization(fixture('After 2 seconds {}', '3 秒后 {0}').input);
  assert.equal(literal.pairs.length, 0); assert.equal(literal.excluded[0].reason, 'literal-number-mismatch');
  for (const change of [
    ({ cn }) => { cn.quantifier_tokens_raw = ['negate', '1']; },
    ({ cn }) => { cn.restrictions_raw = ['quality']; },
    ({ cn }) => { cn.condition_tokens_raw = ['1|#']; },
    ({ record, en }) => { record.groups[0].branches.push(structuredClone(en)); },
    ({ record }) => { record.groups.pop(); },
  ]) {
    const value = fixture('Gain {} Life', '获得 {0} 生命'); change(value);
    assert.equal(buildNativeLocalization(value.input).pairs.length, 0);
  }
});
