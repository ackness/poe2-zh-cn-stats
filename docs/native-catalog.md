# 原件显示目录

`src/native-catalog.mjs` 在现有 RePoE 物理表读取器上导出
`poe2-native-catalog/v1`。输入为 `poe2-native-catalog-request/v1`，
其 `language`、`localized`、`english` 与 README 的 native-name request 相同。
可选 `tables` 明确限定本次已获取的表；省略时必须提供全部九表。
`english[].tables` 必须恰好拥有所选范围，各表一个 owner。
这允许真实简中来源先提供 Words / Ascendancy 的小范围候选，不能把其余表算作已覆盖。

```sh
node src/native-catalog.mjs --config /absolute/catalog-request.json --out .cache/catalog/fresh
node --test test/native-catalog.test.mjs test/native-names.test.mjs test/native-localization.test.mjs
```

导出仅写本 checkout 下全新的 `.cache` 目录。`manifest.json` 固定
`catalog.json` 和 `request.json` 的字节数及 SHA-256；固定 consumer commit 和
manifest 外部摘要后再读目录，不以自行重算摘要代替来源批准。

18 个显式显示列是：

| 表 | 列 |
| --- | --- |
| BaseItemTypes | Name、Inflection |
| ActiveSkills | DisplayedName、Description、ShortDescription、WebsiteDescription |
| Mods | Name |
| Words | Text2、Inflection |
| Characters | Name、Description、TraitDescription |
| Ascendancy | Name、FlavourText |
| PassiveSkills | Name、FlavourText |
| ItemClasses | Name |
| AlternateQualityTypes | Description |

脚本不把资源路径、AI 脚本、稳定 ID 或任意字符串列当成译文。
实际 schema 中某些已翻译列仍标记 `localized: false`；导出保留该原声明，
语言依据是已固定 manifest 的显式语言和实际 raw resource 路径。
每表 `bindings.english/localized` 保留独立的来源 manifest、raw resource、
原件摘要及列的完整 `source_column`、`physical_fields`、schema 元数据。
两侧须同游戏、补丁、服别和 schema；不同客户端身份需要先有明确对应证据。

`records` 对每个所选表的源身份和显示字段保留一条完整记录，包括空值、缺行和冲突。
主键为 `[table, key_field, id, field]`；物理行只作固定包内证据。
Words 使用该补丁内唯一 HASH32，并验证两侧 Text、Wordlist 一致，不能跨补丁假定 hash 永久不变。
`context` 保留 Words 的 Text/Wordlist、词缀 Domain/GenerationType、职业 IntegerId/BaseClass、
升华 ClassNo/Character、天赋 PassiveSkillGraphId 等原始消歧值；外键行号仍需由 PoBR 按其事实包解析。
这些显示元数据不成为计算规则、可用性或属性数值。

`templates` 保留编号、原始 format、符号、出现次数、UTF-16 字符范围、方括号原文及其键、
字面数字和 `#` 槽。允许参数重排；格式、重复次数、符号、引用键或字面数字不一致时保留两侧原文，
标记 unresolved，查询回退英文。未知格式串只作为词法元数据保存，由共享 renderer 决定是否支持，
不会被自动换成 `{0:d}`。方括号内容是词法证据，脚本不执行游戏链接或开发注记。
实际 inflection 为空、仅一侧有值或未翻译时照实保留，不能推断语法形式。

`createCatalogLookup(catalog, {game_patch, realm, locale})` 校验范围、重复身份、完整物理行覆盖、
译文状态及模板元数据后返回查询函数：

```js
const lookup = createCatalogLookup(catalog, {
  game_patch: '0.5.5.5', realm: 'international', locale: 'zh-TW',
});
const result = lookup({
  table: 'Words', field: 'Text2', id: 4053401100, english: 'Dire',
});
// result = {status: 'translated' | 'fallback', text, reason, ids}
```

实际英文必须仍匹配当前身份。无 ID 时可按精确 table/field/English 查询，
可增加 `context: {Wordlist: 1}` 等精确源消歧值；所有匹配记录必须均可用且译文唯一。
有一个未译同名者也不任取另一个译文。`conflicts` 同时记录多译和部分未译的同名组。
查询不规范化大小写、空格、分支、ID，不替换参数；消费者不得丢弃这些约束再做模糊命中。

