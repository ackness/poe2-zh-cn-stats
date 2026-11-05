# 发布 PoBR 语言包

PoBR 的语言包是本仓库的 GitHub Release `locale/<patch>-<n>`，附件为
`pobr-locale-<patch>.zip`、`receipt.json` 和 `SHA256SUMS`。三仓库各自负责什么见
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)。

```sh
mise run release:build -- --check       # 打包最高 patch 的 release/<patch>.json，核对可重现
mise run release:publish                # dry run：构建、暂存附件、打印将执行的命令
mise run release:publish -- --yes       # 打 tag、推送、创建 Release
# 在 PoBR 中：
mise run data:bump ackness/poe2-zh-cn-stats locale/<patch>-<n>
```

## 构建读什么

`release/<patch>.json`（`poe2-locale-release-config/v1`）声明：

- `target`：`game`、`game_patch`、`realm`；文件名是 `<game_patch>.json`，或
  `<game_patch>-<n>.json`（专为 `locale/<patch>-<n>` 准备的包，发布时下一个序号必须正是 `<n>`）。
  不带 `--config` 时用最高 patch，同 patch 取最大的 `<n>`（无 `-<n>` 的排最前）。
- `source.manifest`：仓库内源发布清单（`poe2-retained-locale-publication/v1`）的路径、
  字节数和 SHA-256。
- `source.origin`：该目录最初所在的提交（`revision`，完整 40 位）和名字（`tag`）；目录在
  那之后被移动过时，`path` 写该提交里清单的原路径（tree 必须不变）。包内 `manifest.json`
  记录的是这个原路径，所以移动目录不改变包的字节。
- `published`：发布之后补上的 Release 附件 pin（`tag`、`asset`、`bytes`、`sha256`）。
- `hold`（可选）：一句原因；有它时 `release:publish` 拒绝发布，构建和核对照常。

`poe2-locale-release-config/v2` 不指向源目录，而是在一个 v1 配置的包上做声明过的改动：

- `base: {config}`：`release/` 下的 v1 配置；它的源目录、origin 核对照旧。
- `transforms`：按顺序执行，每个改一个成员。`rekey-by-english` 把按稳定 ID 存的名称表
  改成按英文存（`records` 是源目录 `evidence/` 里配对这些字节的 `pobr-native-name-receipt/v1`，
  它必须 pin 住该成员；同一英文有多个译法时取出现最多的、并列取英文行号最小的，
  `conflicts` 固定写 `most-common-then-first-row`，每个取舍记进回执）；`json` 新增一个成员，
  内容是 `value`。其余成员按基础包原字节复制。
- `expect.package`：期望的 zip `bytes`／`sha256`，`--check` 核对。
- 包内 `manifest.json` 的 `source` 多出 `transforms`（`id`、`kind`、`member`）；回执的
  `source` 是 `{base, transforms}`，每个 transform 记录输入、输出 pin 和报告。

两种配置的回执都在 `package.index` 写语言索引：每种语言的表和条数、`_meta.json` 声明的
`fallback`，以及对回退语言同名表的键覆盖（`fallback_keys_covered`／`fallback_entries`）。
索引不进 zip：PoBR 要求 `data/<patch>/i18n/*` 正好是游戏包快照清单列出的文件，多一个
成员就拒绝导入。

构建只读源目录：清单之外只允许 `README.md`，每个文件按清单核对字节；`i18n/*` 原样
映射成 `data/<patch>/i18n/*`，加一个新的 `manifest.json`，写成固定时间、STORED 的
zip。zip 只取决于源字节和目标；`receipt.json` 记录生产提交，每次都不同。
输出在 `.cache/release/<game>-<realm>-<配置名>/`（如 `poe2-international-0.5.5.5`）。

- `--check`：检出干净、源目录（v2 为基础配置的源目录）在 HEAD 的 tree 与 `origin.revision`
  上原路径的 tree 相同、zip 等于 `expect.package` 和 `published`（有的话）。
- `--fetch`：本地没有 `origin.revision` 时从 origin 取（只走 Git）。
- `--check-release`：下载 `published` 的 Release，要求与重建结果逐字节相同。

