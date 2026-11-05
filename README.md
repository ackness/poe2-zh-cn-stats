# PoE2 language data (English / Simplified Chinese / Traditional Chinese)

**English** | [简体中文](README.zh-CN.md)

Source-attributed English, Simplified Chinese and Traditional Chinese modifier text, names and display
text for PoBR and other Path of Exile 2 tools. This repository collects the trade catalogs, pairs client
languages, keeps reviewed manual translations and publishes the language files PoBR uses as the GitHub
Release `locale/<patch>-<n>`. The repository name keeps its original `zh-cn-stats`.

Every output records its sources, version identity and checksums; missing translations and conflicts are
recorded separately for maintainers to review.

**Language scope:** English (`en`), Simplified Chinese (`zh-CN`) and Traditional Chinese (`zh-TW`) only.
Simplified Chinese is the focus and needs its own handling: its official text belongs to Tencent's China
realm, so zh-CN data is built from Tencent's trade catalog, pinned client language tables and reviewed
manual translations, with realm recorded separately from language. English and Traditional Chinese come
from the international client and GGG's trade catalog. Simplified Chinese text in the international
client does not prove that China-realm values are the same.

## Where to start

| You want to | Start here |
| --- | --- |
| Publish or update PoBR's language package | [RELEASING.md](RELEASING.md) (Chinese) |
| Use the trade modifier translations in your own tool | [Reading the trade dictionary](docs/trade-dictionary.md#其他仓库如何接入) (Chinese) |
| Refresh the trade catalogs, add a translation, fix a template | [Trade dictionary guide](docs/trade-dictionary.md) (Chinese) |
| Pair native names, skill descriptions or stat descriptions | [Native display catalog](docs/native-catalog.md) / [native descriptions](docs/native-localization.md) (Chinese) |
| Review native-text supplements and realm differences | [Translation workbench](docs/translation-workbench.md) (Chinese) |
| Change code or open a pull request | [AGENTS.md](AGENTS.md) (layout, commands, validation, conventions), [CONTRIBUTING.md](CONTRIBUTING.md) |

All documents are listed in the [docs index](docs/README.md).

## Relation to RePoE and PoBR

RePoE decodes the client and publishes the game package `game/<patch>-<n>`. This repository owns the
translations, templates and manual curation and publishes the language package `locale/<patch>-<n>`.
PoBR pins both Releases (repository, tag, asset and SHA-256) in its `pipeline/data.lock.json` with
`mise run data:bump` and ships only the packaged files. The split and shared conventions are maintained
once, in [PoBR's data architecture](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md);
open cross-repository gaps are in [PoBR's data status](https://github.com/ackness/pobr/blob/master/docs/data-status.md).

## What it provides

| Data | Sources and outputs | Limits |
| --- | --- | --- |
| Trade modifiers | GGG and Tencent trade catalogs, fractured-modifier reuse, PoE2DB gap filling; `dictionary.json`, `pairs.json` under `data/snapshots/<id>/generated/` | Keyed by the full trade ID **plus the English branch** |
| Numbered templates | Conservative conversion of the trade dictionary plus `curation/curated.json`; `templates.json` | Automatic conversion only for zero or one numeric slot; multi-slot templates are reviewed by hand |
| Native descriptions and names | Pinned RePoE client facts, CSD descriptions and explicit language tables | Keeps stat IDs, table identities, conditions and branches; queried by exact context |
| PoBR language package | Names, display texts, selected descriptions, the pinned historical zh-CN dictionary and the zh-CN support-gem display | Published as `locale/<patch>-<n>`; PoBR pins its assets by SHA-256 |
| Manual translations | Worklists and review records under `curation/` | Drafts never reach reviewed output; a source change requires review again |

Trade IDs, game stat IDs and display text serve different purposes and do not substitute for each other.
Trade coverage is not full localization or calculation coverage. The historical compatibility dictionary
keeps its community source and Traditional Chinese keeps its own; the repository as a whole is neither
purely official text nor a complete client language library.

## Local development

Install [mise](https://mise.jdx.dev/), then from the repository root:

```sh
mise trust
mise install --locked
mise run setup
mise run check
```

`mise.lock` pins Node; `setup` installs the dependencies from `package-lock.json` without lifecycle scripts
and needs the network once. `check` runs the tests and verifies offline that the current trade snapshot's
sources match their checksums and regenerate byte for byte. Every command runs through mise: `mise run <task>`
for a task, `mise exec -- <command>` otherwise.

```sh
mise exec -- npm run refresh   # fetch the trade catalogs and configured PoE2DB pages, verify, activate
mise exec -- npm run build     # after editing curation/: rebuild offline from the saved responses
mise run report                # show the coverage report
```

What to edit, by purpose:

| To change | Edit |
| --- | --- |
| A missing translation for an existing trade ID + English branch | [`curation/translations.json`](curation/translations.json): `manual_chinese`, `manual_note`, `manual_source_url` |
| Explicitly override an existing trade translation | [`curation/overrides.json`](curation/overrides.json), with reason and source |
| Non-trade templates, multi-slot templates, rare-name words | [`curation/curated.json`](curation/curated.json) |
| Native name or description supplements | [`curation/native-translations.json`](curation/native-translations.json), reviewed through the [workbench flow](docs/translation-workbench.md) (Chinese) |
| Additional pages to fetch | [`curation/trade-sources.json`](curation/trade-sources.json) |

## Layout

```text
curation/                       hand-maintained inputs
data/CURRENT, data/snapshots/   trade dictionary snapshots (raw responses and generated files)
reports/                        committed workbench queues, generated
release/                        language package configs and regeneration recipes
inputs/                         source bytes the configs pin (read-only)
src/cli.mjs                     command entry for the trade dictionary and native text
src/trade/                      trade dictionary
src/release/                    release:build, release:publish, release:regenerate
src/pobr/                       PoBR locale producers and the historical zh-CN dictionary producer
src/*.mjs (the other seven)     native catalog library; paths and bytes are frozen (see AGENTS.md)
test/<domain>/                  offline tests grouped like src/ (test/native/ covers the native library)
docs/                           contracts and guides (Chinese)
sources/                        locale provenance ledger
.cache/                         local candidates and temporary files, not committed
```

What is editable, frozen or generated, and why the seven native modules stay frozen at `src/`, is in
[AGENTS.md](AGENTS.md#layout).

## Publishing the language package

`release:build` packages only the source bytes a config pins; `release:regenerate` separately rebuilds the
members from pinned inputs and compares them byte for byte; `release:publish` creates the Release, which
PoBR then adopts with `data:bump`. CI rebuilds every published package and compares it with its Release on
every push. The steps are in [RELEASING.md](RELEASING.md). `locale/*` and `handoff/*` tags are never
deleted or moved.

## Sources and rights

The trade sources are [GGG](https://www.pathofexile.com/api/trade2/data/stats),
[Tencent](https://poe.game.qq.com/api/trade2/data/stats) and the configured [PoE2DB](https://poe2db.tw/)
pages. The official trade endpoints do not report a client patch, so trade snapshots record
`game_patch: null`. Scope, access limits and failure behaviour are described in
[sources and access](docs/trade-dictionary.md#来源与访问边界) (Chinese).

Game text, raw responses and web content belong to their respective owners. Publishing this repository
grants no new licence to them; the project is not affiliated with GGG, Tencent or PoE2DB.
