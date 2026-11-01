# 原件补译与区服工作表

`native-translations.json` 保存人工或 agent 的补译，原始官方 catalog 保持不可变。
`native-translation-worklist.json` 是已提交的可读待办快照；它记录输入 catalog 的摘要，
不是当前游戏的完整语言包。`native-regional-candidates.json` 单列目标表中缺少的来源条目，
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
请求和最后写入的 manifest。目录必须在本库 `.cache` 且尚不存在；命令不联网、不覆盖旧目录，
不改 CURRENT。可将新 worklist 和 regional-candidates 作为根目录两份可读快照提交，
完整证据留 cache 或固定数据分支。快照保留输入身份，不能冒充生产采用。

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
的签名、行为或五模块闭包。PoBR 现有官方目录不会因工作表有草稿就暗中加载它们。

官方补译会自动优先，旧 agent 文本及差异标记仍保留。catalog 摘要或版本变化后，旧补译
须重新核对；英文或 context 变化会产生新的 entry_id，旧条目进入历史，禁止自动套用。

## 国服专属内容

区服和语言是两个独立维度。相同 ID／英文的 `china/zh-CN`、`international/zh-CN` 和
`international/zh-TW` 是三个独立条目，补译及查询不能串用。已确认的国服事实应由独立
China catalog 提供，不能把 international target-missing-key 直接改为国服事实。

当前 Windows 观察源 patch/realm 为 null。它对应到国际服目标的已接受文本，只证明该
文本的目标适用范围；source-only 记录保留在 regional-candidates 中待核。确认“国服专属”
还需独立区服／版本证据，不能靠中文字体、目录语言、行数或单一目标中不存在来推断。
本工作表不改变物品可用性、数值、词缀成员关系或任一来源批准状态。
