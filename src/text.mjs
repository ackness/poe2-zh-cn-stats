// Formatting-only normalization. Never erase conditions, literal numbers,
// signs, locality annotations, or trade-category identity.
export function normalizeText(text) {
  if (typeof text !== 'string') throw new TypeError('Expected text');
  return text.replace(/\s+/gu, ' ').trim();
}

export function slotCount(text) {
  return (text.match(/#/g) ?? []).length;
}

export function entryKey(entry) {
  return JSON.stringify([entry.id, normalizeText(entry.english)]);
}
