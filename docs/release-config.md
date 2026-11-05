# 语言包配置参考

`release:build`、`release:publish`、`release:regenerate` 读取的文件格式。发布步骤见
[RELEASING.md](../RELEASING.md)；三个仓库各自负责什么、PoBR 如何采用 Release，见
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)。

## 配置文件名与默认配置

`release/<patch>.json` 或 `release/<patch>-<n>.json`。`<patch>` 必须等于 `target.game_patch`；
带 `-<n>` 的配置只能发布为 `locale/<patch>-<n>`（发布时下一个空闲序号必须正是 `<n>`）。

不带 `--config` 时，构建和发布取没有 `hold` 的配置中 patch 最高的一个，同 patch 取最大的
`<n>`（无 `-<n>` 的排在最前）。

## v1：`poe2-locale-release-config/v1`

| 字段 | 含义 |
| --- | --- |
| `target` | `game`（`poe2`）、`game_patch`、`realm`（`international` 或 `china`） |
| `source.manifest` | 仓库内源发布清单（`poe2-retained-locale-publication/v1`）的 `path`、`bytes`、`sha256` |
| `source.origin` | 该源目录首次提交的位置：`repository`（本仓库）、`revision`（完整 40 位提交）、`tag`、可选 `path` |
| `published` | 发布后补写的 Release pin：`tag`、`asset`、`bytes`、`sha256` |
| `hold` | 可选，一句原因。有它时 `release:publish` 拒绝发布、它也不作默认配置；点名构建与核对照常 |
| `support_display` | 可选，随 Release 发布的简中辅助宝石说明，见下文 |

`source.origin`：

- `revision` 是包含该源目录的提交。`--check` 要求 HEAD 上的源目录 tree 与该提交上的相同。
- `path` 只在目录后来被移动过时写，填该提交里清单的原路径；包内 `manifest.json` 记录这个原路径，
  所以移动目录不改变包的字节。
- `tag` 写一个能让 `revision` 一直可取到的 ref 名：源目录随本仓库 `main` 的合并提交进来时写 `main`；
  最初在别处发布的（例如 `handoff/shaman-mantle-20261103`）写那个 tag。构建只记录它、不校验。

源目录里只允许清单、`README.md` 和清单列出的文件（`i18n/<lang>/*.json` 与 `evidence/*.json`），
每个文件按清单核对字节。`i18n/*` 原样映射为包成员 `data/<patch>/i18n/*`，再加一个新的
`manifest.json`（`pobr-build-data-part/v1`）。zip 用固定时间戳、STORED 写出，只取决于源字节和
`target`；`receipt.json` 记录生产提交，每个提交都不同。

## v2：`poe2-locale-release-config/v2`

v2 不指向源目录，而是在一个 v1 配置的包上做声明过的改动。允许的字段：`schema`、`target`、`base`、
`transforms`、`expect`、`hold`、`published`、`support_display`。

| 字段 | 含义 |
| --- | --- |
| `base` | `{config}`：`release/` 下的一个 v1 配置；它的源目录和 origin 照常核对 |
| `transforms` | 按顺序执行，每个只改一个成员，其余成员按基础包原字节复制 |
| `expect.package` | 必填，期望的 zip `bytes`、`sha256`；改 transform 或基础包时必须一起改，评审由此看到字节变化 |

transform 的 `kind`：

- `rekey-by-english`：把按稳定 ID 存的名称表改成按英文存。`records` 是基础源目录 `evidence/`
  里配对这些字节的 `pobr-native-name-receipt/v1`（必须 pin 住该成员），`table` 等于成员文件名（如 `mods.json`）。
  同一英文有多个译法时取出现最多的，并列时取英文行号最小的，`conflicts` 固定写
  `most-common-then-first-row`，每个取舍记进回执。
- `json`：新增一个成员，内容是对象 `value`。

