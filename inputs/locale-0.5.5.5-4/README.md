# 0.5.5.5 language package with official China text and gem descriptions

This publication is the package of `locale/0.5.5.5-3` (`release/0.5.5.5-3.json`) with three zh-CN
members replaced and one zh-TW member added:

| Member | Change |
| --- | --- |
| `i18n/zh-CN/stat_lines.json`, `i18n/zh-CN/_meta.json` | Official China stat descriptions applied over the -3 base, then the reviewed supplements |
| `i18n/zh-CN/display_texts.json` | Three more scopes from official China client tables: `GemEffects.SupportText`, `ActiveSkills.Description`, `MonsterVarieties.Name` |
| `i18n/zh-TW/display_texts.json` | New: the same three scopes from the official international Traditional Chinese tables, without a catalog |

The other 10 language members and all evidence of `inputs/locale-0.5.5.5-3/` are copied byte for
byte. Every official input is a RePoE input Release, pinned in `manifest.json` and in
`release/regenerate/0.5.5.5-4.json`:

- `ackness/repoe` `inputs/0.5.5.5-1`, `repoe-input-china_text-0.5.5.5.zip` (realm china): the China
  client capture as derived text. Index `1fa59396…`, executable 0.5.5.172, declared target
  0.5.5.5. The capture's `capture.json` (SHA-256 `b06de636…`) is pinned by hash only.
- `ackness/repoe` `inputs/0.5.5.5-2`, `repoe-input-intl_text-0.5.5.5.zip` (realm international):
  the 0.5.5.5 CDN default and Traditional Chinese `GemEffects`, `ActiveSkills` and
  `MonsterVarieties` tables.
- `ackness/repoe` `game/0.5.5.5-3`, `pobr-game-0.5.5.5.zip`: the target English
  (`overlay/gem_descriptions.json`, `overlay/minions.json`, `overlay/spectres.json`).

## Stat lines

`src/pobr/supplement-lines.mjs` reads the China stat descriptions with the frozen native reader,
applies them to the -3 `stat_lines.json` per English, and then applies the reviewed entries and
corrections of `curation/display-supplements.json` (at `752eba99`). Of the 22750 English the China
package supplies:

- 22517 are confirmed (the base already has the same text);
- 103 are revised, 10 of them partial (China rows replace the base rows of that English);
- 28 are added;
- 102 are skipped because they are not game-package templates;
- 5300 base English the China package does not supply are kept.

The result has 28060 rows. 29 of them carry `"origin": "agent"`: 24 `Bonded:` prefixes with the
ClientStrings term `羁绊：` (composite rows the CSDs do not hold) and 5 literal backslashes repaired
to line breaks (the China text itself has the stray `\`). The Mana Flask repair is
`already-in-base`, and the 6 reviewed stat-line entries are `official`: China now supplies them.
`_meta.json` gains an `official` block with the source pins, the client identity and these counts.

## Display texts

zh-CN keeps the -3 catalog, reviewed supplement, `entries` and the four earlier scopes byte for
byte. The official tables add 612 `GemEffects.SupportText`, 440 `ActiveSkills.Description` and 648
`MonsterVarieties.Name` rows. A row is adopted only when the table's English equals the game
package's English byte for byte and the translation is non-empty and contains Han characters.
Markup such as `[A|B]` stays raw. The 84 reviewed agent monster names are superseded by official
names, so the member has no `origins` block. `Wolf Companion` is 恶狼同伴.

zh-TW has no catalog: `entries` is empty and `catalog_sha256` is the SHA-256 of the Traditional
Chinese tables' `manifest.json`. It has 611, 438 and 648 rows (`Wolf Companion` is 狼盟友). Two
client descriptions break the markup, which allows only `[A]` and `[A|B]`: `herald_of_blood` has an
unpaired bracket (`[BloodLoss|失血影響。`) and `frost_darts` a three-part form
(`[Projectile|Projectiles|投射物]`). Both are counted as `broken-markup` and omitted. PoBR then falls
back to the converted zh-CN text.

Untranslated ids are omitted rather than written as `null`, so zh-TW can fall back to zh-CN.

`release/regenerate/0.5.5.5-4.json` regenerates every zh-CN member and the zh-TW
`display_texts.json` from pinned inputs.
