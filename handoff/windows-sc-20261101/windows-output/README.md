# Actual Windows SC display catalog

`catalog.zip` contains unchanged `catalog.json`, `request.json`, and
`manifest.json` from the real nine-table Windows run. Fresh CLI invocations
produced byte-identical catalog A/B files. `inventory.json` pins every archive
member and the complete ZIP; packaging included a full member readback check.
The separate `manifest.json` is the same original completion manifest.

The catalog covers all 18 display fields: 58,588 records, 16,488 translated,
42,100 unresolved, and 490 conflict groups. `catalog-validation.json` records
every field's counts, all unresolved-reason totals, and actual samples.
All 58,588 exact queries, 16,488 changed-English fallback queries, and 15,996
unique-English lookups were checked. Catalog construction independently
recomputed all three-side bindings in both fresh runs. Empty fields and rejected
target bindings remain unresolved rather than acquiring guessed translations.

The actual producer is the five-module closure pinned by the manifest. The
only language-code repair projects the three contracted schema identity fields
into target pins while retaining extra English-package metadata in provenance.
A regression covers `compatibility_views: 0` and still rejects schema identity
drift. The focused native suites pass 44 tests, with one Windows-inapplicable
POSIX FIFO test skipped. No renderer, raw DAT decoder, or dependency was added.

The observed client patch/realm remain null. The catalog's known target is
`poe2 / 0.5.5.5 / international`, locale `zh-CN`; these values never certify
the Windows client version, realm, numerical equivalence, or source approval.
No CURRENT or production source pointer was changed.

To replay, extract and verify the RePoE handoff candidate and its original
English inputs. Build a request using `poe2-native-catalog-request/v2`, the
actual source manifest hash, and the same three separately pinned English
package manifests with their exact table ownership. Relocate request paths
only; do not replace the four different target raw resources with Windows data.
Run `src/native-catalog.mjs --config <request> --out <fresh .cache output>` twice.
The archived request preserves the actual Windows run paths as evidence.

`validate-actual.mjs` is the exact successful validation program. Copy it into
`.cache/windows-sc-20261101/` beside fresh `catalog-a/` and `catalog-b/` outputs
to retain its checkout-relative imports. It checks original file/producer pins,
all field inventories, bound records, and the lookup API without reading game
files. Preserve the archived original candidate when making a relocated replay.