v2 包内 `manifest.json` 的 `source` 多出 `transforms`（`id`、`kind`、`member`）；回执的 `source`
是 `{base, transforms}`，每个 transform 记录输入、输出 pin 和报告。v2 不继承基础配置的
`support_display`。

## 辅助宝石说明：`support_display`

PoBR Web 在辅助宝石上显示的简中说明，作为同一个 Release 的两个额外附件发布，不进 zip：

- `supportDescriptions.zh-CN.json`：`{_meta, entries, untranslated}`，按辅助宝石 `skill_id` 记英文原文和
  简中译文；没有译文的 ID 在 `untranslated`。
- `support-display.zh-CN.json`：清单 `poe2-support-display-publication/v1`，写 `target`（`game`、
  `version`、`realm`）、`locale`、`catalog_sha256`、`files`（pin 上一个文件，条目正好是 `{bytes, sha256}`）、
  `provenance`（`kind`、`generation_data_version`、`source`、`source_commit`、`source_file`、
  `source_sha256`），可选 `applicability`。

`catalog_sha256` 是游戏包（RePoE Release `game/<patch>-<n>` 的 `pobr-game-<patch>.zip`）成员
`data/<patch>/overlay/trade_catalog.json` 的 SHA-256：说明绑定的是交易目录。每次构建都要求它
与清单和 `_meta` 一致，`_meta` 的来源字段等于清单的 `provenance`，`_meta.data_version` 等于
`provenance.generation_data_version`，`_meta.source_commit` 等于语言包 `i18n/zh-CN/_meta.json` 的
`source_commit`。

两种 `mode`，都 pin 两个输出文件和 `catalog_sha256`：

- `retained`：仓库里的保留目录（`manifest.json`、`supportDescriptions.zh-CN.json`，可有 `README.md`），
  字节原样使用。`manifest` 是 `{path, bytes, sha256}`，`asset` 是 `{bytes, sha256}`，`origin` 写法同
  `source.origin`。可选 `dictionary` 和 `catalog`（写法同下）记录它的生成输入：`--check` 用它们重新算出
  `entries`／`untranslated` 并比较（`_meta` 是当年的生成记录，不比较）。
- `regenerate`：用 `src/release/support-description-projection.mjs` 从两个固定下载生成。`dictionary` 是
  GemEffects 词典（`source` 为 `https://github.com/<owner>/<repo>`、完整 `source_commit`、`source_file`、
  指向该提交的 `raw.githubusercontent.com` `url`、`bytes`、`sha256`）；`catalog` 是游戏 Release 的包
  （`repository: ackness/repoe`、`tag: game/<patch>-<n>`、`asset: pobr-game-<patch>.zip`、`bytes`、`sha256`、
  `member: data/<patch>/overlay/trade_catalog.json`；成员的 SHA-256 必须等于 `catalog_sha256`）。
  `manifest`／`asset` 是期望的 `{bytes, sha256}`，不符时报错信息给出实际 pin。`_meta.regen_command`
  写配置路径，所以这种配置必须放在 `release/` 下。先用 `release:build -- --fetch` 下载输入
  （`.cache/release/inputs/<sha256>`；`release:publish` 只读缓存）。

与真实游戏包的交易目录比较：`regenerate` 每次构建都做；`retained` 只在 `--check` 且声明了
`dictionary`／`catalog` 时做。

示例（0.5.5.5）：0.5.5.5 用 `retained`：以记录的输入重算时 `entries`、`untranslated`
逐字节相同，只有 `_meta` 不同（保留文件记的是当年的 `data_version` 与命令），所以保留已固定的字节。

构建把两个文件写到输出目录并列入 `SHA256SUMS`，回执的 `support_display` 记 `mode`、
`catalog_sha256`、`generation_data_version`、两个文件的 `{asset, bytes, sha256}`、条数和来源。

## 回执与输出

输出在 `.cache/release/<game>-<realm>-<配置名>/`：`pobr-locale-<patch>.zip`、`manifest.json`（包内同名
文件的副本）、`receipt.json`（`poe2-locale-release-receipt/v1`）、`SHA256SUMS`，以及声明了时的两个
辅助宝石说明文件。

