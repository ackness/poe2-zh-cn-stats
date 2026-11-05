# 发布 PoBR 语言包

PoBR 的语言包是本仓库的 GitHub Release `locale/<patch>-<n>`。附件：`pobr-locale-<patch>.zip`、
`receipt.json`、`SHA256SUMS`；配置声明了 `support_display` 时再加简中辅助宝石说明
`support-display.zh-CN.json` 和 `supportDescriptions.zh-CN.json`。PoBR 用 `data:bump` 把这个 Release
（仓库、tag、附件和 SHA-256）写进它的 `pipeline/data.lock.json`；三个仓库的分工和 PoBR 的核对方式见
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)。

本页只写步骤。配置、配方和回执的字段见[语言包配置参考](docs/release-config.md)。

```sh
mise run release:build -- --fetch --check   # 构建默认配置并核对可重现
mise run release:regenerate -- --fetch      # 从固定输入重新生成各成员，逐字节比较
mise run release:publish                    # dry run：构建、暂存附件、打印将执行的命令
mise run release:publish -- --yes           # 打 tag、推送、创建 Release（只由维护者执行）
```

`--config release/<patch>[-<n>].json` 指定配置（默认取没有 `hold` 的最高 patch、最大 `<n>`）；
`--recipe release/regenerate/<patch>.json` 指定配方（默认全部）。

## 什么时候需要新的 Release

