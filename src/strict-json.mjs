// JSON.parse alone overwrites duplicate keys. Scan structure first, including
// escaped key spellings; parse retained bytes only after this consistency check.
export function strictJson(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let position = 0;
  const fail = message => { throw new Error(`${message} at JSON offset ${position}`); };
  const space = () => { while (/[ \n\r\t]/u.test(text[position] ?? '\0')) position++; };
  function string(key = false) {
    const start = position++;
    while (position < text.length) {
      const character = text[position++];
      if (character === '\\') position++;
      else if (character === '"') {
        const value = key ? JSON.parse(text.slice(start, position)) : null;
        if (key && !value.isWellFormed()) fail('Invalid Unicode key');
        return value;
      }
    }
    fail('Unterminated JSON string');
  }
  function value(depth) {
    if (depth > 64) fail('JSON depth exceeds 64');
    space();
    if (text[position] === '"') { string(); return; }
    if (text[position] === '{') {
      position++; space();
      const keys = new Set();
      if (text[position] === '}') { position++; return; }
      while (true) {
        if (text[position] !== '"') fail('Expected JSON object key');
        const key = string(true);
        if (keys.has(key)) fail('Duplicate JSON key');
        keys.add(key); space();
        if (text[position++] !== ':') fail('Expected colon');
        value(depth + 1); space();
        if (text[position] === '}') { position++; return; }
        if (text[position++] !== ',') fail('Expected object comma');
        space();
      }
    }
    if (text[position] === '[') {
      position++; space();
      if (text[position] === ']') { position++; return; }
      while (true) {
        value(depth + 1); space();
        if (text[position] === ']') { position++; return; }
        if (text[position++] !== ',') fail('Expected array comma');
      }
    }
    const start = position;
    while (position < text.length && !/[,}\] \n\r\t]/u.test(text[position])) position++;
    if (position === start) fail('Missing JSON value');
  }
  value(0); space();
  if (position !== text.length) fail('Trailing JSON content');
  return JSON.parse(text, (_, item) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER)) {
      throw new Error('JSON number exceeds finite exact input range');
    }
    if (typeof item === 'string' && !item.isWellFormed()) throw new Error('Invalid Unicode string');
    return item;
  });
}