回执记录：

- `producer`：仓库、提交、是否 dirty（任何已跟踪改动，或 `src/`、`release/`、`inputs/` 等构建输入下的
  未跟踪文件）、所用配置的 pin，以及 `code`（`src/release/` 构建模块、`src/strict-json.mjs`、`mise.lock`
  的 pin）。
- `source`：源清单、origin、每个源文件的 pin（v2 为 `{base, transforms}`）。
- `package`：zip 与包内清单的 pin、展开字节数、每个成员的来源，以及语言索引 `index`：每种语言的表和
  条数；某语言 `_meta.json` 写了 `fallback` 时还有回退链和对回退语言同名表的键覆盖。索引只在回执里，
  不进 zip。

## 重新生成配方：`release/regenerate/<patch>.json`

`poe2-locale-regeneration/v1`。`release:build` 只打包冻结的源字节；配方证明这些字节能由本库的生产者
从固定输入重新算出来。文件名必须与它复现的 v1 配置相同。

| 字段 | 含义 |
| --- | --- |
| `reproduces` | 复现的 v1 配置（`release/<patch>.json`） |
| `categories` | 冻结成员和组合证据可用的类别及说明 |
| `jobs` | 生产任务，每个列出它的 `members` |
| `frozen` | 暂时无法重新生成的成员：`bytes`、`sha256`、`category`、`reason`、`exit`（退出条件） |

源目录的每个 `i18n/*` 成员必须正好被一个任务或一条冻结记录覆盖。冻结条数是进度指标，只减不增。

任务 `kind`：

- `locale-producer`：`src/pobr/locale-producer.mjs` 跑一个固定的生成清单（`manifest` 是本仓库某个提交里的
  文件，带 `bytes`、`sha256`；`producer_commit` 是清单里 `producer-commit` 输入所在的提交）。清单的
  每个输入按它的来源取：URL（本仓库的 `raw.githubusercontent.com` 地址改从 Git 读），或 `producer_commit`
  里的路径。
- `display-texts`：`src/pobr/display-texts.mjs` 跑固定的 `catalog` 与审核补译 `supplement`（都是本仓库
  某个提交里的 zip）。库模块用本 checkout 的，v3 catalog 的 producer 闭包必须等于它们；
  `supplement_module` 必须等于它在固定提交里的字节。`projection`（`{scopes, literals}`，只有这两个字段）
  必填，作为请求的 `projection` 传入：任务不读 `src/pobr/display-projection.json`，所以给默认投影加
  scope 不会改变已发布成员的重新生成结果；要发布新 scope，就在新配置的配方里写新的 `projection`。
  `regeneration.json` 的任务摘要记录生产者回执里的 `projection`。可选 `names`（本仓库某个提交里的
  `curation/display-supplements.json`，带 `bytes`、`sha256`）作为请求的 `names` 传入，为
  `MonsterVarieties.Name` 提供已审核的怪物名补译；可选 `official_names`（本仓库某个提交里的文件
  `{revision, path, bytes, sha256}`，或 HTTPS 下载 `{url, bytes, sha256}`，例如 RePoE Release 资产）作为请求的
  `official_names` 传入，提供官方怪物名。两者都要求 `projection.scopes` 含该 scope，并要求
  `game_package`（`{repository, tag, asset, bytes, sha256}`，RePoE 游戏 Release 资产，`asset` 必须是
  `pobr-game-<patch>.zip`，与 `supplement-lines` 相同）：`--fetch` 下载并核对后作为请求的 `game_package`
  传入，怪物名按其中的目标英文决定。给出 `names` 时还要 `package_texts: {stat_lines, passive_names}`（各为本仓库
  某个提交里的文件 `{revision, path, bytes, sha256}`，通常是作为底的已发布成员），作为请求的 `package_texts`
  传入：补译不得遮住这些官方文本，跳过的条数记在任务摘要 `official_elsewhere_skipped`。`passive_names` 必须等于
  源目录的成员，`stat_lines` 必须等于源目录成员（带 `origin` 的行不计入）；同 locale 的 `supplement-lines` 任务没有
  `official` 时，也可以等于该任务的 `base`。
