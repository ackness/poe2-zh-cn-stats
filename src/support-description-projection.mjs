// Display-only language projection. Inputs are supplied by the caller.
const plain = text => text.replace(/\[([^\]|]*\|)?([^\]]+)\]/g, '$2').trim();

export function supportDescriptions(dictionary, gems) {
  if (dictionary.table !== 'GemEffects' || !Array.isArray(dictionary.entries)) throw new Error('Expected GemEffects dictionary');
  const byEnglish = new Map();
  for (const entry of dictionary.entries) {
    for (const pair of entry.columns?.SupportText ?? []) {
      if (typeof pair.en !== 'string' || typeof pair.zh !== 'string') continue;
      const en = plain(pair.en), zh = plain(pair.zh);
      if (!en || !/\p{Script=Han}/u.test(zh)) continue;
      if (byEnglish.has(en) && byEnglish.get(en) !== zh) throw new Error(`Conflicting support description: ${en}`);
      byEnglish.set(en, zh);
    }
  }
  const entries = {}, untranslated = [], seen = new Set();
  for (const gem of [...gems].filter(gem => gem.is_support).sort((a, b) => a.skill_id < b.skill_id ? -1 : a.skill_id > b.skill_id ? 1 : 0)) {
    if (seen.has(gem.skill_id)) throw new Error(`Duplicate support ID: ${gem.skill_id}`);
    seen.add(gem.skill_id);
    const en = gem.description?.trim();
    const zh = byEnglish.get(en);
    if (zh) Object.defineProperty(entries, gem.skill_id, { value: { en, zh_cn: zh }, enumerable: true, configurable: true, writable: true });
    else untranslated.push(gem.skill_id);
  }
  return { entries, untranslated };
}
