# PoBR 语言文件生产者

PoBR 只消费本库发布的固定语言文件，不再生成语言数据。下面三个入口把本库的
配对结果投影成 PoBR 现有的运行时文件格式，原样移自 PoBR `7cb90dce` 的
`pipeline/native/`（PoBR #237 删除了它们）。投影规则没有改变；改动只有路径：
直接执行本库 `src/` 的模块，默认投影声明放在本库，输出目录换成本库的 `.cache/`。

| 输出（PoBR 路径） | 入口 | mise task |
|---|---|---|
| `i18n/zh-CN/display_texts.json` | `src/pobr/display-texts.mjs` | `mise run pobr:display-texts` |
| `i18n/zh-TW/{base_items,skills,mods}.json` | `src/pobr/name-sidecars.mjs` | `mise run pobr:names` |
| `i18n/zh-CN/stat_lines.json` | `src/pobr/stat-lines.mjs` | `mise run pobr:stat-lines` |

三个入口都只写入一个新的 `.cache/` 子目录（父目录必须已存在且不含符号链接），
产出对应文件和 `receipt.json`。`receipt.json` 记录输入摘要、所执行实现的 SHA-256
和逐条取舍，`adoption` 固定为 `not-adopted`。交付给 PoBR 时把审核过的产物放进新的源
发布目录（`manifest.json` 固定字节数和 SHA-256），由 `release/<patch>.json` 指向它，再按
[RELEASING.md](../RELEASING.md) 发布 `locale/<patch>-<n>` Release，PoBR 用 `data:bump` 采用。
生成本身不修改任何已发布目录。

## 显示文本：`display_texts.json`

```sh
mise run pobr:display-texts --request /absolute/request.json --out .cache/fresh-display
```

请求 schema 为 `pobr-native-display-texts-request/v1`，包含 `game_patch`、`realm`、
`locale`，以及 `catalog: {manifest, sha256[, bytes]}`，指向
`poe2-native-catalog/v1`、`/v2` 或 `/v3` 的 manifest。catalog 的全部 payload、
执行的模块与默认投影文件都先校验摘要，生成后再复核一次。输入没有固定字节上限，
但声明的字节数、实际大小和 SHA-256 必须一致。

- `library: {root, files}` 只有 v3 可以省略。省略时执行本 checkout 的六个模块
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
- `projection: {scopes, literals}` 可选；省略时读取并固定
  [`src/pobr/display-projection.json`](../src/pobr/display-projection.json)。
  唯一支持的 literal 策略是 `all-catalog-conflict-participants`：选择 scope 不会
  把未解决或冲突的记录移出 literal 歧义检查。

输出有两种视图：

- `scopes["Table.Field"][stableKey] = [currentEnglish, translatedOrNull]` 只含投影
  声明的 scope，目前是 PoBR `web/src/lib/nativeDisplayNames.ts` 读取的
  `BaseItemTypes.Name`、`Characters.Name`、`Ascendancy.Name`。PoBR 实现新的精确
  ID 调用方时再增加 scope；其余字段留在本库，不增大玩家下载。
- `entries[currentLiteral] = translatedOrNull` 供 PoBR 的 `translateLines` 使用。
  所有表中同一英文的记录必须一致，去掉引用标记后的别名也参与同一检查。未解决或
  冲突的记录写 null，不取第一行。被拒绝的 v2 组即使英文字段为 null，它的每个候选
  英文与别名也写入 null 阻断。含数值占位符、hash 槽或未知语法的记录不进入 literal
  视图，需要专门的渲染器。

`receipt.json` 保留每条库查询的决定和全部跨表冲突，以及实际使用的 `library`。
本入口不读客户端数据，不推断 patch／realm，不做简繁转换，也不改写数值。

## 繁中名称：zh-TW 三个 ID 文件

```sh
mise run pobr:names --request /absolute/name-request.json --out .cache/fresh-names
```

请求 schema 为 `pobr-native-name-request/v1`：`version`、`locale: "zh-TW"`、
`native: {path, sha256}` 指向 `src/native-names.mjs` 产出的 `poe2-native-names/v1`，
`legacy` 为 `base_items.json`、`skills.json`、`mods.json` 各自的 `{path, sha256}`，
建议附 `compatibility` 说明旧文件的来历。下一轮生成可直接以上一份已发布的 zh-TW
三个文件作为 `legacy`。

对当前来源里的 ID，有译文就覆盖旧值；来源缺失、为空或未翻译时删除旧值，回退
英文。新清单里完全不存在的 ID 保留旧值，并逐条列入 receipt 的
`historical_compatibility`。表行覆盖和重复都会检查；同英文多译只在 ID 不同时
允许，因为 PoBR 按表与 ID 精确读取。简中词缀文件按英文为键，不经过这个入口；繁中 `mods.json` 由本入口按 mod ID 写出，下一个语言包（`release/0.5.5.5-2.json`）再按 receipt 的配对记录改成英文键，见 [RELEASING.md](../RELEASING.md#下一个语言包release0555-2json)。

## 词条译文：`stat_lines.json`

```sh
mise run pobr:stat-lines --selection <receipt.json> --selection-sha256 <sha> \
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

## 验证记录（2026-11-02）

用固定输入重放，结果与 `handoff/locale-retained-20261101`（`a4bd9b5b`）已发布的字节一致：

- 显示文本：catalog 为 `e61f1332` 的 `handoff/windows-fk-20261101/catalog.zip`
  （SHA-256 `f4bbbd01…`），补译为 `5d019466` 的
  `handoff/reviewed-supplements-20261101/runtime.zip`（`989293a6…`），workbench
  模块为 `0e7778c4` 的版本，其余模块用本 checkout，与该 catalog 的 producer 闭包
  一致；请求不含 `library`，使用默认的六模块闭包。产出 `display_texts.json`
  1649082 字节，SHA-256 `381d827a…`，58588 条决定、415 个冲突。
- 繁中名称：`legacy` 为 PoBR `7942e6db` 的 `data/0.5.5.4.2/i18n/zh-TW/*`，
  `native` 为 `names.json`（`0b2ff2e2…`）；三个文件分别为 `67c3db66…`、`af64e24e…`、
  `c0212690…`，receipt 的 records、sources 与 files 与已发布的
  `evidence/zh-TW-receipt.json` 相同。这份 `names.json` 目前只在本地缓存中，
  未进入 Git。
- `stat_lines.json` 未重放：当时的选取收据只存在于已清理的 PoBR 缓存。命令行入口由
  合成测试覆盖，配对核心沿用本库已有的 `native-selected-translations.mjs` 及其测试。

显示文本和简中词典的重放现在由 `release:regenerate`（`release/regenerate/0.5.5.5.json`）在 CI
里每次执行，见 [RELEASING.md](../RELEASING.md#从固定输入重新生成)；繁中名称和
`stat_lines.json` 的两层原生选取仍按上面的原因冻结。
