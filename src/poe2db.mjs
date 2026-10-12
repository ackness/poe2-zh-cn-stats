import { load } from 'cheerio';
import { normalizeText, slotCount } from './text.mjs';

export class PoE2DBDecodeError extends SyntaxError {
  constructor(message, url, cause) {
    super(`${message} (${url ?? 'unknown page'})`, { cause });
    this.name = 'PoE2DBDecodeError';
    this.code = 'POE2DB_DECODE';
    this.url = url;
  }
}

// Read JSON literals, never JavaScript expressions. Quoted/commented examples
// are not constructors. Remote scripts and HTML event handlers never execute.
function payloads($, url) {
  const result = [];
  $('script:not([src])').each((scriptIndex, element) => {
    const source = $(element).text();
    for (let i = 0; i < source.length;) {
      const ch = source[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        for (i++; i < source.length; i++) {
          if (source[i] === '\\') i++;
          else if (source[i] === quote) { i++; break; }
        }
        continue;
      }
      if (source.startsWith('//', i)) {
        const end = source.indexOf('\n', i + 2);
        i = end < 0 ? source.length : end + 1;
        continue;
      }
      if (source.startsWith('/*', i)) {
        const end = source.indexOf('*/', i + 2);
        i = end < 0 ? source.length : end + 2;
        continue;
      }
      const call = (i === 0 || !/[\w$]/u.test(source[i - 1]))
        && /^new\s+ModsView\s*\(/u.exec(source.slice(i));
      if (!call) { i++; continue; }
      let start = i + call[0].length;
      while (/\s/u.test(source[start] ?? '') && start < source.length) start++;
      if (!['{', '['].includes(source[start])) {
        throw new PoE2DBDecodeError('ModsView requires a JSON object or array literal', url);
      }
      let depth = 0;
      let quoted = false;
      let end = start;
      for (; end < source.length; end++) {
        const c = source[end];
        if (quoted) {
          if (c === '\\') end++;
          else if (c === '"') quoted = false;
        } else if (c === '"') quoted = true;
        else if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) { end++; break; }
        }
      }
      let value;
      try {
        value = JSON.parse(source.slice(start, end));
      } catch (cause) {
        throw new PoE2DBDecodeError('Malformed ModsView JSON', url, cause);
      }
      let close = end;
      while (close < source.length && /\s/u.test(source[close])) close++;
      if (source[close] !== ')') {
        throw new PoE2DBDecodeError('Unexpected expression after ModsView JSON', url);
      }
      result.push({ value, scriptIndex });
      i = close + 1;
    }
  });
  return result;
}

const number = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const rangePattern = new RegExp(`^(${number})[—–-](${number})$`, 'u');
const scalarPattern = new RegExp(`^${number}$`, 'u');

function numericValue(text) {
  let value = text.replace(/\s/gu, '');
  const percent = value.endsWith('%');
  if (percent) value = value.slice(0, -1);
  // A sign outside parentheses applies to the complete value range.
  const wrapped = /^([+-]?)\((.*)\)$/u.exec(value);
  const prefix = wrapped?.[1] ?? (/^[+-]/u.exec(value)?.[0] ?? '');
  const body = wrapped ? wrapped[2] : value;
  const range = rangePattern.exec(body);
  if (!range && !scalarPattern.test(body)) return null;
  const values = range ? [Number(range[1]), Number(range[2])] : [Number(body), Number(body)];
  if (wrapped?.[1] === '-') {
    values[0] *= -1;
    values[1] *= -1;
  }
  if (!values.every(Number.isFinite)) return null;
  return { values, sign: prefix, percent, replacement: `${prefix}#${percent ? '%' : ''}` };
}

function rendered(html) {
  const $ = load(html, null, false);
  if ($('script, style, iframe, object').length) return { error: 'unsafe-rendered-markup' };
  if ($('span.mod-value span.mod-value').length) return { error: 'nested-value-spans' };
  const values = [];
  let error;
  $('span.mod-value').each((_, element) => {
    const value = numericValue($(element).text());
    if (!value) { error = 'unsupported-value-span'; return; }
    values.push({ range: value.values, sign: value.sign, percent: value.percent });
    $(element).text(value.replacement);
  });
  if (error) return { error };
  // Preserve line boundaries as whitespace rather than concatenating words.
  $('br').replaceWith('\n');
  $('div, p, li').each((_, element) => { $(element).prepend('\n').append('\n'); });
  const text = normalizeText($.root().text());
  if (!text || slotCount(text) !== values.length) return { error: 'unmarked-placeholder-or-empty-text' };
  return { text, values, keywords: [...new Set($('[data-keyword]').map((_, e) => $(e).attr('data-keyword')).get())].sort() };
}

function stringSet(value) {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
    ? [...new Set(value)].sort() : null;
}

function poolRows(value, path = []) {
  if (Array.isArray(value)) {
    // Configuration arrays are not modifier pools.
    return value.some(row => row && typeof row === 'object' && 'str' in row && 'ModFamilyList' in row)
      ? [{ path, rows: value }] : [];
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    ['config', 'baseitem', 'gen', 'opt'].includes(key) ? [] : poolRows(child, [...path, key]));
}

