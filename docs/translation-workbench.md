# 原件补译与区服工作表

`native-translations.json` 保存人工或 agent 的补译，原始官方 catalog 保持不可变。
`reports/native-translation-worklist.json` 是已提交的可读待办快照；它记录输入 catalog 的摘要，
不是当前游戏的完整语言包。`reports/native-regional-candidates.json` 单列目标表中缺少的来源条目，
这些条目可能属于区服或版本差异，不能仅凭简体中文路径认定国服专属。

交易 stat 的补译仍使用原 `translations.json`。本入口处理原件名称、技能说明等有明确
table/field/ID 的文本，不把交易 ID 当成原生 ID，也不生成游戏数值或词缀关系。

## 查看和更新

请求示例（路径和 SHA 必须替换为真实固定输入）：

```json
{
  "schema": "poe2-translation-workbench-request/v1",
  "catalogs": [
    {"manifest": "/path/to/catalog/manifest.json", "sha256": "完整的 manifest SHA256"}
  ],
  "edits": "/path/to/repository/native-translations.json",
  "previous": "/path/to/previous/workbench.json"
}
```

首次生成省略 `previous`。一次可传简中、繁中和不同区服；每个区服／语言只允许一个当前
catalog，多个表应先由现有 catalog producer 合为明确范围，不能按顺序覆盖。

```sh
mise exec -- node src/cli.mjs workbench --config request.json --out .cache/workbench/new
mise exec -- node src/cli.mjs workbench-list --file .cache/workbench/new/workbench.json --status pending --locale zh-CN
mise exec -- node src/cli.mjs workbench-list --file .cache/workbench/new/workbench.json --status draft
mise exec -- node src/cli.mjs workbench-list --file .cache/workbench/new/workbench.json --status regional-review --limit 20
```

输出包括完整 `workbench.json`、按状态列 ID 的 `queues.json`、简要 `report.md`、
可补译的 `worklist.json`、单列来源差异的 `regional-candidates.json`，以及输入 edits 副本、
紧凑 `supplements.json`、请求和最后写入的 manifest。目录必须在本库 `.cache` 且尚不存在；命令不联网、不覆盖旧目录，
不改 CURRENT。可将新的 `worklist.json` 与 `regional-candidates.json` 分别提交为 `reports/native-translation-worklist.json` 与 `reports/native-regional-candidates.json` 两份可读快照，
完整证据留 cache 或固定数据分支。快照保留输入身份，不能冒充生产采用。

机器之间通过 Git 同步数据和证据，线程消息只传提交、路径及摘要。读取器不设置固定的
JSON 文件大小上限；仍核对 manifest 声明的字节数、SHA 和实际文件，并拒绝读取中变化的大小。

v1/v2 catalog 的行为保留。v3 manifest 还必须固定同目录的原始 `verification.json`，
其 `{bytes, sha256}` 必须与 catalog 的 `fk_verification` 完全一致。读取器每个输入只读取一份
原始 Buffer，交给 `createCatalogLookup(catalog, {game_patch, realm, locale, verification})` 完整验证
FK 结构及绑定投影；不能重新 stringify 后替代原件，也不能只信投影上的 accepted 标记。
sidecar 留在原输入目录，不复制到输出或每条 workbench entry；`sources[].fk_verification`
只保留一个文件名／字节数／摘要。观察源 patch/realm 的 null 不会被目标身份填充。

每次接入新版本 catalog，带上原 edits 和 previous 重跑即可。来源暂时未提供的区服、
英文／上下文改变、退出当前目录的旧条目都会保留历史，且不会输出旧补译。

## 对应 JSON 字段

| 字段 | 含义 |
| --- | --- |
| `official_translation.status` | `available` 官方有可用译文；`missing` 已对应的原件仍为英文或空译文；`unverified` 来源／模板／配对未解决；`not-applicable` 英文为空 |
| `official_translation.reason` | 原 catalog 的精确诊断，原译文与物理 row 继续保留 |
| `translation` | 可选的 agent／人工译文及作者、备注、审核、依据 catalog 和 patch |
| `translation_review` | 草稿、已审核、已拒绝或因来源变化／格式问题待复核 |
| `workflow_status` | `pending`、`draft`、`needs-review`、`supplemented`、`official`、`source-review`、`not-applicable`、`retired` |
| `agent_eligible` / `agent_blocker` | 是否有可独立补译的当前英文，或为什么暂不能补译 |
| `regional_scope` | 目标区服、实际观察区服（可为 null）、来源差异原因；`exclusive` 保持未证实的 null |
| `effective_translation` | 官方优先，其次符合全部约束的已审核补译；其他情况为 null |
| `supplement_differs` | 新官方译文与保留的补译是否不同 |
| `seen_in` | 该精确英文／上下文在各次 catalog 中的观察记录 |

