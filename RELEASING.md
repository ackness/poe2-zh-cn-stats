# 发布 PoBR 语言包

PoBR 的语言包是本仓库的 GitHub Release `locale/<patch>-<n>`，附件为
`pobr-locale-<patch>.zip`、`receipt.json` 和 `SHA256SUMS`；配置声明了 `support_display` 时
再加简中辅助宝石说明的两个附件 `support-display.zh-CN.json`（清单）和
`supportDescriptions.zh-CN.json`（见[辅助宝石说明](#辅助宝石说明support-display)）。三仓库各自负责什么见
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)。

```sh
mise run release:build -- --check       # 打包默认配置（不在 hold 的最高 patch、最大 -<n>），核对可重现
mise run release:regenerate -- --fetch  # 从固定输入重新生成已发布包的成员，逐字节比较
mise run release:publish                # dry run：构建、暂存附件、打印将执行的命令
mise run release:publish -- --yes       # 打 tag、推送、创建 Release
# 在 PoBR 中：
mise run data:bump ackness/poe2-zh-cn-stats locale/<patch>-<n>
```

## 构建读什么

`release/<patch>.json`（`poe2-locale-release-config/v1`）声明：

- `target`：`game`、`game_patch`、`realm`；文件名是 `<game_patch>.json`，或
  `<game_patch>-<n>.json`（专为 `locale/<patch>-<n>` 准备的包，发布时下一个序号必须正是 `<n>`）。
  不带 `--config` 时用没有 `hold` 的配置里最高的 patch，同 patch 取最大的 `<n>`（无 `-<n>`
  的排最前）；`hold` 的配置只在用 `--config` 点名时构建。
- `source.manifest`：仓库内源发布清单（`poe2-retained-locale-publication/v1`）的路径、
  字节数和 SHA-256。
- `source.origin`：该目录最初所在的提交（`revision`，完整 40 位）和名字（`tag`）；目录在
  那之后被移动过时，`path` 写该提交里清单的原路径（tree 必须不变）。包内 `manifest.json`
  记录的是这个原路径，所以移动目录不改变包的字节。
- `published`：发布之后补上的 Release 附件 pin（`tag`、`asset`、`bytes`、`sha256`）。
- `hold`（可选）：一句原因；有它时 `release:publish` 拒绝发布，也不作默认配置，
  点名构建和核对照常。
