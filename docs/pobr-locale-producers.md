# PoBR 语言文件生产者

PoBR 只消费本仓库发布的语言包，自己不生成语言数据。下面四个入口把本仓库的配对结果投影成
PoBR 读取的运行时文件格式。

| 输出（PoBR 路径） | 入口 | mise task |
|---|---|---|
| `i18n/zh-CN/display_texts.json` | `src/pobr/display-texts.mjs` | `mise run pobr:display-texts` |
| `i18n/zh-TW/{base_items,skills,mods}.json` | `src/pobr/name-sidecars.mjs` | `mise run pobr:names` |
| `i18n/zh-CN/stat_lines.json` | `src/pobr/stat-lines.mjs` | `mise run pobr:stat-lines` |
| `i18n/zh-CN/stat_lines.json`（官方层、补译与修正）、`_meta.json` | `src/pobr/supplement-lines.mjs`（官方层在 `src/pobr/official-lines.mjs`） | `mise run pobr:supplement-lines` |

四个入口都只写入一个新的 `.cache/` 子目录（父目录必须已存在且不含符号链接），
产出对应文件和 `receipt.json`。`receipt.json` 记录输入摘要、所执行实现的 SHA-256
和逐条取舍，`adoption` 固定为 `not-adopted`。生成本身不修改任何已发布目录；产物要进入语言包，
按 [RELEASING.md](../RELEASING.md#新补丁) 放进新的源目录并发布。

## 显示文本：`display_texts.json`

```sh
mise run pobr:display-texts -- --request /absolute/request.json --out .cache/fresh-display
```

请求 schema 为 `pobr-native-display-texts-request/v1`，包含 `game_patch`、`realm`、
`locale`，以及 `catalog: {manifest, sha256[, bytes]}`，指向
`poe2-native-catalog/v1`、`/v2` 或 `/v3` 的 manifest（没有 catalog 的 locale 见下面的 `official_tables`）。catalog 的全部 payload、
执行的模块与默认投影文件都先校验摘要，生成后再复核一次。输入没有固定字节上限，
但声明的字节数、实际大小和 SHA-256 必须一致。

- `library: {root, files}` 只有 v3 可以省略。省略时执行本 checkout `src/` 下的六个模块
  （`native-catalog`、`native-names`、`strict-json`、`native-catalog-binding`、
  `native-localization`、`native-catalog-fk-binding`），以它们的实际 SHA-256 作为
  闭包，并且 manifest 的 `producer` 必须等于这组摘要；catalog 若由其他版本的模块
  产出，就传 `library`，`root` 指向该 producer 修订的 checkout。v1／v2 的 manifest
  不记录 `producer`，无从比对，所以必须显式传 `library`，沿用它们原有的三模块或
  五模块闭包。
- v3 还要求 catalog 和 manifest 都固定的原始 `verification.json`。这份字节作为
  `expected.verification` 交给 `createCatalogLookup`，由库重新校验严格绑定与 FK
  绑定。验证文件缺失或被改动时，整次导入失败。它只作构建输入，不进入玩家资产。
- `supplement: {manifest, bytes, sha256, module: {file, bytes, sha256, revision}}`
  可选，仅用于 v3。`manifest` 指向 `workbench-export` 产出的
  `poe2-reviewed-native-supplements-manifest/v1`；`module` 固定
  `src/translation-workbench.mjs` 在其 Git 修订下的字节。补译 manifest 的
  `producer` 必须等于六个官方模块摘要加该模块摘要。官方闭包与 catalog
  manifest 的 `producer` 不包含 workbench 模块。库拒绝未审核、跨范围、过期或
  来源不符的记录时，本入口不写任何输出。空补译表是合法输入，结果与只用官方目录相同。
- `projection: {scopes, literals}` 可选，只允许这两个字段；省略时读取并固定
  [`src/pobr/display-projection.json`](../src/pobr/display-projection.json)。
  这个文件只是新候选的默认值：重新生成配方在 `display-texts` 任务里固定自己的
  `projection` 并随请求传入，所以改这个文件不会改变已发布成员的重新生成结果
  （见[语言包配置参考](release-config.md#重新生成配方releaseregeneratepatchjson)）。
  唯一支持的 literal 策略是 `all-catalog-conflict-participants`：选择 scope 不会
  把未解决或冲突的记录移出 literal 歧义检查。
- `names: {file, bytes, sha256}` 可选，指向固定的
  [`curation/display-supplements.json`](../curation/display-supplements.json)（见
  [显示补译与来源标记](translation-workbench.md#显示补译与来源标记)）。其中与请求同 realm、locale 的
  `reviewed` 怪物名（`kind: "monster-name"`）写入 `scopes["MonsterVarieties.Name"][变种 ID] = [英文, 译文]`；
  这时投影必须声明 `MonsterVarieties.Name`。同一 ID 有两条已审核名称时报错。怪物名不写入 `entries`。
- `official_names: {file, bytes, sha256}` 可选，指向 RePoE 从客户端解出的官方 `MonsterVarieties.Name` 文件：
  `{format, localized: {language, game_patch, realm} 或 locale／realm, index_identity 或 observed_client（至少一个
  SHA-256）, names: {<变种 ID>: {english, zh_cn}}}`（文本字段是 locale 小写、`-` 换成 `_`）。文件的 locale 必须等于
  请求的 locale，声明了 `game_patch` 时必须相同，客户端身份必须有 SHA-256。来源必须对得上 locale：
  zh-CN 只接受国服客户端，即客户端索引 SHA-256 等于 catalog manifest 的 `observed_client.index_sha256`，
  或文件声明 `realm: "china"`；国际服客户端的简体表不是官方 zh-CN，直接报错，声明了其他 realm 的 zh-CN
  文件即使索引相同也报错。客户端身份可以在 `index_identity` 顶层，也可以是本地读取的索引
  `index_identity.index.sha256`。zh-TW 必须声明 `realm: "international"`。receipt 的
  `names.official.provenance` 记录 `accepted_by`（`catalog-client-index`、`declared-realm-china` 或
  `declared-realm-international`）、`declared_realm`、`realm_basis`（索引与 catalog 相同时为
  `catalog-client-index`，只凭声明时为 `declared`）、`same_client_as_catalog`，文件列出
  `declared_not_verified`（例如 RePoE lock 对国服文件的 `game_patch`、`realm`）时一并记录。
- `game_package: {file, repository, tag, asset, bytes, sha256}`：给出 `names` 或 `official_names` 时必填，
  RePoE 游戏 Release 资产 `pobr-game-<patch>.zip`（文件名必须是这个）。读其中 `data/<patch>/overlay/minions.json`
  （`monster_variety_id` → `name`）和 `spectres.json`（`id` → `name`），作为每个变种 ID 的**目标英文**；
  同一 ID 出现两个不同英文时视为不确定。
- `official_tables` 可选：官方客户端表来源数组，**新的在前**。每项
  `{file, bytes, sha256, repository, tag, asset, default, default_manifest_sha256, localized, localized_manifest_sha256, scopes}`：
  RePoE 输入 Release 资产（`repoe-release-input/v1` zip）里的一对表包，`default` 目录是英文
  `repoe-native-tables/v1`，`localized` 目录是 `repoe-localized-tables/v1`，各自只含 `manifest.json` 和它固定的文件，
  每个文件都等于根 manifest 的 pin，两个 `manifest.json` 等于各自的 SHA-256。`scopes` 取自
  `GemEffects.SupportText`、`ActiveSkills.Description`、`MonsterVarieties.Name`，并且必须在 `projection.scopes` 里。
  服别跟着 locale：zh-CN 的表包必须是 `Simplified Chinese`、realm `china`；zh-TW 必须是 `Traditional Chinese`、
  realm `international`；英文表包与它同 realm。两个表包出自同一次客户端采集：`game_patch` 与 `source_lock_sha256`
  必须相同（根 manifest 的 `target.game_patch` 也要一致），且 `game_patch` 等于请求的 `game_patch`。按表的 `Id` 列把同一包里的本地化行和英文行配对，只有同时满足以下
  条件才采用：该包的英文与**目标英文**逐字节相同（宝石说明取 `game_package` 的
  `data/<patch>/overlay/gem_descriptions.json`（`repoe-gem-descriptions/v1`，两个宝石 scope 都必须存在），怪物名取 `minions.json`、
  `spectres.json`）；译文非空、不同于英文、含汉字。写入 `scopes[scope][id] = [目标英文, 译文]`，标记
  （`[A|B]`、`[A]`、末尾空格、偶尔的 `\r\n`）原样保留，由使用方渲染；`[`、`]` 不成对（或嵌套）时整次报错，
  新的标记形式不会悄悄出货。不满足的 ID **省略，不写 `null`**：PoBR 把 `null` 当作“显示英文”，会挡住 zh-TW
  回退到转换后的 zh-CN。每个 ID 由第一个采用它的来源决定。receipt 的 `official_tables` 按来源、按 scope 记
  `adopted`、`shadowed`、`not-in-game`、`ambiguous-target`、`ambiguous-id`、`no-default-row`、`english-differs`、
  `untranslated`、`no-han`，以及每个 scope 采用数与缺少的目标 ID 数；某个 scope 一行都没采用时整次报错（否则
  catalog 里该 scope 的行会被悄悄丢掉）。官方表持有的 scope 归它：catalog
  里该 scope 的行仍参与 literal 与 decision，但不写逐 ID 行（计 `owned_catalog_rows`）；采用的表行与 catalog 官方值
  一样算“官方文本已有”：我们的 catalog 补译遇到同一英文时跳过（`skipped`，`source: "official-tables"`）；`MonsterVarieties.Name`
  的表行按官方名处理，我们同 ID 的补译记 `superseded`，与 `official_names` 不能同时给出。
  **没有 catalog 时**（zh-TW）省略 `catalog`，此时不能有 `supplement`、`library`：`entries` 为空，逐 ID scope 只来自
  `official_tables`，`catalog_sha256` 是最新来源的本地化表 `manifest.json` 的 SHA-256（PoBR 只检查形状）。
  例：国服 `inputs/0.5.5.5-1` 对 `game/0.5.5.5-3` 采用 `GemEffects.SupportText` 612 条、`ActiveSkills.Description`
  440 条、`MonsterVarieties.Name` 648 条（`Wolf Companion` → 恶狼同伴；国际服繁中为 狼盟友）。
- `package_texts: {stat_lines, passive_names}`（各为 `{file, bytes, sha256}`）：同一语言包里的官方文本，
  `stat_lines` 用作底的 `stat_lines.json`（只取不带 `origin` 的行），`passive_names` 用 `passive_names.json`。
  有已审核的怪物名要决定时，或 catalog 查询返回我们的补译（reviewed supplement）时必填（重新生成配方给出
  `names` 就必须固定它，并核对它就是本包的文件：`passive_names` 等于源目录成员；`stat_lines` 等于源目录成员
  （带 `origin` 的行不计入），同 locale 的 `supplement-lines` 任务没有官方层时也可以是该任务的底。有官方层时
  底已不是本包的官方文本，只接受源目录成员）。**补译不得遮住官方文本**：catalog 补译的英文在
  `package_texts` 或 catalog 的官方值里已有官方译文时，catalog 行回到未翻译（`null`，decision 记
  `skipped: "official-elsewhere"`）；怪物名的英文在这些地方或已采用的官方怪物名里已有官方译文时记
  `official-elsewhere`（`official`、`source`），都不出货。receipt 的 `official_elsewhere` 记录跳过条数 `skipped` 和每一行 `rows`
  （`kind`、`identity`、`english`、`origin`、我们的 `text`、`official`、`source`）。例：-3 的 `display_texts.json`
  里 `Bulwark` 为 `null`，而 `stat_lines.json` 有官方 `壁垒`，补译不能填它。

  怪物名逐 ID 按目标英文决定：
  - catalog 自身有该 ID 的行时 catalog 优先（官方名记 `catalog-row`，补译记 `superseded`，`by: "catalog"`）。
  - 补译所针对的英文与目标英文不同时记 `retired`（即使该 ID 有官方名出货）。
  - 官方名的英文等于目标英文、且非空、不同于英文：写入 `[english, 官方名]`，不写 `origins`；
    我们对该 ID 的补译记 `superseded`（`by: "official-names"`、官方文本、`supplement_differs`）。
  - 同一英文已有官方译文（见上面 `package_texts`，含其他 ID 已采用的官方名）：`official-elsewhere`，不出货。
  - 官方名的英文与目标英文不同：不采用，记入 `names.official.not_applied["english-differs"]`
    （`official_english`、`target_english`）；该 ID 不在游戏包里只计数（`not-in-game`），目标不确定记
    `ambiguous-target`，空或与英文相同记 `untranslated`。
  - 没有采用官方名时，我们的补译只在其英文等于目标英文时出货（`supplemented`，写 `origins`）；否则记
    `retired`（`reason` 为 `english-differs`、`not-in-game` 或 `ambiguous-target`，并写 `target_english`），
    记录仍保留在 curation。
  - 补译的 `based_on.game_package.sha256` 与固定的游戏包不同时标 `needs_review`。

  receipt 的 `names.counts` 为 `{official, supplemented, superseded, retired, official-elsewhere}`（按 ID 计），
  并记录游戏包 SHA-256。`not_applied["not-in-game"]` 是计数，其余键是 ID 列表。
  两个输入都不给时行为不变，也不需要游戏包。

输出有两种视图：

- `scopes["Table.Field"][stableKey] = [currentEnglish, translatedOrNull]` 只含投影
  声明的 scope。默认投影有四个：PoBR `web/src/lib/nativeDisplayNames.ts` 读取的
  `BaseItemTypes.Name`、`Characters.Name`、`Ascendancy.Name`，以及
  `PassiveSkills.Name`（键是 PassiveSkills 的 `Id`，即 PoBR 天赋树节点的 `id`，
  例如 `mana_regeneration5`）。同一英文天赋名在客户端有多个译法时（例如
  "Mana Regeneration" 在 `mana10` 是“魔力再生”，在 `energy_shield_recovery10` 是“魔力回复”），
  `entries` 里这个英文是 null，按 ID 查 scope 才能拿到各自的译文。PoBR 应当只在
  scope 里该 ID 的英文等于当前英文时采用译文。PoBR 实现新的精确 ID 调用方时再增加
  scope；其余字段留在本库，不增大玩家下载。
  示例（0.5.5.5）：`PassiveSkills.Name` 有 9731 个 ID，8424 个有译文、1307 个为 null；
  `display_texts.json` 因此从 1649082 字节增至 2215826 字节（gzip 后约增加 94 KB）。
  其中只有 1567 个 ID 的英文在 `entries` 里为 null 或不在 `entries` 中（260 个有译文）；
  只保留这些 ID 只增加 gzip 约 9.7 KB，但增量不大，所以默认投影保留完整 scope，PoBR
  可以对每个天赋节点只查 scope。
- `entries[currentLiteral] = translatedOrNull` 供 PoBR 的 `translateLines` 使用。
  所有表中同一英文的记录必须一致，去掉引用标记后的别名也参与同一检查。未解决或
  冲突的记录写 null，不取第一行。被拒绝的 v2 组即使英文字段为 null，它的每个候选
  英文与别名也写入 null 阻断。含数值占位符、hash 槽或未知语法的记录不进入 literal
  视图，需要专门的渲染器。
- `origins` 只在有非官方值时出现，否则整个字段省略（没有补译的请求输出字节不变）：
  `origins.entries[literal]` 与 `origins.scopes["Table.Field"][stableKey]` 的值是 `agent` 或 `human`，标出
  由本项目补译而非官方提供的值。官方值不列出；缺少条目即表示官方。同一 literal 只要有一条官方记录给出
  同一译文，就不算补译；全部来自补译时，有 agent 参与记 `agent`，否则 `human`。schema 仍是
  `pobr-native-display-texts/v1`：旧读者忽略这个字段和未知 scope。

  ```json
  {"schema": "pobr-native-display-texts/v1", "…": "…",
   "entries": {"Flask": "药剂"},
   "scopes": {"MonsterVarieties.Name": {"Metadata/Monsters/Skeleton": ["Skeleton", "骷髅"]}},
   "origins": {"entries": {"Flask": "agent"},
               "scopes": {"MonsterVarieties.Name": {"Metadata/Monsters/Skeleton": "agent"}}}}
  ```

`receipt.json` 保留每条库查询的决定和全部跨表冲突，以及实际使用的 `library`。
`runtime_scopes` 是排序后的 scope；`projection` 记录投影来源：`{source: "request"}`
（请求原样记在回执的 `request` 里），或 `{source: "file", file, bytes, sha256}`（默认文件，
其字节同时记在 `inputs`），再加实际使用的 `scopes`、`literals`。
本入口不读客户端数据，不推断 patch／realm，不做简繁转换，也不改写数值。

## 繁中名称：zh-TW 三个 ID 文件

```sh
mise run pobr:names -- --request /absolute/name-request.json --out .cache/fresh-names
```

请求 schema 为 `pobr-native-name-request/v1`：`version`、`locale: "zh-TW"`、
`native: {path, sha256}` 指向 `src/native-names.mjs` 产出的 `poe2-native-names/v1`，
`legacy` 为 `base_items.json`、`skills.json`、`mods.json` 各自的 `{path, sha256}`，
建议附 `compatibility` 说明旧文件的来历。下一轮生成可直接以上一份已发布的 zh-TW
三个文件作为 `legacy`。

对当前来源里的 ID，有译文就覆盖旧值；来源缺失、为空或未翻译时删除旧值，回退
英文。新清单里完全不存在的 ID 保留旧值，并逐条列入 receipt 的
`historical_compatibility`。表行覆盖和重复都会检查；同英文多译只在 ID 不同时
允许，因为 PoBR 按表与 ID 精确读取。简中词缀文件按英文为键，不经过这个入口。繁中 `mods.json` 由本入口按
mod ID 写出；PoBR 按英文词缀名查，所以 `release/0.5.5.5-2.json` 用 `rekey-by-english` transform 按 receipt
的配对记录把它改成英文键（见[语言包配置参考](release-config.md#v2poe2-locale-release-configv2)）。

## 词条译文：`stat_lines.json`

```sh
mise run pobr:stat-lines -- --selection <receipt.json> --selection-sha256 <sha> \
  --native <candidate.json> --native-sha256 <sha> \
  --legacy <stat_lines.json> --legacy-sha256 <sha> --out .cache/fresh-stat-lines
```

这是 `src/pobr/native-selected-translations.mjs` 的命令行入口。`--selection` 是 RePoE
`tools/pobr-data-adapter --ordinary-facts` 写出的 `pobr-ordinary-facts-receipt/v1`
（`adapter.output_schema` 为符文 `runes/v1` 或天赋树 `passive_tree/v1`，与 repoe adapter 的 `src/schema_id.rs` 一致；
旧收据里的 Rust 类型路径 `pobr_data::catalog::item_overlay::RunesDef`、
`pobr_data::catalog::{PassiveNodeDef[],PassiveTreeMeta}` 按同一 ID 接受），`--native` 是 `native` 命令产出的
`poe2-native-localization-candidate/v1`，`--legacy` 是上一份 `stat_lines.json`。
只追加按实际 CSD 分支选取、且英文和中文都无歧义的整行译文；已有模板保持不变。
receipt 的 `implementation` 固定本入口和 `native-selected-translations.mjs` 两个文件。

## 补译与修正：`supplement-lines`

```sh
mise run pobr:supplement-lines -- --request /absolute/request.json --out .cache/fresh-supplement-lines
```

请求 schema 为 `pobr-supplement-lines-request/v1`：

| 字段 | 含义 |
| --- | --- |
| `target` | `{game: "poe2", game_patch, realm, locale}` |
| `base` | `{file, bytes, sha256}`：作为底的 `stat_lines.json`，例如上一份已发布语言包的成员；行必须正好是 `{src, en}`（本生产者的输出带 `origin`，不能再当底：`edits` 是累积的，应对它的底重新应用） |
| `meta` | 可选 `{file, bytes, sha256}`：作为底的 `_meta.json`；给出时也写 `_meta.json` |
| `game_package` | `{file, repository, tag, asset, bytes, sha256}`：RePoE 游戏 Release 资产 `pobr-game-<patch>.zip`，读其中的 `data/<patch>/overlay/stat_descriptions.json` |
| `edits` | `{file, bytes, sha256}`：[`curation/display-supplements.json`](../curation/display-supplements.json) |
| `official` | 可选，只用于 zh-CN，且必须同时给出 `meta`：官方来源数组，**新的在前**。每项 `{file, repository, tag, asset, bytes, sha256, member, manifest_sha256}`：RePoE 输入 Release 资产（`repoe-release-input/v1` zip，例如 `inputs/0.5.5.5-1` 的 `repoe-input-china_text-0.5.5.5.zip`），`member` 是其中原生描述包的目录（如 `stat-descriptions/china/`），`manifest_sha256` 是该目录 `manifest.json` 的 SHA-256 |

处理顺序：

0. 官方层（给出 `official` 时）。每个来源：zip 的根 `manifest.json` 必须是 `repoe-release-input/v1`，`member`
   目录下必须正好是冻结读取器要的四个文件（`descriptions.json`、`diagnostics.json`、`manifest.json`、
   `source-lock.json`），每个都等于根 manifest 的 pin，`manifest.json` 等于 `manifest_sha256`；解到临时目录后
   原样调用冻结的 `readNativeDescriptions` 与 `buildNativeLocalization`。来源 realm 必须是 `china`：国际服客户端的
   简中不是官方 zh-CN。每个配对写成 `{src: plain(中文), en: plain(英文)}`（`[A|B]`→B，`[A]`→A，`[A|]`→空，
   字面 `\n`→换行），按英文分组后与底比较：

   | 决定 | 规则 |
   | --- | --- |
   | `confirmed` | 该英文的官方译文集合等于底的集合 |
   | `revised`（共享某个译文时 `revised-partial`） | 集合不同：官方行替换底里该英文的所有行（旧的别译，如 轮箭雨，被丢弃） |
   | `kept-pairing-incomplete` | 集合不同，但冻结读取器排除了该英文的某个分支，或排除了含它的整条记录（`nonunique-implicit-default`、`missing-simplified-chinese-group`，记录的默认组每个分支都算），官方集合可能缺一个别译：保留底 |
   | `added` | 底没有该英文，它是游戏包的当前模板，且官方配对的 stat ID 都在模板的 stat ID 里 |
   | `skipped-not-game-template`、`skipped-other-stats` | 底没有该英文，游戏包没有该模板（或 stat ID 不同）：不加 |
   | `skipped-unresolved-markup` | `plain()` 之后英文或译文还留有 `[`／`]`（未知的标记形式）：不出货，保留底 |

   底里没有任何来源提供的英文原样保留（`kept_historical`）。多个来源时，每个英文由**第一个**提供它的来源决定；
   较旧的来源只补新来源缺少的英文（例如后来版本删掉的行），被新来源盖住的计 `shadowed`。官方层的行不带 `origin`，
   其结果是第 1、2 步的底。官方文本的优先级：官方来源（新的在前）→ 历史底（vagrant-soul 词典，较旧的国服文本）
   → 我们的补译。
1. `corrections`：只应用 `reviewed` 且 locale 相同的修正组。每行 `{from, to}` 的 `from` 必须是底里完全相同的
   `{src, en}`，它被替换成 `to` 并加上该组的 `origin`。底里已经是 `to` 时记 `already-in-base`；`from` 的英文
   还在但译文已变，记 `superseded`（底优先）；英文已不在，记 `retired`。修正改了英文（`to.en` 不同于 `from.en`）
   而底里已有 `to.en` 的行时，也记 `superseded`：底优先，同一英文永远不出现第二行。当前官方层（第 0 步，不含
   历史底）提供 `from.en` 或 `to.en`、且底里还没有 `to` 这一对时，记 `superseded-by-official`：官方文本决定该英文，
   我们的修正留在 curation 里，不出货（例：`bonded-modifiers-and-idols-official-terms` 想把 纽带/魔偶 改成
   羁绊/雕像，国服原文就是 从符文和魔偶上获得纽带词缀效果）。唯一例外是 basis `official-typo-format-fix`：
   它只把官方文本里多余的 `\` 改成换行、措辞逐字节不变，国服原文本身也有这个 `\`，所以仍然应用。CSD 里没有的
   英文（例如 `Bonded: …` 前缀行，是 ClientStrings 的 羁绊 加 CSD 余下部分的组合）不受影响。当前官方层提供该英文、
   且底里已经有 `to` 这一对时（例如 `revised-partial` 的官方行同时含 `from` 和 `to`），记 `already-in-base`：
   什么都不改，官方行永远不会被我们的行替换。
2. `entries`：只看 `kind: "stat-line"`。英文必须是游戏包里的当前模板且 stat ID 与 `identity.stats` 相同，
   否则 `retired`；草稿与已拒绝的记录不出货；底里已有同一 `en` 的行时底优先（`official`，并记
   `supplement_differs`）；英文只由我们修正过的行提供时记 `covered-by-correction`（记 `supplement_differs`
   与修正后的译文），不另加一行；其余 `reviewed` 记录追加为 `{src, en, origin}`（`supplemented`）。`based_on` 与固定
   的游戏包不同时只标 `needs_review`。
3. 输出按 `(src, en)` 排序，序列化方式与底相同（两空格缩进、末尾换行）。没有可应用记录时输出与底逐字节相同。

本入口新增或改动的每一行都带 `origin`，其余行保持原字节、不带 `origin`：

```json
{"src": "羁绊： 你受到的增益消减速度减慢 10%", "en": "Bonded: Buffs on you expire 10% slower", "origin": "agent"}
```

PoBR 的 `StatLineTemplate` 没有拒绝未知字段，旧版本会忽略 `origin`。

给出 `meta` 时，`_meta.json` 是底的内容后加一个 `supplements` 块：`schema`、`edits` 与
`base_stat_lines` 的 pin、`game_package`（含 `stat_descriptions_sha256`）、`producer`，以及 `stat_lines` 计数
（每个修正组改了几行、追加几行、按 origin 统计带标记的行；有官方层时另有 `superseded_by_official`：每个
修正组有几行让位给官方文本）。块里只有数据 pin，不放实现摘要，所以以后改代码不会改变已发布成员的重新生成结果。

有官方层时 `_meta.json` 还在 `supplements` 前加一个 `official` 块，服别与语言分开记录：

```json
"official": {
  "locale": "zh-CN",
  "precedence": "official sources in order (the first that supplies an English decides it), then the base, then supplements",
  "sources": [{
    "realm": "china", "repository": "ackness/repoe", "tag": "inputs/0.5.5.5-1",
    "asset": "repoe-input-china_text-0.5.5.5.zip", "bytes": 20301687, "sha256": "fcbf5dc5…",
    "member": "stat-descriptions/china/", "manifest_sha256": "4dfca51f…",
    "package_target": {"game": "poe2", "game_patch": "0.5.5.5", "realm": "china"},
    "source_identity": {"game_patch": "0.5.5.5", "source": "china-stat-descriptions", "acquisition": {"status": "…", "evidence": […]}, …},
    "client": {"capture_receipt": {"path": "capture/capture-receipt.json", "sha256": "e557ccbe…"},
      "capture_json_sha256": "b06de636…", "client_index_sha256": "1fa59396…",
      "executables": [{"name": "PathOfExile_x64.exe", "file_version": "0.5.5.172", "sha256": "2b0de29e…"}],
      "declared": {"game_patch": "0.5.5.5", "realm": "china", "not_verified": ["game_patch", "realm"]}},
    "reader": {"pairs": 24844, "excluded": 1408, "excluded_by_reason": {…}},
    "counts": {"official_english": 22750, "confirmed": 22517, "revised": 103, "added": 28, …}
  }],
  "counts": {"official_english": 22750, "confirmed": 22517, "revised": 103, "revised_partial": 10, "added": 28,
    "skipped_not_game_template": 102, "kept_historical": 5300, …}
}
```

`client` 只在来源锁的 acquisition evidence 有 `client-capture-receipt`、且输入包里有该 SHA-256 的文件时写出：
按哈希找回执，不按路径。`game_patch` 与 `realm` 是所有者的声明（`declared.not_verified`），可执行文件版本是采集脚本
观察到的值。每个英文由哪个来源、以何种决定处理，只写在 receipt 里，不进 PoBR 文件。

`receipt.json`（`pobr-supplement-lines-receipt/v1`）记录请求、输入、游戏包、实现摘要（`supplement-lines.mjs`、
`display-supplements.mjs`、`official-lines.mjs`）、计数、每行修正和每条记录的决定，有官方层时还有 `official`
（同上的块，加上逐英文的 `decisions`）。官方层要解析约 200 MB 的描述包（约 9 秒、1.3 GB RSS），
`pobr:supplement-lines` 与 `release:regenerate` 两个 mise task 都以 `--max-old-space-size=6144` 运行。
重新生成配方的 `supplement-lines` 任务用 `official: [{repository, tag, asset, bytes, sha256, member, manifest_sha256}]`
固定这些来源，按 Release 地址下载到 `.cache/regenerate/inputs/<sha256>`（发布前可预先放好这个缓存离线运行）。
任务名不变：配方按 kind 固定任务，官方层就放在 `supplement-lines` 里。

## 重放

0.5.5.5 的 `display_texts.json` 由 `release/regenerate/0.5.5.5.json` 的 `zh-cn-display-texts` 任务在 CI 里每次
重新生成并逐字节比较：catalog 是 `e61f1332` 的 `handoff/windows-fk-20261101/catalog.zip`，补译是
`5d019466` 的 `handoff/reviewed-supplements-20261101/runtime.zip`，workbench 模块是 `0e7778c4` 的版本，
其余模块用本 checkout 的（与该 catalog 的 producer 闭包相同，所以这六个模块和
`src/translation-workbench.mjs` 不能改字节或移动）。繁中三个文件和 `stat_lines.json` 的两层原生选取暂时
无法重放，原因与退出条件写在配方的 `frozen`／`composed_evidence` 里。