“无可用译文”不等于“官方缺译”。缺行、外键绑定失败、参数／引用冲突、非汉字专名等进入
`source-review`，不能让 agent 猜来源或事实。`[DNT…]`、`[UNUSED]`、WIP、TBD、NAME、??? 等
内部占位文本也不自动送补译；保留原值，不替它们创造游戏名称。复杂或隐式参数需要原共享
renderer，工作表只允许已明确支持的参数格式，保留引用 key、参数次数／符号及字面数值。

## Agent 补译

从 worklist 复制精确 `entry_id`、`identity`、`english`、`context`，以 `current` 作为 `based_on`，
填入 `native-translations.json.entries`。记录形状如下：

```text
entry_id: 工作表给出的完整摘要，不能改词句后沿用
identity: {game, realm, locale, table, field, id}
english / context: 原字段逐字保留
based_on: {game_patch, catalog_sha256}
text: agent 或人工译文
origin: agent | human
author: 实际作者／模型
note: 翻译依据及仍待确认的语义
status: draft | reviewed | rejected
review: null 或 {by, note}
```

agent 只翻译所提供的完整英文，使用同区服／语言的现有术语，保留参数和链接。
不要把繁转简结果当成官方简中，不要从显示文本推导游戏效果。新 agent 译文默认 `draft`，
可直接查看但不会被查询 API 采用；审核后改为 `reviewed` 并填写实际审核者和说明。
仓库的初始两条草稿翻译真实 `Freezing Pulse` 历史 WebsiteDescription，分别属于简中和繁中，
沿用各自 DisplayedName；它们不证明该旧网站描述适用于当前技能机制。

`createSupplementedLookup({bytes, sha256}, edits)` 返回显式补译查询入口。查询必须声明
`game_patch`、`realm`、`locale`，agent 补译还要求精确 table/field/ID/English 和完整 context。
返回结果增加 `origin: official | agent | human | null`，不会改现有官方 `createCatalogLookup`
的官方优先行为。v3 官方查询按其原有契约额外传入固定 sidecar；它仍只返回官方文本。
PoBR 现有官方目录不会因工作表有草稿或运行包就暗中加载它们。

官方补译会自动优先，旧 agent 文本及差异标记仍保留。catalog 摘要或版本变化后，旧补译
须重新核对；英文或 context 变化会产生新的 entry_id，旧条目进入历史，禁止自动套用。

## 紧凑 reviewed 运行接口（v1）