现有 `poe2-native-names/v1` 继续提供原九个名称列和原有排除/冲突契约。
新目录更保守的模板/语言检查不会重写旧 sidecar；PoBR 单独决定其显示应用和升级。
目录生成及测试不证明应用加载、完整中文覆盖、国服数值、来源批准或正式采用。

## 观察客户端与目标绑定 v2

`poe2-native-catalog-request/v2` 使用相同 `language` / `tables` / `localized` /
`english` 请求字段，显式读取 SOURCE 的 `repoe-localized-tables/v2`。目前该入口要求真实索引
路径声明 `Simplified Chinese`，源 `game_patch`、`realm` 仍为 null；v1 的已知同补丁/服别约束不放松。
v2 输入的 `tables.json` 是 SC 全列原行，`default-tables.json` 是同次观察的 default 全列原行。
两个 payload 及 `target_binding.json`、`transfer-receipt.json`、`target-lock.json`、
`wire-observations.json` 必须全部由外部固定 manifest 校验；单 payload 最多128MiB，总量最多256MiB。
输入 decoder 方法是 `stdlib-memory-schema-decoder/v2`，Mac ingest 方法及 receipt 单独保存，
不声称用旧 PyPoE producer 再解码了源 DAT。实际索引路径原样保留，只按规范路径进行大小写等价验证，
重复 case alias 拒绝；不将 raw pin 迁移到改写后的路径。

目标英文包仍由请求逐表明确指定并固定。独立的 `target_binding` 使用
`stable-key-current-english-all-nontext/v1`，声明已知目标 game/patch/realm、逐表 manifest、
payload、raw resource、schema 和原始列定义摘要。列摘要范围是 `columns[].schema`，
含未解释的原 schema 属性。词法 `localized` 旗标不决定允许更改的18个显示列。
其他全部物理字段（包括 Words.Text、Wordlist 及未知字段）都是显式非 text 比较字段。

语言读取器会重新核对实际三侧表的物理列、typed values、行范围和所有 target pins，按稳定 key
重新计算完整接受/拒绝清单，而非只信 receipt 中的布尔值：

- default raw 与目标 raw 精确相同，可建立 resource-bound 对应；仍检查实际全部解码行、唯一 key 和 SC 非 text。
- 其余情况按 key、目标当前所有所需英文 text 及全部显式非 text/结构值比较，建立 record-bound 对应。
- 重复 key 不取第一行；缺 key、当前英文变化、非 text 差异或不一致 receipt 均不能提供目标译文。
  数据中的拒绝组、每侧全部物理 row 引用和 text/context 候选保留；receipt 自身伪造、缺记录或 pins 不一致使生成失败。

输出 `poe2-native-catalog/v2`（及 manifest/v2）的顶层 `game_patch` / `realm` 是明确的目标运行包身份。
观察身份在 `observed_client` 和原始来源 provenance 中继续保持 null，完整 target_binding receipt 独立保存。
外键行数值相等仅是该显示对应规则的物理比较证据，不推断引用对象语义、SC 数值或整个客户端版本。

原 `createCatalogLookup(catalog, {game_patch, realm, locale})(query)` API 和返回形状保持不变。
v2 被拒绝的记录为 unresolved，原因 `target-binding-rejected`，`applicability.reason_codes` 保留源细因；
完整重复/缺失候选在该记录的 `candidates.default/localized/english` 中。接受的唯一记录不重复保存三份相同英文，
其 row 引用保留在绑定 receipt；没有 `candidates` 时原单一 text/context 字段仍完整。
英文查询会把重复目标 key 的每一个当前英文候选作为未决 blocker；不能因为 `row.english === null` 而省略它们。
scope/literalMap 投影也必须保留这些 null blocker 及去除显示标记后产生的 alias。

这个版本的实际本地模块闭包是 `native-catalog.mjs`、`native-names.mjs`、`strict-json.mjs`、
`native-catalog-binding.mjs`、`native-localization.mjs`（均在 src 下），除 Node 标准库外无其他依赖。
后两者用于独立绑定校验与已有 canonical JSON 工具，不增加 CSD renderer 或 DAT 解码器。
消费方需固定并核验全部五文件，再导入查询 API。旧 v1 三模块证据要用其原固定源码分别重放，
不能把新源码和旧闭包摘要混用。synthetic fixture 仅证明接口；正式 SC 覆盖依实际九表包另验。
