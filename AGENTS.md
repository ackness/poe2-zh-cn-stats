# Repository Guidelines

This repository produces source-attributed Path of Exile 2 language data: the trade modifier
dictionary, the native-text tooling and the language package that PoBR pins as the GitHub Release
`locale/<patch>-<n>`. The [README](README.md) introduces it; [docs/](docs/README.md) indexes the
contracts and guides. When a document disagrees with the code or its tests, the code wins; fix the
document.

## Scope

- **Languages:** English (`en`), Simplified Chinese (`zh-CN`) and Traditional Chinese (`zh-TW`), no
  others. Simplified Chinese is the focus and needs its own handling: its official text belongs to
  Tencent's China realm (the `poe.game.qq.com` trade API), so zh-CN data is assembled from Tencent's
  trade catalog, the pinned client tables and reviewed curation, and realm is always recorded
  separately from language. English and Traditional Chinese come from the international client and
  GGG's trade API. International-client Simplified Chinese text never proves China-realm values.
- **No new features.** The structure may stay ready for more languages, but do not add functionality
  beyond this purpose: no further languages, runtime services, calculation rules or PoBR wiring.
  Removing dead code is fine; removing a path that a pin, a Release or another repository (e.g. `ackness/pobr`) still uses is not.

## Ownership boundaries

