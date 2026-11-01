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