- `supplement-lines`：`src/pobr/supplement-lines.mjs`（见
  [PoBR 语言文件生产者](pobr-locale-producers.md#补译与修正supplement-lines)）。`base` 是作为底的
  `stat_lines.json`，`edits` 是 `curation/display-supplements.json`，可选 `meta` 是作为底的 `_meta.json`，
  三者都是本仓库某个提交里的文件，带 `bytes`、`sha256`；`game_package` 是游戏 Release 资产
  `{repository, tag, asset, bytes, sha256}`（`--fetch` 下载）。`members` 依次为
  `i18n/<locale>/stat_lines.json`，固定了 `meta` 时再加 `i18n/<locale>/_meta.json`。可选 `official`（仅 zh-CN，
  且要固定 `meta`）是官方层的来源数组，新的在前，每项正好是 `{repository, tag, asset, bytes, sha256, member,
  manifest_sha256}`：RePoE 输入 Release 资产（例如 `inputs/0.5.5.5-1` 的 `repoe-input-china_text-0.5.5.5.zip`，
  `member` 为 `stat-descriptions/china/`），`--fetch` 下载到 `.cache/regenerate/inputs/<sha256>`；任务摘要的
  `official` 是官方层计数。官方层每个来源约 9 秒、1.3 GB RSS。

任务可选：

- `passthrough`：输出等于任务某个输入时必须声明（会自动检测），值写原因。
- `replaced_by`（仅 `locale-producer`）：生产者也会写、但由本配方另一个任务产出的成员，值写那个任务的
  `id`，例如由 `supplement-lines` 接管的 `stat_lines.json` 与 `_meta.json`。该成员必须在那个任务的
  `members` 里，不能同时列在本任务的 `members` 里。
- `composed_evidence`：生成成员里由固定证据层组合进来、但其选取过程还不能重放的部分，每层写
  `input`、`category`、`reason`、`exit`。

`--fetch` 拉取本地缺的 Git 提交（`--depth=1`），并把 URL 输入下载到 `.cache/regenerate/inputs/<sha256>`。
输出在 `.cache/regenerate/<game>-<realm>-<patch>/`：`regeneration.json`（每个成员的类别
`generated-identical`／`passthrough-identical`／`frozen`／`*-different`、所用输入、任务摘要）和由重新生成的
成员加冻结成员打出的 zip。任何成员不同，或配置已有 `published` 而 zip 与它不同，都以 1 退出。
`display-texts` 任务要解开约 390 MB 的 catalog，峰值内存约 4 GB。

示例（0.5.5.5）：0.5.5.5 的配方有 13 个成员，其中 10 个重新生成且逐字节相同（简中 9 个来自 `locale-producer`，其中
`_meta.json` 是 passthrough；`display_texts.json` 来自 `display-texts`，`projection` 固定发布时的三个
scope），繁中 3 个冻结，冻结原因与退出条件写在配方里。`release/regenerate/0.5.5.5-3.json` 复现
`release/0.5.5.5-3.json`：任务与 0.5.5.5 相同，只是 `projection` 多了 `PassiveSkills.Name`；繁中
`mods.json` 冻结为 `locale/0.5.5.5-2` 里按英文为键的字节。

## 冻结的输入

`inputs/` 下的目录是配置固定的源字节，构建不重新生成也不修改它们。其中的 README 和证据可能还写着
当年的 `handoff/` 路径或旧的 `src/` 路径：那是固定字节的一部分，不要改。要换内容，就新建目录和配置
（见 [RELEASING.md](../RELEASING.md#换掉已发布的文件)）。