PoBR 的显示／显式范围消费者可使用本库 `src/translation-workbench.mjs` 的独立接口。
该接口已由[本库的显示 producer](pobr-locale-producers.md#显示文本display_textsjson)接入；
PoBR 通过唯一的 `pipeline/data.lock.json` 固定并导入语言产物，不再运行显示 producer。
当前真实包仍为 0 条，两个草稿不生效；非空补译的行为验证来自合成用例，不能据接口接线声称已有真实审核译文或浏览器收益。

```js
import { exportReviewedSupplements, createReviewedSupplementLookup } from './src/translation-workbench.mjs';

// bytes 是原 catalog Buffer；sha256 必须来自调用者信任的固定 manifest。
// v3 verification 是该输入原始 sidecar Buffer；v1/v2 可省略。
const inputs = [{ bytes: catalogBytes, sha256: catalogSha256, verification: originalVerificationBuffer }];
const runtime = exportReviewedSupplements(inputs, editsDocument);
// 持久化字节格式：JSON.stringify(runtime) + '\n'（UTF-8，无缩进）。
// 消费时使用 manifest 中固定的原字节与摘要，不能在加载时自行算摘要当作信任依据。
const lookup = createReviewedSupplementLookup(inputs, { bytes: runtimeBytes, sha256: trustedRuntimeSha256 });
lookup({ game_patch: '0.5.5.5', realm: 'international', locale: 'zh-CN',
  table: 'ActiveSkills', field: 'WebsiteDescription', id: 'exact-native-id',
  english: 'Exact supplied English', context: { GrantedEffect: 'exact-context' } });
```

`inputs` 必须包含运行包声明的所有源，每个 realm/locale 只有一个当前 catalog；顺序可不同。
构造 lookup 时固定、验证 catalog 和运行包 SHA，以及 v3 完整 sidecar，之后只查索引。
`reconcileNativeTranslations`、`exportReviewedSupplements` 和旧 `createSupplementedLookup`
同样接受这一个 `verification` Buffer 字段。`manifest_sha256` 是可选的工作表溯源字段。

精确稳定的运行 JSON 形状如下。`source` 是 `sources` 的零基索引；它把每条审核记录绑定到
唯一的 patch/catalog/realm/locale 和 sidecar pin，避免逐条重复来源信息。`id` 保留 catalog 的
原始字符串或数字类型；`context` 必须是该字段完整的英文 context 对象，保留 null 值。

```json
{
  "schema": "poe2-reviewed-native-supplements/v1",
  "status": "candidate",
  "production_ready": false,
  "sources": [{
    "game": "poe2", "game_patch": "0.5.5.5", "realm": "international", "locale": "zh-CN",
    "catalog_sha256": "<64 lowercase hex>",
    "verification": {"bytes": 335031638, "sha256": "<64 lowercase hex>"}
  }],
  "records": [{
    "source": 0, "entry_id": "<64 lowercase hex>",
    "table": "ItemClasses", "field": "Name", "id": "synthetic-fixture",
    "english": "Flask", "context": {}, "text": "药剂",
    "origin": "agent", "author": "fixture-agent", "note": "Synthetic example only",
    "status": "reviewed", "review": {"by": "fixture-reviewer", "note": "Synthetic example review"}
  }]
}
```

v1/v2 源的 `verification` 为 null。空的 `records: []` 是有效运行包，表示当前没有有效
已审核补译。记录只含当前生效的 reviewed agent/human 补译；不含官方文本、草稿、内部占位、
历史队列、物理表、候选和 FK witnesses。完整历史、null 阻断、全部 source reason codes
仍由工作表保留。上面的审核者和文本仅为合成示例，不是对真实草稿的批准。

加载器对来源清单逐项核对；旧 patch/catalog/sidecar、未知或重复来源、越界 source 索引、
重复 entry/原件身份、缺少实际审核人、草稿、英文/context/ID 摘要不符、参数或数字冲突、
非官方缺译及未验证的源绑定都会拒绝整个运行包。`entry_id` 的规则保持原工作表定义：
对 `[identity, english, context]` 的递归排序键 JSON 做 UTF-8 SHA256，其中 identity 包括
`game, realm, locale, table, field, id`。运行包的外部 SHA 同时固定译文与审核说明。

查询必须显式给出当前 `game_patch/realm/locale`，跨范围请求抛错。官方可用译文始终先返回
`{status:'translated', text, reason:null, ids, origin:'official'}`。补译必须再命中精确
table/field/id/English/完整 context，返回
`{status:'translated', text, reason:'reviewed-supplement', ids:[id], origin:'agent'|'human'}`。
其余返回原官方 fallback 的 `{status, text, reason, ids}` 并加 `origin:null`，保留英文与诊断；
不会利用文本同名、部分 context 或未知 ID 去猜补译。缺少／冲突绑定不是 official-missing。
加载失败由调用者保留官方独立入口，不得把未验证运行包降级为可用补译。

可从同一个固定请求重放紧凑导出：

```sh
mise exec -- node src/cli.mjs workbench-export --config request.json --out .cache/workbench/runtime-replay
```

导出重验当前 catalog、原始 sidecar 和 edits，输出 `supplements.json`、`request.json` 和
`poe2-reviewed-native-supplements-manifest/v1` 的 `manifest.json`。manifest 固定文件字节／SHA、
edits SHA 和全部七个 producer 模块 SHA。导出忽略 `previous`，因为历史条目永不生效；
完整 workbench 同时生成的 `supplements.json` 应逐字节相同。两种命令均不复制重型证据。

## 国服专属内容

区服和语言是两个独立维度。相同 ID／英文的 `china/zh-CN`、`international/zh-CN` 和
`international/zh-TW` 是三个独立条目，补译及查询不能串用。已确认的国服事实应由独立
China catalog 提供，不能把 international target-missing-key 直接改为国服事实。

当前 Windows 观察源 patch/realm 为 null。它对应到国际服目标的已接受文本，只证明该
文本的目标适用范围；source-only 记录保留在 regional-candidates 中待核。确认“国服专属”
还需独立区服／版本证据，不能靠中文字体、目录语言、行数或单一目标中不存在来推断。
本工作表不改变物品可用性、数值、词缀成员关系或任一来源批准状态。
