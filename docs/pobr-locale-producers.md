# PoBR 语言文件生产者

PoBR 只消费本仓库发布的语言包，自己不生成语言数据。下面四个入口把本仓库的配对结果投影成
PoBR 读取的运行时文件格式。

| 输出（PoBR 路径） | 入口 | mise task |
|---|---|---|
| `i18n/zh-CN/display_texts.json` | `src/pobr/display-texts.mjs` | `mise run pobr:display-texts` |
| `i18n/zh-TW/{base_items,skills,mods}.json` | `src/pobr/name-sidecars.mjs` | `mise run pobr:names` |
| `i18n/zh-CN/stat_lines.json` | `src/pobr/stat-lines.mjs` | `mise run pobr:stat-lines` |
| `i18n/zh-CN/stat_lines.json`（补译与修正）、`_meta.json` | `src/pobr/supplement-lines.mjs` | `mise run pobr:supplement-lines` |

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
`poe2-native-catalog/v1`、`/v2` 或 `/v3` 的 manifest。catalog 的全部 payload、
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
  `{format, localized: {language, game_patch, realm} 或 locale, index_identity 或 observed_client（至少一个
  SHA-256）, names: {<变种 ID>: {english, zh_cn}}}`（文本字段是 locale 小写、`-` 换成 `_`）。文件的 locale 必须等于
  请求的 locale，声明了 `game_patch` 时必须相同，客户端身份必须有 SHA-256；receipt 记录它，并记录是否与
  catalog manifest 的 `observed_client.index_sha256` 相同（只记录，不强制）。
  非空且不同于英文的官方名写入 `scopes["MonsterVarieties.Name"][ID] = [english, 官方名]`，不写 `origins`。
  某 ID 已有我们的补译、而官方文件对该 ID 的英文与补译所针对的英文不同时，与其他 scope 一样不采用这条官方名，
  记入 receipt 的 `names.official.not_applied["english-differs"]`；与英文相同或为空的官方名记为 `untranslated`。

  每个 ID 的优先级：catalog 自身的行，其次官方名，最后我们已审核的补译。补译只用于官方文件没有或为空的 ID；
  被官方名或 catalog 取代的补译仍保留在 curation，receipt 记为 `superseded`（`by`、官方文本、`supplement_differs`）。
  receipt 的 `names.counts` 为 `{official, supplemented, superseded}`（按 ID 计）。两个输入都不给时行为不变。

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
| `base` | `{file, bytes, sha256}`：作为底的 `stat_lines.json`，例如上一份已发布语言包的成员 |
| `meta` | 可选 `{file, bytes, sha256}`：作为底的 `_meta.json`；给出时也写 `_meta.json` |
| `game_package` | `{file, repository, tag, asset, bytes, sha256}`：RePoE 游戏 Release 资产 `pobr-game-<patch>.zip`，读其中的 `data/<patch>/overlay/stat_descriptions.json` |
| `edits` | `{file, bytes, sha256}`：[`curation/display-supplements.json`](../curation/display-supplements.json) |

处理顺序：

1. `corrections`：只应用 `reviewed` 且 locale 相同的修正组。每行 `{from, to}` 的 `from` 必须是底里完全相同的
   `{src, en}`，它被替换成 `to` 并加上该组的 `origin`。底里已经是 `to` 时记 `already-in-base`；`from` 的英文
   还在但译文已变，记 `superseded`（底优先）；英文已不在，记 `retired`。
2. `entries`：只看 `kind: "stat-line"`。英文必须是游戏包里的当前模板且 stat ID 与 `identity.stats` 相同，
   否则 `retired`；草稿与已拒绝的记录不出货；底里已有同一 `en` 的行时底优先（`official`，并记
   `supplement_differs`）；其余 `reviewed` 记录追加为 `{src, en, origin}`（`supplemented`）。`based_on` 与固定
   的游戏包不同时只标 `needs_review`。
3. 输出按 `(src, en)` 排序，序列化方式与底相同（两空格缩进、末尾换行）。没有可应用记录时输出与底逐字节相同。

本入口新增或改动的每一行都带 `origin`，其余行保持原字节、不带 `origin`：

```json
{"src": "羁绊： 你受到的增益消减速度减慢 10%", "en": "Bonded: Buffs on you expire 10% slower", "origin": "agent"}
```

PoBR 的 `StatLineTemplate` 没有拒绝未知字段，旧版本会忽略 `origin`。

给出 `meta` 时，`_meta.json` 是底的内容后加一个 `supplements` 块：`schema`、`edits` 与
`base_stat_lines` 的 pin、`game_package`（含 `stat_descriptions_sha256`）、`producer`，以及 `stat_lines` 计数
（每个修正组改了几行、追加几行、按 origin 统计带标记的行）。块里只有数据 pin，不放实现摘要，所以以后
改代码不会改变已发布成员的重新生成结果。`receipt.json`（`pobr-supplement-lines-receipt/v1`）记录请求、
输入、游戏包、实现摘要（`supplement-lines.mjs`、`display-supplements.mjs`）、计数，以及每行修正和每条记录的决定。

## 重放

0.5.5.5 的 `display_texts.json` 由 `release/regenerate/0.5.5.5.json` 的 `zh-cn-display-texts` 任务在 CI 里每次
重新生成并逐字节比较：catalog 是 `e61f1332` 的 `handoff/windows-fk-20261101/catalog.zip`，补译是
`5d019466` 的 `handoff/reviewed-supplements-20261101/runtime.zip`，workbench 模块是 `0e7778c4` 的版本，
其余模块用本 checkout 的（与该 catalog 的 producer 闭包相同，所以这六个模块和
`src/translation-workbench.mjs` 不能改字节或移动）。繁中三个文件和 `stat_lines.json` 的两层原生选取暂时
无法重放，原因与退出条件写在配方的 `frozen`／`composed_evidence` 里。