The split is maintained once, in
[PoBR's data architecture](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md).

- **RePoE** (`ackness/repoe`) decodes client resources, keeps the raw-material ledger and publishes the
  game package `game/<patch>-<n>`, including the trade catalog that the support display is bound to.
  Decoding bugs and missing facts go there.
- **PoBR** (`ackness/pobr`) consumes Releases only: `mise run data:bump` writes repository, tag, asset and
  SHA-256 into its `pipeline/data.lock.json`. Stat meaning, modifier rules, the engine and display
  wiring live there.
- **This repository** owns translations, term templates, curation and the language package. A missing or
  wrong translation is fixed here, never patched inside PoBR.

## Layout

| Path | What | Status |
| --- | --- | --- |
| `curation/` | Hand-maintained inputs: trade worklist `translations.json`, templates `curated.json`, overrides `overrides.json`, native supplements `native-translations.json`, display supplements and stat-line corrections `display-supplements.json`, fetch list `trade-sources.json` | editable |
| `src/cli.mjs` | Command entry for the trade dictionary, native candidates and the workbench | editable |
| `src/trade/` | Trade dictionary: fetch, pairing, generation, checks | editable |
| `src/release/` | `release:build`, `release:publish`, `release:regenerate` and helpers | editable |
| `src/pobr/` | PoBR locale producers (`pobr:*`), the historical zh-CN dictionary producer, the display projection | editable |
| `src/native-*.mjs`, `src/strict-json.mjs`, `src/translation-workbench.mjs` | Native catalog library | **frozen bytes and paths** |
| `test/<domain>/`, `test/fixtures/` | Offline tests grouped like `src/`; `test/native/` covers the frozen library | editable |
| `data/CURRENT`, `data/snapshots/` | Trade dictionary snapshots; other tools read them by commit | generated (`refresh`/`build`) |
| `reports/` | Readable workbench queues | generated (`workbench`), committed |
| `release/<patch>[-<n>].json` | Language package configs | editable until `published` is written, then frozen |
| `release/regenerate/<patch>.json` | Regeneration recipes | editable; frozen entries only decrease |
| `inputs/` | Source bytes that configs pin | **frozen** |
| `sources/` | Locale provenance ledger; `sources.lock.json` is a verbatim copy | frozen record |
| `docs/` | Contracts and guides (PoBR links the directory) | editable |
| `.cache/` | Local candidates, builds and downloads | ignored |

Why the frozen parts stay as they are:

- The seven native-library modules stay flat in `src/` with unchanged bytes. The catalog that
  `release/regenerate/0.5.5.5.json` pins (`e61f1332:handoff/windows-fk-20261101/catalog.zip`) records
  `src/<name>` keys with their hashes as its producer closure, and the modules locate the repository from
  their own path. The catalog's client inputs exist only as hashes, so it cannot be rebuilt with moved or
  edited code; any edit fails the `regenerate` CI job.
- `inputs/` trees must equal their origin commits (`--check`). Their READMEs and evidence still cite
  `handoff/` paths and old `src/` paths; that is part of the pinned bytes, never edit them.
- `release/`, `release/regenerate/`, `data/`, `sources/`, `docs/` and the mise task names are referenced
  by configs, recipes, published bytes (a regenerated support display records
  `mise run release:build -- --config release/<x>.json --fetch`) or other repositories. Do not rename them.

## Tags

- Never move or delete a `locale/*` tag or a `handoff/*` tag. PoBR's lock, this repository's configs and
  its recipes read them by tag and commit.
- Example (0.5.5.5): these handoff tags are the only refs that keep pinned commits alive (the commits
  are not on `main`):
  `handoff/shaman-mantle-20261103` (`9aba3687`: the 0.5.5.5 source origin, the recipe's generation
  manifest and producer commit), `handoff/windows-sc-20261101` (`e61f1332`: the recipe's native catalog),
  `handoff/reviewed-supplements-20261101` (`5d019466`: the recipe's reviewed supplement) and
  `handoff/rollback-0.5.5.4.2-20261101` (`93d9e164`). The other `handoff/*` tags point at `main` commits
  and are still cited, e.g. `handoff/support-display-20261101` by `release/0.5.5.5-2.json`.
- Only maintainers publish (`mise run release:publish -- --yes`). A `locale/*` tag that an interrupted
  publish left without a Release is never deleted or moved: rerun `mise run release:publish -- --yes` on the
  same commit to finish the interrupted publish.

## Commands

Every command runs through mise: `mise run <task> [-- args]` for a task in `mise.toml`, otherwise
`mise exec -- <command>`.

```sh
mise run setup                                   # npm ci without lifecycle scripts (network)
mise run test                                    # offline tests
mise run check                                   # tests + byte-identical regeneration of data/CURRENT
mise run report                                  # saved trade coverage report
mise exec -- npm run refresh                     # fetch the trade catalogs and PoE2DB pages (network)
mise exec -- npm run build                       # offline rebuild after editing curation/
mise run release:build -- --fetch --check        # build a language package and check it
mise run release:build -- --check-release        # also compare with its Release and check the tag pins (needs network: GitHub)
mise run release:regenerate -- --fetch           # rebuild members from pinned inputs (~40 s, ~4 GB)
mise run release:publish                         # dry run of a publish
mise run pobr:display-texts -- --request FILE --out .cache/NEW
mise run pobr:supplement-lines -- --request FILE --out .cache/NEW
mise run native:candidate -- --facts DIR --expected-manifest-sha256 SHA
mise exec -- node src/cli.mjs workbench --config FILE --out .cache/NEW
```

## Validation by change type

| Change | Run before the PR |
| --- | --- |
| `curation/`, `src/trade/` | `mise run check`; a deliberate dictionary change also needs `mise exec -- npm run build` and the new snapshot plus `curation/translations.json` committed |
| `src/release/` | `mise run test`, then `mise run release:build -- --config <config> --fetch --check --check-release` for every `release/*.json`; for publish logic also a `mise run release:publish` dry run |
| `src/pobr/`, a recipe, `src/pobr/display-projection.json` | `mise run test` and `mise run release:regenerate -- --fetch` |
| A new or changed release config or `inputs/` directory | `mise run release:build -- --config <config> --fetch --check` and `mise run release:regenerate -- --fetch` |
| `src/cli.mjs`, native tooling | `mise run test` |
| Docs only | Check that every relative link and anchor resolves |

CI runs all of this anyway; run locally what your change can break.

## CI

`.github/workflows/verify.yml` runs on every push and pull request:

- `verify`: `mise run setup` and `mise run check`.
- `release`: for every `release/*.json`, `release:build -- --fetch --check --check-release`, then a second
  build whose zip and receipt must match. `--check-release` also fails unless every `locale/*` tag on
  origin is the `published.tag` of exactly one config and every pinned tag exists.
- `regenerate`: `release:regenerate -- --fetch` for every `release/regenerate/*.json`.

## Pull requests

- Branch from `main`. Commit subjects follow `type(scope): imperative lowercase` (`feat`, `fix`,
  `refactor`, `chore`, `docs`, `test`; scopes such as `release`, `trade`, `pobr`, `native`); the body
  says why. Code and comments are in English; documents are in Chinese, except `README.md` (English, with
  `README.zh-CN.md`), `AGENTS.md` and `CONTRIBUTING.md`. `README.md` (English, the default) and
  `README.zh-CN.md` must stay in sync: change both in the same PR.
- Merge with a merge commit, never squash or rebase: `source.origin.revision` can be a commit on the PR
  branch, and only a merge commit keeps it in `main`'s history. A new `inputs/` directory, its config
  and its recipe go in one PR (see [RELEASING.md](RELEASING.md#新补丁)).
- Never edit a config that has `published` or anything under `inputs/`; add a new config and directory.
  The one allowed edit is the post-publish PR that writes the `published` block (next item).
- After every publish, a follow-up PR writes `published` into the config. Until it merges, CI's
  `--check-release` fails on purpose.
