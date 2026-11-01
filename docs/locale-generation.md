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