- `support_display`（可选，v1／v2 都可写）：随这个 Release 发布的辅助宝石说明，见下文
  [辅助宝石说明](#辅助宝石说明support-display)。它不进 zip，不影响包的字节。

`poe2-locale-release-config/v2` 不指向源目录，而是在一个 v1 配置的包上做声明过的改动：

- `base: {config}`：`release/` 下的 v1 配置；它的源目录、origin 核对照旧。
- `transforms`：按顺序执行，每个改一个成员。`rekey-by-english` 把按稳定 ID 存的名称表
  改成按英文存（`records` 是源目录 `evidence/` 里配对这些字节的 `pobr-native-name-receipt/v1`，
  它必须 pin 住该成员；同一英文有多个译法时取出现最多的、并列取英文行号最小的，
  `conflicts` 固定写 `most-common-then-first-row`，每个取舍记进回执）；`json` 新增一个成员，
  内容是 `value`。其余成员按基础包原字节复制。
- `expect.package`（必填）：期望的 zip `bytes`／`sha256`，`--check` 核对；改动 transform 或基础包
  时必须同时改它，评审由此看到字节变化。
- 包内 `manifest.json` 的 `source` 多出 `transforms`（`id`、`kind`、`member`）；回执的
  `source` 是 `{base, transforms}`，每个 transform 记录输入、输出 pin 和报告。

两种配置的回执都在 `package.index` 写语言索引：每种语言的表和条数，以及该语言
`_meta.json` 里写了 `fallback` 时的回退链和对回退语言同名表的键覆盖
（`fallback_keys_covered`／`fallback_entries`）。这只是描述包里有什么；目前没有任何语言声明
`fallback`，回退由 PoBR 自己决定（Web 在界面语言文件里声明繁→简并做字形转换）。
索引不进 zip：PoBR 要求 `data/<patch>/i18n/*` 正好是游戏包快照清单列出的文件，多一个
成员就拒绝导入。

构建只读源目录：清单之外只允许 `README.md`，每个文件按清单核对字节；`i18n/*` 原样
映射成 `data/<patch>/i18n/*`，加一个新的 `manifest.json`，写成固定时间、STORED 的
zip。zip 只取决于源字节和目标；`receipt.json` 记录生产提交，每次都不同。
输出在 `.cache/release/<game>-<realm>-<配置名>/`（如 `poe2-international-0.5.5.5`）。

- `--check`：检出干净、源目录（v2 为基础配置的源目录）在 HEAD 的 tree 与 `origin.revision`
  上原路径的 tree 相同、zip 等于 `expect.package` 和 `published`（有的话）；保留的辅助宝石说明
  目录同样要等于它的 origin tree，声明了 `dictionary`／`catalog` 时还要能由它们重新算出相同的
  `entries` 和 `untranslated`。
- `--fetch`：本地没有 `origin.revision`（含辅助宝石说明的）时从 origin 取（只走 Git），并把
  辅助宝石说明固定的下载（词典、游戏包）下到 `.cache/release/inputs/<sha256>`；之后离线可重跑。
- `--check-release`：下载 `published` 的 Release，要求与重建结果逐字节相同；有辅助宝石说明时
  它的 `SHA256SUMS` 还必须列出重建出的两个文件。另外要求 origin 上每个 `locale/*` tag 都正好由
  一个 `release/*.json` 的 `published` 固定：已发布但配置还没写 `published` 时失败。

## 辅助宝石说明（support display）

PoBR Web 在辅助宝石上显示的简中说明不是语言包成员，而是语言 Release 的两个额外附件：

- `supportDescriptions.zh-CN.json`：`{_meta, entries, untranslated}`，按辅助宝石 `skill_id`
  记英文原文和简中译文，没有译文的 ID 在 `untranslated`。
- `support-display.zh-CN.json`：清单（`poe2-support-display-publication/v1`），写 `target`
  （`game`、`version`、`realm`）、`locale`、`catalog_sha256`、`files`（固定上一个文件）、
  `provenance`（`kind`、`generation_data_version`、`source`、`source_commit`、`source_file`、
  `source_sha256`），可选 `applicability`。

**它绑定的是交易目录**：`catalog_sha256` 是游戏包（RePoE Release `game/<patch>-<n>` 的
`pobr-game-<patch>.zip`）成员 `data/<patch>/overlay/trade_catalog.json` 的 SHA-256。PoBR 的
`data:bump`（`pipeline/imports/data_bump.py`、`display_assets.py`）只在 Release 的 `SHA256SUMS`
同时列出这两个附件时采用它们，并核对：清单的目标、语言和 `catalog_sha256` 等于新游戏包的；
文件的字节等于清单的 pin；`_meta.data_version` 等于 `provenance.generation_data_version`，
`_meta.catalog_sha256` 等于清单的，`_meta` 的 `source`／`source_commit`／`source_file`／
`source_sha256` 等于 `provenance`；回执写了 `support_display` 时其 pin 必须是这两个文件。
PoBR 的 Web 测试还要求 `_meta.source_commit` 等于语言包 `i18n/zh-CN/_meta.json` 的
`source_commit`。换游戏 patch 时如果语言 Release 不带辅助宝石说明，`data:bump` 拒绝。
`release:build` 做同样的检查（加上最后一条），不符就拒绝构建；清单里 `files` 的条目必须正好是
`{bytes, sha256}`（PoBR 整个比较）。

`catalog_sha256` 什么时候核对：每次构建都要求它等于清单和 `_meta` 里的值（这只是与配置一致）。
与真实游戏包的交易目录比较：`regenerate` 每次构建都做（目录就是输入）；`retained` 只在
`--check` 且配置声明了 `dictionary`／`catalog` 时做（需要先 `--fetch`）。没有声明它们的 `retained`
配置，`catalog_sha256` 只和配置本身核对，与游戏包是否一致要等 PoBR `data:bump` 时才检查。

所以辅助宝石说明**在游戏 Release 之后生成**：先有 RePoE 的 `game/<patch>-<n>`，才知道交易目录的
SHA-256。**游戏包重新发布（`game/<patch>-<n+1>`）只要改变了交易目录，就要发布新的
`locale/<patch>-<n+1>`**，带上为新目录生成的辅助宝石说明（zip 可以不变：同样的 zip 配上不同的
辅助宝石说明算新内容，`release:publish` 不会因“zip 已发布过”而拒绝）；目录没变则旧的语言
Release 继续可用。

**已发布的 zip 要配新的辅助宝石说明时，新建配置 `release/<patch>-<n+1>.json`，不改已发布的配置**
（带 `published` 的配置一律不改）：v2 配置就写相同的 `base`、`transforms` 和 `expect`，v1 配置写相同的
`source`，再加上新的 `support_display`。zip 不变，`release:publish` 把它发布为 `locale/<patch>-<n+1>`。
直接改已发布配置的 `support_display` 时，`release:publish` 拒绝：`the zip is already published as …;
a new display needs release/<patch>-<n+1>.json`。判断“已发布”时比较 zip 和辅助宝石说明：前一个 Release
已有同样的 zip，并且暂存的辅助宝石说明为空或与它的相同，就算重复；只有新的或改动过的辅助宝石说明
才算新内容。

配置写法（两种 `mode`，都固定两个输出文件和 `catalog_sha256`）：

- `retained`：仓库里的保留目录（`manifest.json`、`supportDescriptions.zh-CN.json`，可有
  `README.md`，别的文件不允许），字节从原提交原样恢复。`manifest` 是 `{path, bytes, sha256}`，
  `asset` 是 `{bytes, sha256}`（文件在清单旁边），`origin` 同 `source.origin`（`repository`、
  `tag`、完整 `revision`，目录被移动过时 `path` 写原清单路径）。可选 `dictionary` 和
  `catalog`（写法同下）记录它的生成输入，`--check` 用它们核对 `entries`／`untranslated`
  （`_meta` 是历史记录，不比较）。
- `regenerate`：`src/release/support-description-projection.mjs` 的 `supportDescriptions` 跑两个固定
  下载：`dictionary` 是 GemEffects 词典（`source` 为 `https://github.com/<owner>/<repo>`、完整
  `source_commit`、`source_file`、指向该提交的 `raw.githubusercontent.com` `url`、`bytes`、
  `sha256`），`catalog` 是游戏 Release 的包（`repository: ackness/repoe`、`tag: game/<patch>-<n>`、
  `asset: pobr-game-<patch>.zip`、`bytes`、`sha256`、`member: data/<patch>/overlay/trade_catalog.json`；
  成员的 SHA-256 必须等于 `catalog_sha256`，包内 `manifest.json` 列了它时 pin 也要一致）。
  `_meta`（`source`…`source_sha256`、`data_version` 为目标 patch、`catalog_sha256`、
  `regen_command`）和清单（`provenance.kind: generated-asset`，另记 `provenance.catalog`；
  `applicability` 取自配置）按固定格式写出。`manifest`／`asset` 是期望的 `{bytes, sha256}`，
  不符时报错信息里给出实际的 pin。`_meta.regen_command` 写配置路径，所以配置必须在 `release/`
  下（否则字节会随机器而变，构建拒绝）。构建前先 `release:build -- --fetch` 下载输入
  （`release:publish` 只读缓存）。

构建把两个文件写到输出目录、列进 `SHA256SUMS`，回执的 `support_display` 记 `mode`、
`catalog_sha256`、`generation_data_version`、`manifest`／`asset`（`{asset, bytes, sha256}`）、
条数和来源；`release:publish` 把它们一起暂存、上传，并写进 Release 说明。v2 配置不继承基础配置的
`support_display`。`release:publish` 只构建、不跑 `--check`（origin tree、声明输入的核对）：发布前先
在同一提交上跑 `release:build -- --fetch --check`（CI 也会跑）。

用 0.5.5.5 保留资产的记录输入（词典 `288d8b9d…` 的 `dictionary/tables/GemEffects.json`、
`game/0.5.5.5-1` 的交易目录 `de57e010…`）以 `regenerate` 重算，`entries` 和 `untranslated`
与保留文件逐字节相同；整个文件不同，只因为 `_meta` 不同：保留文件记的是它当年的生成
（`data_version: 0.5.5.4.2`、PoBR 的旧命令 `regen_command`），重算写的是 `0.5.5.5` 和本库的命令。
所以 0.5.5.5 用 `retained`，PoBR 已固定的字节不变。

CI（`.github/workflows/verify.yml`）对每个 `release/*.json` 跑
`--fetch --check --check-release`，再构建一次并比较 zip 和回执；另一个 job 对每个
`release/regenerate/*.json` 跑 `release:regenerate -- --fetch`（见下节）。

## 从固定输入重新生成

`release:build` 只打包冻结的源字节；`release:regenerate` 证明这些字节能由本库的生产者从
固定输入重新算出来：

```sh
mise run release:regenerate -- --fetch   # 每个 release/regenerate/<patch>.json；--recipe 指定一个
```

`release/regenerate/<patch>.json`（`poe2-locale-regeneration/v1`）声明它复现的 v1 配置
（`reproduces`，文件名相同）、生产任务（`jobs`）和暂时无法重新生成的成员（`frozen`）。
源目录的每个 `i18n/*` 成员必须正好被一个任务或一条冻结记录覆盖。

- `locale-producer`：`src/pobr/locale-producer.mjs` 跑固定的生成清单（`manifest` 是本库某个
  提交里的文件，带字节数和 SHA-256）。清单的每个输入按它自己的来源取：URL（本库的
  `raw.githubusercontent.com` 地址改从 Git 读），或 `producer-commit`（任务的
  `producer_commit`）里的路径。
- `display-texts`：`src/pobr/display-texts.mjs` 跑固定的 catalog 与审核补译 zip（都是本库某个
  提交里的文件）。库模块用本 checkout 的，v3 catalog 的 producer 闭包必须等于它们；
  `supplement_module` 必须等于它在固定提交里的字节。
- `passthrough`：输出等于任务的某个输入时必须声明（会自动检测），例如 `retained-selected`
  原样写出固定的 `_meta.json`。`composed_evidence` 列出生成成员里由固定证据层组合进来、
  但其选择过程还不能重放的部分，各带原因和退出条件。
- `frozen`：成员的字节数、SHA-256、类别（`categories` 里声明）、原因和退出条件。冻结条数是
  进度指标，只减不增。

`--fetch` 拉取本地缺的 Git 提交（`--depth=1`），并把 URL 输入下载到
`.cache/regenerate/inputs/<sha256>`；之后离线可重跑。输出在
`.cache/regenerate/<game>-<realm>-<patch>/`：`regeneration.json`（每个成员的类别
`generated-identical`／`passthrough-identical`／`frozen`／`*-different`、所用输入、任务摘要）
和由重新生成的成员加冻结成员打出的 zip。任何成员不同，或 zip 不等于配置的 `published`，
都以 1 退出。显示文本任务要解开约 390 MB 的 catalog，峰值内存约 4 GB，整次约 40 秒。

0.5.5.5（`release/regenerate/0.5.5.5.json`）：13 个成员中 10 个重新生成且逐字节相同（简中
9 个来自 `locale-producer` 的 Shaman Mantle 清单，`_meta.json` 是 passthrough；
`display_texts.json` 来自 `display-texts`），zip 等于 `locale/0.5.5.5-1` 的 `bd7ba6ce…`。
冻结 3 个：繁中 `base_items.json`、`mods.json`、`skills.json`，它们的 `names.json`
（`0b2ff2e2…`）从未提交，所需的繁中客户端表（`repoe-localized-tables/v1`，`94dcfdc5…`）
只在 RePoE `sources/sources.lock.json` 里留有哈希。`stat_lines.json` 里 140 条原生配对和
两条 Vivid Wisp 原文是固定证据层，它们的选取收据也只有哈希。退出条件写在 recipe 里。

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
   `inputs/`，见 `src/release/build.mjs` 的 `PRODUCER_PATHS`），未改动的文件按原字节
   复制，写 `manifest.json` 固定每个文件，证据放 `evidence/`。
3. 经 PR 合并到 `main`，再新建一个 `release/<patch>-<n>.json` 指向它（`<n>` 是要发布的
   序号；也可以写 v2 配置，在已有配置的包上声明 transform）。**带 `published` 的配置一律
   不改**：CI 靠它持续证明已发布的字节可重现。新 patch 见下节。

## 下一个语言包：`release/0.5.5.5-2.json`

v2 配置，基础包是 `release/0.5.5.5.json`，字节有变化：

- 每张表固定一种键，与 PoBR 的查法一致：`base_items`、`skills` 用稳定 ID；`mods`、
  `passive_names`、`words`、`rare_words`、`classes` 用英文。已发布包里繁中 `mods.json`
  以 mod ID 为键（6384 条），PoBR 按英文词缀名查，所以繁中词缀从来查不到。
  `zh-tw-mods-by-english` 按 `evidence/zh-TW-receipt.json` 的配对记录改成英文键：
  2557 个英文名，其中 178 个在客户端里有不止一种译法（如 `of the Volcano` 的
  `火山之`／`之火山`），按出现次数取一个，全部写进回执。改后覆盖简中 `mods.json` 2536 个键中的 2531 个。
- 不加繁中 `_meta.json`：若声明 `fallback: ["zh-CN"]`，PoBR WASM／CLI 会直接用简中模板为
  繁中建立词条渲染和解析（不做字形转换；`apps/pobr-wasm/src/state.rs` 断言繁中没有渲染器）。
  繁→简回退（含转换）由 PoBR Web 的界面语言文件声明，数据包不需要。
- 表内没有 `zh_cn`／`zh_tw` 之类的字段名（只有 `display_texts.json` 的 `locale` 值）；
  `name_zh_cn`／`name_zh_tw` 是 PoBR Web 读表后自己拼的字段，要在 PoBR 里改。
- 包：6925862 字节，SHA-256 `bdfb38f4…`（`expect.package`）；13 个成员，只有繁中
  `mods.json` 与 `locale/0.5.5.5-1` 不同，包内 `manifest.json` 多出 `source.transforms`。
- 辅助宝石说明（`support_display`，`retained`）：`inputs/support-display-0.5.5.5/`，从
  `handoff/support-display-20261101`（`5046a18a…`）原样恢复，tree 未变；PoBR 现在固定的就是这份
  （`supportDescriptions.zh-CN.json` 183816 字节，`57602ecb…`；清单 1062 字节，`88aef08b…`）。
  交易目录 `de57e010…` 在 `game/0.5.5.5-1` 和即将发布的 `game/0.5.5.5-2` 里相同；配置以
  `game/0.5.5.5-1` 和词典 `288d8b9d…` 作为 `--check` 的核对输入。`_meta.source_commit`
  （`288d8b9d…`）等于简中 `_meta.json` 的。发布后 PoBR 用 `data:bump` 改为从这个 Release 取，
  不再读 `handoff/` tag。

**发布前提（已满足，`hold` 已去掉）**：PoBR 侧的两点：

1. `pipeline/runtime/build_data.py` 改为从语言包自己的 `manifest.json` 取
   `data/<patch>/i18n/*` 的清单和 pin。原来它要求这部分等于**游戏包**（RePoE）快照清单
   `data/<patch>/manifest.json` 列的那份，`game/0.5.5.5-1` 固定的是 `locale/0.5.5.5-1` 的
   13 个哈希，所以语言包单独改任何字节、加任何成员（`index.json`、`_meta.json`）都会被拒。
   （PoBR 已按 owner 组装运行 manifest。）语言索引因此放在回执的 `package.index`，不进 zip。
2. 假定繁中 `mods.json` 以 mod ID 为键的地方改成英文词缀名：
   `crates/pobr-gamedata/tests/mods/load_mods.rs` 的 `traditional_chinese_mod_names_available`
   （查 `Strength1`）、`GameData::mod_names` 的文档（`crates/pobr-gamedata/src/lib.rs`，
   写着 `id -> localized name`），以及 `pobr-i18n` 的 crate 文档（`src/lib.rs`）和
   `NameKind::Affix` 的注释（`src/pack.rs`）。改动随 PoBR 把锁 bump 到这个包的 PR 一起合并。



## 新补丁

1. 按上节准备新 patch 的源目录并合并到 `main`。
2. 新建 `release/<new patch>.json`：`source.manifest` 指向新清单，`source.origin.revision`
   填添加该目录的 `main` 提交，`tag` 填能找到该提交的名字（目前只作记录，不校验），
   不写 `published`。它自动成为默认配置；旧配置继续可构建、继续由 CI 核对。
   等 RePoE 发布了新 patch 的 `game/<patch>-<n>`，再写 `support_display`（通常是 `regenerate`，
   `catalog` 指向该游戏 Release）：PoBR 换 patch 时必须同时采用新的辅助宝石说明。
3. `mise run release:build -- --check`，检查回执里的成员和来源。
4. 合并后在 `main` 的该提交上 `mise run release:publish`，确认 dry run 的计划，再
   `-- --yes`。
5. 另开一个 PR 把 `published` 写进配置（之后 CI 会下载该 Release 核对；这个 PR 合并之前，
   CI 的 `--check-release` 因 tag 未被固定而失败），然后在 PoBR 跑 `data:bump`。

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
| `… is not cached under .cache/release/inputs (run release:build with --fetch)` | 先 `release:build -- --fetch` 下载辅助宝石说明的输入 |
| `Pin mismatch: …` | 辅助宝石说明的文件与配置的 pin 不符；有意的新内容就按信息里的实际值改配置 |
| `the zip is already published as …; a new display needs release/<patch>-<n+1>.json` | 别改已发布的配置，按上面新建 `release/<patch>-<n+1>.json` |
| `Catalog mismatch: …` | 辅助宝石说明绑定的交易目录与配置或游戏包不符；为新目录重新生成并发布新的 `locale/<patch>-<n>` |
| `Provenance mismatch: …` | `_meta` 与清单 `provenance`（或简中 `_meta.json` 的 `source_commit`）不一致 |

**中途失败后重跑 `-- --yes` 即可继续**，同一提交不会得到第二个序号：

| HEAD 已有 | 重跑时 |
| --- | --- |
| 未推送的本地 `locale/<patch>-<k>` tag | 推送，再创建 Release |
| 远端 tag，没有 Release | 创建 Release |
| 草稿 Release，附件与暂存的完全相同 | `gh release edit <tag> --draft=false` 发布草稿 |
| 草稿 Release，附件不全或不同 | 报错；`gh release delete <tag> --repo ackness/poe2-zh-cn-stats --yes`（保留 tag）后重跑 |
| 已发布的 Release | 下载附件比较：相同即“already published”，不同则报错 |

`locale/*` 和 `handoff/*` tag 一律不删、不移动：PoBR 的锁和本仓库的配置按提交读取它们。