- 新的游戏补丁：新的源目录、v1 配置和重新生成配方，见[新补丁](#新补丁)。
- 换掉已发布包里的文件：新的源目录和配置，见[换掉已发布的文件](#换掉已发布的文件)。
- 在已发布的包上做声明过的改动（例如把一张表改成按英文为键）：新的 v2 配置，`base` 指向已发布的 v1 配置。
- RePoE 重新发布游戏包（`game/<patch>-<n+1>`）且交易目录变了：辅助宝石说明绑定交易目录的 SHA-256，
  所以要发布新的 `locale/<patch>-<n+1>`，见[新的辅助宝石说明](#新的辅助宝石说明)。目录没变时旧的语言
  Release 继续可用。

**带 `published` 的配置一律不改**：CI 靠它持续证明已发布的字节可以重现。改动总是新建配置。

## 新补丁

1. **生成文件**：用[PoBR 语言文件生产者](docs/pobr-locale-producers.md)（`pobr:display-texts`、
   `pobr:names`、`pobr:stat-lines`）或[简中词典生成](docs/locale-generation.md)把文件生成到 `.cache/`，
   核对 `receipt.json`。
2. **源目录（第一个提交）**：新建 `inputs/locale-<patch>/`，放 `i18n/<lang>/*.json`、`evidence/*.json`
   和 `manifest.json`（`poe2-retained-locale-publication/v1`，`target` 与配置相同，`files` 写每个文件的
   `bytes`、`sha256`），可加 `README.md`。只提交这个目录；这个提交就是 `source.origin.revision`。
3. **配置（第二个提交，同一分支）**：新建 `release/<patch>.json`（v1）。`source.manifest` 写清单的路径和
   pin；`source.origin` 写本仓库、第 2 步提交的完整 hash，`tag` 写 `main`（合并后由 `main` 保留这个提交）。
   不写 `published`。它自动成为默认配置，旧配置继续由 CI 核对。
4. **重新生成配方（同一分支）**：新建 `release/regenerate/<patch>.json`，`reproduces` 指向第 3 步的配置，
   每个 `i18n/*` 成员要么由一个任务重新生成，要么写进 `frozen`（原因和退出条件）。
5. **辅助宝石说明**：等 RePoE 发布了这个补丁的 `game/<patch>-<n>`，在配置里加 `support_display`（通常是
   `regenerate`，`catalog` 指向该游戏 Release）。PoBR 换补丁时必须同时采用新的说明，所以没有它不要发布。
6. **核对**：`mise run release:build -- --fetch --check`、`mise run release:regenerate -- --fetch`，
   检查回执里的成员、来源和语言索引。
7. **合并**：源目录、配置和配方在同一个 PR 里，用合并提交合并（不要 squash 或 rebase），这样第 2 步的提交
   原样留在 `main` 的历史里，`origin.revision` 一直可取。
8. **发布**：在 `main` 的合并提交上运行 `mise run release:publish`，确认 dry run 的计划（tag、附件、
   SHA-256），再 `mise run release:publish -- --yes`。发布只由维护者执行。
9. **发布后的 PR**：把 `published`（`tag`、`asset`，以及 zip 的 `bytes`、`sha256`，即 Release 里
   `receipt.json` 的 `package.bytes`、`package.sha256`）写进配置，另开 PR 合并。合并之前，CI 的 `--check-release` 会因为这个 tag 没有被任何配置固定而失败；
   合并之后 CI 每次下载该 Release 并逐字节比较。
10. **PoBR**：在 PoBR 仓库运行 `mise run data:bump ackness/poe2-zh-cn-stats locale/<patch>-<n>`，按 PoBR
    的流程提交。

## 换掉已发布的文件

1. 按[新补丁](#新补丁)第 1 步生成新文件。
2. 新建源目录 `inputs/locale-<patch>-<n>/`：未改动的文件按原字节复制，改动的文件换成新字节，证据放
   `evidence/`，写新的 `manifest.json`。已有的 `inputs/` 目录不改。
3. 新建 `release/<patch>-<n>.json`（`<n>` 是要发布的序号），之后同新补丁第 3–10 步。只改一两张表时也可以
   写 v2 配置，在已发布配置的包上声明 transform，并在 `expect.package` 写新的 zip pin。

## 新的辅助宝石说明

已发布的 zip 要配新的辅助宝石说明时，新建 `release/<patch>-<n+1>.json`，不改已发布的配置：v2 配置写相同的
`base`、`transforms` 和 `expect`，v1 配置写相同的 `source`，再加上新的 `support_display`。zip 不变，
`release:publish` 把它发布为 `locale/<patch>-<n+1>`：同样的 zip 配上新的或改动过的辅助宝石说明算新内容。

## CI 核对什么

`.github/workflows/verify.yml` 在每次推送和 PR 上：

- 对每个 `release/*.json` 跑 `release:build -- --fetch --check --check-release`，再构建一次并比较 zip 和回执。
  `--check`：检出干净；源目录（v2 为基础配置的）tree 等于 `origin.revision` 上的；zip 等于 `expect.package`
  和 `published`；保留的辅助宝石说明等于它的 origin tree，声明了输入时还要能重新算出。`--check-release`：
  下载 `published` 的 Release 逐字节比较；并且 origin 上每个 `locale/*` tag 都正好由一个配置的 `published`
  固定，每个被固定的 tag 也都在 origin 上。
- 对每个 `release/regenerate/*.json` 跑 `release:regenerate -- --fetch`。

`release:publish` 只构建、不跑这些核对，所以发布前先在同一提交上看到 CI 通过。

## 排障

`release:publish` 不带 `--yes` 时只暂存到 `.cache/release/publish/<target>/` 并打印命令；有问题时列出来并以 1
退出。`--yes` 在以下情况拒绝：工作区不干净、HEAD 不在 `origin/main`、列不出远端 `locale/*` tag、`gh` 没有
登录、本地有远端没有的 `locale/<patch>-<n>` tag。

| 信息 | 处理 |
| --- | --- |
| `these exact bytes are already published as …` | 同样的内容已经发布过，PoBR 直接固定那个 Release |
| `the package differs from the published …` | 配置的 `published` 与新包不符；已发布的配置不改，改动放进新配置 |
| `the zip is already published as …; a new display needs release/<patch>-<n+1>.json` | 按[新的辅助宝石说明](#新的辅助宝石说明)新建配置 |
| `… is published, but no release config pins it` | 合并发布后的 PR（[新补丁](#新补丁)第 9 步）；tag 是中途失败留下的、没有 Release 时，见下表重跑发布 |
| `… is pinned by …, but the remote has no such tag` | `published.tag` 写错了，或检出的远端不是本仓库 |
| `was not built from this checkout; rerun without --reuse` | 去掉 `--reuse` 重新构建 |
| `origin … is not present locally (pass --fetch)` | 加 `--fetch` |
| `… is not cached under .cache/release/inputs (run release:build with --fetch)` | 先 `mise run release:build -- --fetch` |
| `Pin mismatch: …` | 辅助宝石说明与配置的 pin 不符；有意的新内容就按信息里的实际值写新配置 |
| `Catalog mismatch: …` | 辅助宝石说明绑定的交易目录与配置或游戏包不符；为新目录重新生成 |
| `Provenance mismatch: …` | `_meta` 与清单 `provenance`（或简中 `_meta.json` 的 `source_commit`）不一致 |

**中途失败后重跑 `mise run release:publish -- --yes` 即可继续**，同一提交不会得到第二个序号：

| HEAD 已有 | 重跑时 |
| --- | --- |
| 未推送的本地 `locale/<patch>-<k>` tag | 推送，再创建 Release |
| 远端 tag，没有 Release | 创建 Release |
| 草稿 Release，附件与暂存的完全相同 | 发布草稿 |
| 草稿 Release，附件不全或不同 | 报错；`gh release delete <tag> --repo ackness/poe2-zh-cn-stats --yes`（保留 tag）后重跑 |
| 已发布的 Release | 下载附件比较：相同即 “already published”，不同则报错 |

`locale/*` 和 `handoff/*` tag 不删除、不移动：PoBR 的锁、本仓库的配置和配方按 tag 与提交读取它们。
