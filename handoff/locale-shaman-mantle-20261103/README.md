# Shaman Mantle four-line alias composition

This immutable owner package retains all historical locale bytes except
`i18n/zh-CN/stat_lines.json`, which adds exactly four reviewed single-line
aliases from the original bilingual block. The original block and every old
pair remain intact: 28,038 -> 28,042 pairs; 3,876,139 bytes; SHA-256
`5c151fe654359203c350548bdc27ebe89e830918f96d9c4b18de0db5e069bf95`. No general multiline splitting or new translation.

Source revision: `5c25a6ac5dec7004ee47a61cca9b4a0ff5f12880`; fresh trade snapshot:
`20261104T031003350Z`. The complete curated source and template export are
pinned in `curated-alias-review.json` and its language evidence copy.
The historical dictionary, old translation template bundle, native 140-pair
delta, metadata, and the two original literals retain their original pins and
scope. The new selected layer distinguishes the original two literals' receipt
and exclusions from the four curated aliases. The old metadata/audit describe
the historical base; the fresh receipt reports 27,896 + 140 + 6 = 28,042.

Generation manifest: `handoff/locale-generation-shaman-mantle-20261103/input-manifest.json`
(7344 bytes, SHA-256 `cc33dc60aa6ae2689f12f00db30efd6e92fcc84deb077651d878da9ed97f04a8`).
Language manifest: `handoff/locale-shaman-mantle-20261103/manifest.json`
(4088 bytes, SHA-256 `730222f0cb7a777534243f3b4aff480ae31b2756c8e4ece574b0c4f44f0693a3`).

Materialize all 15 inputs according to the manifest: external inputs use fixed
full40 URLs; `producer-commit` inputs come from this handoff commit. Pin each
byte length and digest. Then run from this checkout with a new output path:

```sh
node src/locale-producer.mjs \
  --manifest handoff/locale-generation-shaman-mantle-20261103/input-manifest.json \
  --manifest-sha256 cc33dc60aa6ae2689f12f00db30efd6e92fcc84deb077651d878da9ed97f04a8 \
  --input-dir .cache/materialized-shaman-inputs --out .cache/new-shaman-output
```

The language package keeps independent zh-TW files, display bytes and historical
evidence unchanged. Its `evidence/production-snapshots.json` records per-file
source/output pins. The existing catalog/reviewed package bindings are unchanged.

Validation: 233 owner tests and fresh trade snapshot offline regeneration;
historical production replay from all 15 exact inputs; two identical new
generations; exact four-only delta with no removals; every original language
file except stat_lines byte-identical; zh-CN and zh-TW exports validated.
Independent Astra xhigh review verified the exact aliases and additive result.
No Cargo/build caches, client reacquisition or new display/native projections.

Local preparation only: no push, PR, merge, remote availability check or PoBR
adoption has been performed. Existing acceptance evidence remains historical
and does not claim that these four aliases were previously adopted. The
coordinator must publish immutable refs, fresh-fetch them, then integrate the
new descriptor/index and separately adopt the owner release in PoBR.