CI（`.github/workflows/verify.yml`）对每个 `release/*.json` 跑
`--fetch --check --check-release`，再构建一次并比较 zip 和回执。

## 冻结的内容与替换

源目录是冻结输入，统一放在 `inputs/` 下：构建不重新生成任何语言文件，也不能修改已被
配置固定的目录（会让 `--check` 和已发布的字节对不上）。0.5.5.5 的源是
`inputs/locale-0.5.5.5/`（原在 `handoff/locale-shaman-mantle-20261103/`，来源 tag
`handoff/shaman-mantle-20261103`，tree 未变，配置用 `source.origin.path` 记原路径）：保留的
历史简中词典和 140 条原生配对、四条 Shaman Mantle 别名、繁中名称 sidecar 和显示文本，
证据在 `evidence/`。目录里冻结的 README 和证据仍写着旧的 `handoff/` 路径，那是固定字节，
不改。

替换某个文件：

1. 用生产入口生成新文件——[PoBR 语言文件生产者](docs/pobr-locale-producers.md)
   （`pobr:display-texts`、`pobr:names`、`pobr:stat-lines`）或
   [离线简中生成](docs/locale-generation.md)，输出在 `.cache/`。
2. 新建一个源目录 `inputs/locale-<patch>[-<n>]/`（`release:build` 的 dirty 检查覆盖
   `inputs/`，见 `src/locale-release.mjs` 的 `PRODUCER_PATHS`），未改动的文件按原字节
   复制，写 `manifest.json` 固定每个文件，证据放 `evidence/`。
3. 经 PR 合并到 `main`，再让配置指向它：同一 patch 就改 `release/<patch>.json` 的
   `source` 并去掉 `published`（每个 patch 只有一个配置，发布得到下一个 `<n>`），
   新 patch 见下节。

## 新补丁

1. 按上节准备新 patch 的源目录并合并到 `main`。
2. 新建 `release/<new patch>.json`：`source.manifest` 指向新清单，`source.origin.revision`
   填添加该目录的 `main` 提交，`tag` 填能找到该提交的名字（目前只作记录，不校验），
   不写 `published`。它自动成为默认配置；旧配置继续可构建、继续由 CI 核对。
3. `mise run release:build -- --check`，检查回执里的成员和来源。
4. 合并后在 `main` 的该提交上 `mise run release:publish`，确认 dry run 的计划，再
   `-- --yes`。
5. 另开一个 PR 把 `published` 写进配置（之后 CI 会下载该 Release 核对），然后在 PoBR
   跑 `data:bump`。

## 排障

`release:publish` 不带 `--yes` 时只暂存到 `.cache/release/publish/<target>/` 并打印
命令；有问题时列出来并以 1 退出。`--yes` 在以下情况拒绝：工作区不干净、HEAD 不在
`origin/main`、列不出远端 `locale/*` tag、`gh` 没有登录、本地有远端没有的
`locale/<patch>-<n>` tag（删掉它）。

| 信息 | 处理 |
| --- | --- |
| `these exact bytes are already published as …` | 同样的 zip 已经发布过，PoBR 直接固定那个 Release |
| `the package differs from the published …` | 配置的 `published` 与新包不符：有意的新内容就去掉 `published` 再发布 |
| `was not built from this checkout; rerun without --reuse` | 去掉 `--reuse` 重新构建 |
| `origin … is not present locally (pass --fetch)` | 加 `--fetch` |

**中途失败后重跑 `-- --yes` 即可继续**，同一提交不会得到第二个序号：

| HEAD 已有 | 重跑时 |
| --- | --- |
| 未推送的本地 `locale/<patch>-<k>` tag | 推送，再创建 Release |
| 远端 tag，没有 Release | 创建 Release |
| 草稿 Release，附件与暂存的完全相同 | `gh release edit <tag> --draft=false` 发布草稿 |
| 草稿 Release，附件不全或不同 | 报错；`gh release delete <tag> --repo ackness/poe2-zh-cn-stats --yes`（保留 tag）后重跑 |
| 已发布的 Release | 下载附件比较：相同即“already published”，不同则报错 |

`locale/*` 和 `handoff/*` tag 一律不删、不移动：PoBR 的锁和本仓库的配置按提交读取它们。
