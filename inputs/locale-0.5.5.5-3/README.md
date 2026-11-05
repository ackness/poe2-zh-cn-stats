# 0.5.5.5 language package with passive-skill names by id

This publication is the package of `locale/0.5.5.5-2` (`release/0.5.5.5-2.json`) with exactly one
member replaced: `i18n/zh-CN/display_texts.json`. The other 12 language members are the -2 package
members byte for byte, including `i18n/zh-TW/mods.json`, which is the output of -2's
`rekey-by-english` transform (94179 bytes, SHA-256
`0de2188d6d86d253ced23aa4edb6d090513c9e9831b6abeccaad2e4e4bba317d`). The evidence of
`inputs/locale-0.5.5.5/` is copied unchanged; `evidence/locale-0.5.5.5-2-receipt.json` is the
`receipt.json` asset of the `locale/0.5.5.5-2` Release (52428 bytes, SHA-256
`7edcfdb3918b5de04f67871412dbf0b4d30c5e31f8f828fbe93158c22322366f`), which records that transform
and its 178 conflict choices.

The new `display_texts.json` is produced by `src/pobr/display-texts.mjs` from the same pinned
catalog (`e61f1332:handoff/windows-fk-20261101/catalog.zip`) and reviewed supplement
(`5d019466:handoff/reviewed-supplements-20261101/runtime.zip`, 0 records) as the -1/-2 member.
Its only change is one more runtime scope, `PassiveSkills.Name`, keyed by the PassiveSkills `Id`
(the `id` of a PoBR passive tree node): `scopes["PassiveSkills.Name"][id] = [english, localized|null]`.
`entries` and the three earlier scopes are unchanged. An English passive name with several client
translations stays `null` in `entries`; the scope now carries each id's own translation.
The scope has 9731 ids, 8424 translated and 1307 unresolved.

`release/regenerate/0.5.5.5-3.json` regenerates every zh-CN member from pinned inputs, with the
four-scope projection pinned in the recipe.
