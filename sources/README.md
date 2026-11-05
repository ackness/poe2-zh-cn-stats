# Locale source ledger

`sources.lock.json` is the translation repository's locale-provenance ledger.
Its `schema_version: 1` `retained_input_acceptances` map records the bounded
coordinator decision that admitted the PoBR `0.5.5.5/international` locale
block: which retained Simplified/Traditional Chinese dictionaries, projected
display texts and reviewed supplements may serve as target text, under which
per-item limits.

The production pipeline these records describe — trade/community dictionary
curation, native-text pairing and selection, the v3 display projection and the
reviewed-translation workbench — is implemented in this repository (see
[docs](../docs/), especially
[retained-locale-publication](../docs/retained-locale-publication.md),
[locale-generation](../docs/locale-generation.md),
[pobr-locale-producers](../docs/pobr-locale-producers.md) and
[translation-workbench](../docs/translation-workbench.md)). Acceptance entries
are exact evidence decisions, not a runtime release gate: new bytes do not
inherit acceptance and no entry switches a consumer's current data.

## Relocation provenance

Relocated on 2026-11-03 from `ackness/pobr` `pipeline/imports/sources.lock.json`
at commit `860ded5059fc41e0983b3f1f85dae19b131e4d6b` (file SHA-256
`4fc8aa497347e4202a7545697483329286d23f4a5bc3fc717eae079ada1ee2ae`; last content
change in `0fb6f913cc3fac980f9d84e855b26103860d6b96`). The
`retained_input_acceptances.locale-retained-and-target-text-0.5.5.5-international`
entry is copied verbatim; item pins, decision text and frozen limits are
unchanged. PoBR's companion narrative remains
`pipeline/imports/client-source-draft.md` in that repository; the locale
paragraph's substance is carried by this entry and
[retained-locale-publication](../docs/retained-locale-publication.md).

Per the shared [data
architecture](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md),
the raw-material and acquisition ledger belongs to RePoE
(`sources/sources.lock.json` there), locale curation belongs to this
repository, and PoBR keeps consumption-scope acceptance decisions — the sibling
`shared-overlay-common-rules` and `compat-retained-tables` entries therefore
stay in PoBR, and the ledger they were split from is that repository's
`pipeline/imports/sources.lock.json`. Cross-references inside this entry
(`acceptance_key: ten-csd-0.5.5.5-international`, `registry_key:
locale-native-tables-0.5.5.5-international`, the RePoE `source-candidate.zip`
pin and the PyPoE reader pin) resolve against the acquisition ledger preserved
in RePoE; they are retained as the original provenance, not re-pinned.

## Bounded decision recorded

`locale-retained-and-target-text-0.5.5.5-international` — the locale block
source for `0.5.5.5/international`: in-tree zh-CN/zh-TW dictionaries plus the
projected `i18n/zh-CN/display_texts.json` and the pinned reviewed supplement.
Item-level results:

- `L1` — seven retained `i18n/zh-CN` community-dictionary files
  (previous-patch bytes from `vagrant-soul/poe2-en-cn-dict` `288d8b9d` plus this
  repository's translation layer `d67f08f6`), `accepted-retained-compatibility`.
- `L2` — the retained 27,896 `stat_lines.json` pairs out of the pinned 28,038,
  `accepted-retained-compatibility`.
- `L3` — the 140 native selected-text pairs inside the same file,
  `accepted-target-text-applicability`; per-pair evidence lives in this
  repository's `handoff/locale-retained-20261101/evidence/native-140-pairs.json` (commit `a4bd9b5b`).
- `L4` — the two selected CSD literal pairs (stat_descriptions.csd record
  20965, branch 1), `accepted-target-text-applicability`.
- `L5` — the three `i18n/zh-TW` sidecars additive over the previous patch,
  `accepted-target-text-applicability`; zh-TW keeps its own namespace and is
  never zh-CN evidence.
- `L6` — the v3 display projection for three declared ID scopes plus literal
  applicability, `accepted-target-text-applicability`; bound to this
  repository's `e61f1332` catalog and RePoE's `61fe85cc` source candidate.
- `L7` — the reviewed-only supplement input (revision `5d019466`,
  `handoff/reviewed-supplements-20261101/runtime.zip`, 1585 bytes, zero live
  reviewed records), `accepted-retained-compatibility`.
- `L8` — SC client identity / patch-realm equality, `blocked-unknown`: every SC
  item is admitted as target text or retained community data, never as an
  authenticated SC client resource.

`not_accepted` and `production_ready: false` are unchanged: no SC client
identity, observed patch/realm equality or official reader/merge semantics; no
numeric correctness, event history or unique ownership claims; no distribution
rights, freshness, remote release or deployment.

## Where the bytes and evidence live

The entry's byte-identical publication copy is
[`handoff/locale-retained-20261101/evidence/locale-decision.json`](https://github.com/ackness/poe2-zh-cn-stats/blob/a4bd9b5b0534d706a7b19975dae5cfa43a1d57fb/handoff/locale-retained-20261101/evidence/locale-decision.json),
shipped with the retained locale package under tag
`handoff/locale-retained-20261101` (revision `a4bd9b5b`). That package's
`manifest.json` and `evidence/` directory carry the pinned dictionary bytes,
the original zh-CN `_meta`, the zh-TW consumer receipt and the 140-pair delta.
The support-display asset's provenance is its own
[`handoff/support-display-20261101/manifest.json`](https://github.com/ackness/poe2-zh-cn-stats/blob/5046a18af9974e8914fa1ea1b2b0db9202b2908b/handoff/support-display-20261101/manifest.json)
`provenance` block; it never had a `sources.lock.json` entry.

Evidence paths inside the entry still name PoBR `.cache/` receipts, PoBR
tracked files (`pipeline/sources.lock.json`, `pipeline/native-display-texts.md`,
`docs/data-architecture.md`) and PoBR review threads; they are the original
provenance of the decision, kept verbatim rather than re-pinned into this
checkout.
