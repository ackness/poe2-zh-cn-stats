# Contributing

Thanks for helping. This page says what a pull request needs; [AGENTS.md](AGENTS.md) has the layout,
commands, validation and conventions, and [docs/](docs/README.md) indexes the guides.

## What fits this repository

- Translation fixes and reviewed additions for English, Simplified Chinese and Traditional Chinese:
  edit the files in [`curation/`](curation/) as the [trade dictionary guide](docs/trade-dictionary.md) and
  the [workbench guide](docs/translation-workbench.md) describe, with a source for every claim.
- Bug fixes in the producers, checks and release tooling.
- Not accepted: other languages, or functionality beyond producing this language data. Decoding and game
  facts belong to [RePoE](https://github.com/ackness/repoe); calculation and display wiring to
  [PoBR](https://github.com/ackness/pobr).

## Before you open a pull request

1. Install [mise](https://mise.jdx.dev/), then run `mise trust`, `mise install --locked` and `mise run setup`.
2. Run the checks for your change type (see [AGENTS.md](AGENTS.md#validation-by-change-type));
   `mise run check` is the minimum.
3. Keep one problem per pull request. Say why in the description and list what you ran.

Frozen files (`inputs/`, configs with `published`, the native library modules at the top of `src/`) are
never edited; a change to published data is a new config and directory, published as a new
`locale/<patch>-<n>` Release by a maintainer ([RELEASING.md](RELEASING.md)).

Game text, raw responses and web content belong to their owners; contributing does not grant new rights
to them.