function readPage(html, url, locale, issues) {
  if (typeof html !== 'string') throw new TypeError('Expected page HTML');
  const $ = load(html);
  const rows = [];
  let supported = false;
  for (const { value, scriptIndex } of payloads($, url)) {
    for (const pool of poolRows(value)) {
      supported = true;
      for (const [index, row] of pool.rows.entries()) {
        const source = { shape: 'ModsView', scriptIndex, pool: pool.path, index };
        const reject = reason => issues.push({ type: reason, locale, url, source });
        if (!row || typeof row.str !== 'string' || !stringSet(row.ModFamilyList)?.length
          || !/^\d+$/u.test(String(row.Level)) || !/^\d+$/u.test(String(row.ModGenerationTypeID))) {
          reject('invalid-mod-row'); continue;
        }
        const view = rendered(row.str);
        if (view.error) { reject(view.error); continue; }
        const tags = {};
        let invalid = false;
        for (const key of ['fossil_no', 'adds_no', 'spawn_no']) {
          if (row[key] !== undefined) {
            tags[key] = stringSet(row[key]);
            if (!tags[key]) invalid = true;
          }
        }
        if (row.mod_no !== undefined) {
          if (!stringSet(row.mod_no)) invalid = true;
          else {
            const tagHtml = load(row.mod_no.join(''), null, false);
            tags.mod_no = [...new Set(tagHtml('[data-tag]').map((_, e) => tagHtml(e).attr('data-tag')).get())].sort();
            if (row.mod_no.length && !tags.mod_no.length) invalid = true;
          }
        }
        if (invalid) { reject('unsupported-tag-metadata'); continue; }
        const identity = {
          shape: 'ModsView', family: stringSet(row.ModFamilyList),
          level: String(row.Level), generation: String(row.ModGenerationTypeID), tags,
          keywords: view.keywords, values: view.values,
        };
        rows.push({ identity, ...view, source });
      }
    }
  }

  // Public detail cards expose raw, nonlocalized Stats names and min/max
  // badges. Headers alone, family-only joins and locale hover hashes are unsafe.
  $('.card').each((index, card) => {
    const header = $(card).children('.card-header');
    const table = $(card).children('table');
    if (header.length !== 1 || table.length !== 1) return;
    const fields = new Map();
    table.find('tr').each((_, tr) => {
      const th = $(tr).children('th');
      const td = $(tr).children('td');
      if (th.length === 1 && td.length === 1) fields.set(normalizeText(th.text()), td);
    });
    if (!fields.has('Stats') || !fields.has('Family')) return;
    supported = true;
    const source = { shape: 'detail-stats', index };
    const reject = reason => issues.push({ type: reason, locale, url, source });
    if (header.find('.secondary').length) { reject('raw-stat-display-only'); return; }
    const stats = [];
    let invalid = false;
    fields.get('Stats').find('li').each((_, li) => {
      const item = $(li);
      const badge = item.children('.badge.bg-primary');
      const scopeBadge = item.children('.badge.bg-secondary');
      const value = badge.length === 1 && numericValue(badge.text());
      const scopeText = normalizeText(scopeBadge.text());
      const scope = ({ Local: 'local', '区域': 'local', Global: 'global' })[scopeText];
      const copy = item.clone();
      copy.find('.badge').remove();
      const name = normalizeText(copy.text());
      if (!value || !scope || !name || !/^[a-z0-9_ +%\-]+$/u.test(name)) { invalid = true; return; }
      stats.push({ name, range: value.values, scope });
    });
    const idField = key => /\((\d+)\)\s*$/u.exec(fields.get(key)?.text() ?? '')?.[1];
    const level = normalizeText(fields.get('Req. level')?.text() ?? '');
    const family = normalizeText(fields.get('Family').text());
    if (invalid || !stats.length || !family || !/^\d+$/u.test(level)
      || !idField('Domains') || !idField('GenerationType')) {
      reject('unsupported-detail-metadata'); return;
    }
    const view = rendered(header.html());
    if (view.error) { reject(view.error); return; }
    const identity = {
      shape: 'detail-stats', family, level, domain: idField('Domains'), generation: idField('GenerationType'),
      stats: stats.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), 'en')),
      values: view.values,
    };
    rows.push({ identity, ...view, source });
  });
  if (!supported) issues.push({ type: 'unsupported-page', locale, url });
  return rows;
}

function groupRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(row.identity);
    if (!groups.has(key)) groups.set(key, new Map());
    const variants = groups.get(key);
    if (!variants.has(row.text)) variants.set(row.text, { ...row, evidence: [] });
    variants.get(row.text).evidence.push(row.source);
  }
  return groups;
}

export function extractPagePairs(englishHtml, chineseHtml, { enUrl, cnUrl } = {}) {
  const issues = [];
  const english = groupRows(readPage(englishHtml, enUrl, 'en', issues));
  const chinese = groupRows(readPage(chineseHtml, cnUrl, 'cn', issues));
  const pairs = [];
  for (const key of [...new Set([...english.keys(), ...chinese.keys()])].sort()) {
    const en = english.get(key);
    const cn = chinese.get(key);
    if (!en || !cn) {
      issues.push({ type: 'unmatched-identity', identity: JSON.parse(key),
        english: en ? [...en.keys()] : [], chinese: cn ? [...cn.keys()] : [] });
      continue;
    }
    if (en.size !== 1 || cn.size !== 1) {
      issues.push({ type: 'ambiguous-identity', identity: JSON.parse(key),
        english: [...en.values()], chinese: [...cn.values()] });
      continue;
    }
    const e = en.values().next().value;
    const c = cn.values().next().value;
    if (slotCount(e.text) !== slotCount(c.text) || JSON.stringify(e.values) !== JSON.stringify(c.values)) {
      issues.push({ type: 'numeric-mismatch', english: e.text, chinese: c.text });
      continue;
    }
    if (c.text === e.text || !/\p{Script=Han}/u.test(c.text)) {
      issues.push({ type: 'untranslated-chinese', english: e.text, chinese: c.text,
        identity: e.identity, enUrl, cnUrl });
      continue;
    }
    pairs.push({ english: e.text, chinese: c.text, proof: {
      enUrl, cnUrl, identity: e.identity, values: e.values,
      english: e.evidence, chinese: c.evidence,
    } });
  }
  return { pairs, issues };
}
