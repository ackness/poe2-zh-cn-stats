# Offline Simplified Chinese generation

`src/locale-producer.mjs` projects a caller-supplied community dictionary and
independent translation template bundle into the legacy Simplified Chinese
sidecars. This is actual generation from input tables and templates. It does
not acquire network data, mutate PoBR snapshots, or decide source acceptance.
The retained publication exporter is a separate byte replay operation.

The fixed historical composition is specified by
[`input-manifest.json`](../handoff/locale-generation-20261101/input-manifest.json).
Pin that manifest by SHA-256 and its producer Git commit independently. Every
`inputs` key is a path **under a caller-created input directory**, not a path
relative to this manifest. Fetch each entry from its `source.url`, or from its
`source.repository` and `source.path` at the separately pinned producer commit
when `source.revision` is `producer-commit`. Check every byte length and
SHA-256. The ten community files and template bundle are in their original
independent repositories at the full commit IDs embedded in the URLs; no HEAD
lookup is involved. Four small selected-layer and metadata inputs come from the
producer commit. A consumer may materialize them however it wishes.

```sh
node src/locale-producer.mjs \
  --manifest handoff/locale-generation-20261101/input-manifest.json \
  --manifest-sha256 <pinned-manifest-sha256> \
  --input-dir <materialized-input-directory> --out <new-output-directory>
```

All flags are required; output must not exist and its parent must exist. The
producer checks the manifest, exact input inventory, all input pins, source
identity, projection, layering and any `expected_files` pins before creating
output. A failed write removes its newly created output directory. The nine
`i18n/zh-CN/*.json` members and `generated/translation-audit.json` have exact
pins in `receipt.json.files`; the receipt includes schema, target, profile,
manifest digest, input pins, source identity and layer counts. Its own bytes are
not self-pinned. Paths and timestamps from the host are not included. Consumers
must independently verify the receipt against the pinned manifest and outputs.
The producer closure is `src/locale-producer.mjs`,
`src/legacy-translation-merge.mjs`, and `src/strict-json.mjs`; Node's built-in
modules are its only runtime dependencies.

Two explicit profiles are supported:

* `legacy` requires only `dictionary/<file>` for the ten named dictionary
  members and `templates.json`. It builds new metadata with the supplied
  dictionary and translation identities. This is the reusable generation API
  for another explicitly pinned source bundle; it does not imply the result is
  accepted for any game patch.
* `retained-selected` additionally requires the four fixed evidence inputs. It
  checks generated legacy counts and identity against separately pinned old
  metadata, verifies the 140-pair delta's input and intermediate byte pins,
  then applies the selected literal layer and verifies its exact output pin.
  Original metadata and the original three selection blocks are retained, not
  relabelled as current. The selected-literal evidence is an excerpt of the
  pinned original receipt: it retains the two additions, their provenance,
  exclusion counts and original receipt pin, not the full exclusion list.
  `native-140-pairs.json` records the whole-pair delta; it does not reconstruct
  per-row provenance joins. The exact historical order is preserved by the
  original `(src, en)` UTF-16 ordering. Its checked fixture is 27,896 + 140 +
  2 = 28,038 pairs. Neither selected layer constitutes full client acceptance.

`src/native-selected-translations.mjs` separately exports
`nativeSelectedTranslations(legacy, selection, candidate)` to generate new
context-bound literal selections from the pinned ordinary-producer receipt and
native candidate. It returns `{pairs, report}` including full additions,
provenance and exclusions. The caller must pin and persist these inputs and
report; feeding an old selected receipt back into the fixed historical profile
is composition, not fresh selection. It imports only Node built-ins (currently
none). `projectLegacy`, `layerSelectedPairs`, and `produceLocale` are also
exported for callers. Skeleton collisions, unreviewed or missing translations,
client strings and unsupported scope remain excluded or diagnosed.

Traditional Chinese sidecars and `display_texts.json` are outside this
producer. Compose them through their existing independently pinned native
projection or retained-publication contracts, with catalog and reviewed bundle
checks where required. The original SC client patch and realm remain unknown;
no new client authenticity, quality or gameplay claim follows from byte equality.

## Reviewed single-line aliases over the retained production inputs

Shaman Mantle's four flask aliases are explicit `curated.json` records copied
verbatim from the retained four-line block. Rebuild and verify a new trade
snapshot first; preserve both the old snapshot and the new snapshot's curated
input and complete template export. No producer splits multi-line templates.

For this bounded addition, reproduce the historical `retained-selected` output
from its pinned inputs before creating a new composition. Keep the ten community
files, historical template bundle, 140-pair delta and both historical metadata
files at their original pins. In a **new** selected-literal input, preserve the
two original selected rows and their provenance, then append only the four
reviewed aliases from the freshly generated template export. Keep the original
28,036-pair baseline pin; compute a new final output pin and preserve the old
selection receipt under a separate historical provenance field. This is an
explicit composition, not a new native selection or translation invention.

The new input manifest keeps profile `retained-selected` and pins the new
selected-literal file and expected output. The producer checks all intermediate
pins and reports 27,896 legacy + 140 native + 6 selected = 28,042 final pairs.
The historical `_meta.json` and translation audit retain their historical
meaning and bytes; the fresh generation receipt and composition evidence record
the four new aliases. Save per-file production provenance, and prove that every
other locale file is byte-identical and the stat pair delta is exactly those
four additions, with no removals and the original block intact.

Keep research and candidate directories under `.cache`. Copy verified files
into new immutable `handoff/` paths only for delivery, retaining all original
evidence files. Publish a new descriptor with both `language` and
`locale_generation` role sequences incremented; their output pins must agree.
The other five roles and display bindings remain pinned to their own production
snapshots. Commit the descriptor before registering its exact pin in a separate
index commit. Local commits, tags and a valid registry do not establish remote
availability or PoBR adoption; those are separate coordinator steps in the
[publication workflow](publication-index.md).
