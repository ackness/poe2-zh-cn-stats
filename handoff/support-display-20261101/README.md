# Retained support display publication

`manifest.json` identifies the target catalog and pins the unchanged retained asset. The asset's own `_meta` describes its actual 0.5.5.4.2 generation and old regeneration command; neither is a claim of a new generation. The current target is supported only by the identical recorded catalog hash and a consumer guard requiring both `skill_id` and exact English prose. This community-derived text is not certified against an official client, and the catalog match does not establish cross-version semantic equivalence.

For future projections, import `supportDescriptions` from `src/support-description-projection.mjs`:

```js
const { entries, untranslated } = supportDescriptions(dictionary, gems);
```

Pass the parsed, explicitly pinned `GemEffects` dictionary (`table` and `entries[].columns.SupportText` containing `{en, zh}` pairs) and catalog `gems` array. The function strips game links, matches complete trimmed English exactly, retains support `skill_id` keys, rejects conflicting Chinese for the same English and duplicate support IDs, and returns sorted untranslated IDs for English/unavailable fallback. Callers must guard each entry against the current exact English description. The function does not read files, fetch data, pin inputs, generate metadata, or decide version applicability. A future regeneration requires real pinned dictionary and catalog inputs; this retained asset was not regenerated for the target.
