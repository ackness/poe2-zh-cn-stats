# PoE2 简中词缀表

独立维护的英文／简体中文 PoE2 交易词条数据与可复现生成代码。

主来源是 GGG 与腾讯的交易词条；分裂词缀在严格匹配时复用普通词缀译文；PoE2DB 的公开中英文页面补充缺口。没有依赖第三方成品翻译词典，也没有机器猜译。

**仓库保持私有。** 脚本不修改 GitHub 可见性，不自动提交或推送。代码可运行不等于上游授权公开分发；公开仓库前需另行确认数据来源的使用和再分发条件。

## 使用

需要 Node.js 22 或更新版本、npm。初次克隆已经带有经过校验的数据快照，离线构建无需访问游戏网站。

```sh
npm ci --ignore-scripts
npm test
npm run check
npm run report
```

更新官方目录与配置中的 PoE2DB 页面：

```sh
npm run refresh
```

只获取官方交易目录，不访问 PoE2DB：

```sh
npm run refresh -- --trade-only
```

`--trade-only` 生成不含 PoE2DB 证据的新快照，覆盖率可能下降，不会暗中沿用旧页面。每次成功更新会创建独立快照并切换 `data/CURRENT`。旧快照保留，可通过 Git 历史比较。

修改匹配规则或人工修正后，从当前原始响应重建：

```sh
npm run build
npm run check
npm run report
```

已发布快照不可原地写入。`build` 对当前或指定的 `data/snapshots/<ID>` 创建新候选，保留原始采集时间并记录 `rebuilt_from`，全部校验成功后切换 `CURRENT`；失败时旧快照不变。对 `.cache` 候选的构建不会自动激活。

成功激活还会同步根目录的 `translations.json` 补译工作表。新缺口自动加入，已补全和已退出上游目录的条目保留状态与人工内容。快照内保存同一张表，便于追溯；检测到发布期间有人编辑工作表时，不覆盖这些编辑，按报错重新构建。

`check` 重新核对原始响应的 SHA-256 和字节数，并离线再生成所有产物进行逐字节比较。它不会联网，不会修改数据。GitHub Actions 也只运行离线测试与校验，不定期抓取网站、不自动发布。

### 中断恢复

抓取的候选位于 `.cache/candidate-<时间戳>/`。两个官方目录有任一失败，候选不会激活。若采集成功但解析或生成失败，可修正规则后使用同一份响应，不必再次下载：

```sh
npm run build -- --snapshot .cache/candidate-<时间戳>
npm run check -- --snapshot .cache/candidate-<时间戳>
node src/cli.mjs activate --snapshot .cache/candidate-<时间戳>
```

激活只接受仓库 `.cache` 内已经生成并通过校验的候选。`data/CURRENT` 在完整校验成功后才原子切换。

## 数据结构

```text
sources.json                         官方入口及有限的 PoE2DB 页面清单
overrides.json                       自己维护的、有来源的精确修正
translations.json                    可编辑的持续补译表，含待办及已解决历史
src/                                 采集、配对、补缺、生成、校验代码
test/                                行为回归测试
data/CURRENT                         当前快照目录名
data/snapshots/<时间戳>/
  manifest.json                      URL、采集时间、响应摘要、校验和、失败记录
  raw/*.json.gz                      原始 GGG／腾讯响应，非重新序列化的副本
  raw/*.html.gz                      采集成功的 PoE2DB 原始页面
  raw/*.txt.gz                       当次获取的 robots.txt
  generated/
    dictionary.json                  主表：每个完整 ID＋英文分支一条记录
    pairs.json                       去重文本对，仍保留 IDs 和来源方式
    coverage.json                    分阶段、分类别的覆盖与诊断汇总
    unresolved.json                  未解决的 ID／英文分支和原因
    conflicts.json                   来源间的译文差异、配对冲突、人工覆盖
    source-issues.json               下载或页面提取诊断
    poe2db-evidence.json              提取出的双语候选及结构化证据
    overrides.json                   生成时使用的人工修正原文
    translations.json                本快照的补译表、采用结果和人工记录
```

主表记录示例：

```json
{
  "id": "explicit.stat_3299347043",
  "category": "explicit",
  "english": "# to maximum Life",
  "chinese": "# 生命上限",
  "method": "trade",
  "reason": null,
  "evidence": [
    {
      "source": "trade-cn",
      "id": "explicit.stat_3299347043",
      "text": "# 生命上限"
    }
  ]
}
```

**主键是完整 `id` 与 `english` 的组合，不是单独 `id`。** 同一个交易 ID 可能有不同英文分支；同一英文也可能在不同类别下有不同中文。不要把主表压成 `Map(id, chinese)`，也不要无条件取第一条翻译。

未解决项的 `chinese` 为 `null`，`method` 为 `unresolved`，`reason` 说明原因。没有空字符串或假译文兜底。`#` 是交易模板的值槽；此仓库不把它自动转换为游戏原始 stat ID 或 PoBR 的 `{0}` 模板。

## 配对与来源优先级

1. **官方直接配对 `trade`**：完整 ID（包括 `|` 后的枚举值）相同；两边均只有一个不同文本；中文含汉字；占位符数量一致。相同重复行可去重，不同分支不得按数组顺序拼接。`pseudo` 综合统计不作为实际游戏词条进入主表。
2. **普通词缀复用 `explicit-reuse`**：只对腾讯没有该完整分裂 ID 的情况使用；必须找到相同 stat 后缀的 `explicit.*`，英文完全一致，普通词缀本身已直接配对。有现存冲突的分裂中文时不覆盖它。记录保留 `fractured.*`，证据指向真实的 `explicit.*` 来源。复用译文不能改变交易过滤条件。
3. **PoE2DB 补缺 `poe2db`**：从中英文页面内嵌的 JSON 修饰词池、或具有底层 Stats 信息的详情卡片提取。不得执行远程 JavaScript。依据非本地化结构、词缀族、等级、类型、标签、数值区间、关键字及作用域配对；不能用显示名称、页面顺序或语言相关缓存哈希作稳定 ID。只替换明确标记的数值片段，保留字面条件、符号、百分号及参数顺序。
4. **人工补缺 `manual-fallback`**：从根 `translations.json` 读取，仅在以上来源仍未解决时使用。后续可靠来源补齐后自动让位，不删除人工记录。
5. **精确人工修正 `manual`**：从 `overrides.json` 读取，经维护者核实后可显式覆盖所有其他结果；保留理由和来源，覆盖旧值会出现在冲突报告中。

PoE2DB 候选只在规范化空白后的英文**完全一致**、中文候选唯一且参数数量相同的情况下补入。它不会覆盖已解决的官方译文；若官方有多个中文分支，补充候选还必须属于这些分支。不同来源的措辞冲突保留在报告中，不凭多数投票抹平。

结构配对与数值检查不是语义正确性的完整证明，尤其是数值相同的多个参数。使用方应保留证据与作用域，不能将这些指标理解为所有游戏机制都已支持。

## 维护剩余缺口

### 持续补译表

根目录的 **[`translations.json`](translations.json)** 是日常维护入口。首次生成已将当前全部 265 条缺口放入表中，后续数量以 `npm run report` 为准。它不是每次清空的临时报表；已解决项会保留下来，便于核对人工内容与新来源的差异。

只编辑这三个字段，不要改 `id`／`english` 来迁移译文：

- `manual_chinese`：人工译文；`null` 或空字符串表示不提供人工补缺。
- `manual_note`：核对说明；提供人工译文时必填，可以在未翻译时先记研究线索。
- `manual_source_url`：可选 HTTPS 来源链接；自己翻译、没有外部来源时保留 `null`，不要编造链接。

`status`、`chinese`、`method`、`reason`、`manual_differs` 和 `evidence` 都由生成器重算。`chinese` 是最终采用的译文，**不是输入栏**；手工补译请填写 `manual_chinese`。

例如，找到对应行后填写如下内容，再运行 `npm run build` 和 `npm run check`。这是人工填写格式示例，不代表已经收入或认定为官方译文：

```json
{
  "id": "crafted.stat_1301765461",
  "english": "#% to Maximum Chaos Resistance",
  "manual_chinese": "#% 混沌抗性上限",
  "manual_note": "已人工核对词义，保留百分号和参数顺序",
  "manual_source_url": null
}
```

| `status` | 含义 |
|---|---|
| `pending` | 仍然缺少可采用的译文 |
| `manual` | 正在使用人工补缺，主表 method 为 `manual-fallback` |
| `automatic` | 当前 GGG／腾讯配对、分裂复用或 PoE2DB 已提供译文 |
| `override` | 使用 `overrides.json` 中明确指定的修正 |
| `retired` | 当前英文目录不再包含这个完整 ID＋英文组合，旧人工内容仅存档、不应用 |

更新行为：

- 每次 `npm run refresh` 自动重新对照来源：新缺口入表、已有缺口更新状态。现有 CI 只校验，不定时抓取网站。
- 新来源译文优先于人工补缺；若与人工内容不同，`manual_differs` 为 `true`，并写入 `conflicts.json`，人工原文和备注不会被抹掉。
- 来源再次缺失时，可重新使用仍匹配同一 ID＋英文的人工补缺；没有人工内容则回到 `pending`。上一次自动译文不会偷偷充当离线兜底。
- ID 相同但英文变化时，旧行变为 `retired`；新英文仍缺译文则新增 `pending` 行，不自动套用旧翻译。原英文之后重新出现，才可重新使用对应人工记录。
- 修改或移除某条人工译文后需重新构建。重复行、非中文译文、缺少备注、占位符数量不符会阻止生成，不切换当前快照。相同 ID 的不同英文分支、`|` 后的不同枚举值分别维护。
- 提交时同时提交根工作表、`data/CURRENT` 和新快照；不能只提交人工修改而让生成数据保持旧版本。Git 快照保留每次完成更新时的状态与内容。

`unresolved.json` 仍然只列当前未解决项；`translations.json` 则记录持续工作流。`coverage.json` 的 `translation_worklist` 汇总各状态及人工差异数量，它统计的是工作表中的条目，不是整个词典中所有自动翻译。

### 扩展来源与固定修正

先查看 `unresolved.json`、`conflicts.json` 与 `source-issues.json`，避免把交易类别缺失、重复分支和真正没有译文混为一谈。

- **增加补充页面**：编辑 `sources.json` 的 `poe2db.pages`。每个 slug 对应 `/us/<slug>` 和 `/cn/<slug>`；使用已确认存在的公开页面。然后运行 `npm run refresh`，已有工作表自动对照这些新候选。
- **明确覆盖官方或补充来源**：这与普通缺口补译不同。在根 `overrides.json` 添加如下格式，再运行 `npm run build` 和 `npm run check`。示例只说明格式，不会自动加入数据。

```json
[
  {
    "id": "explicit.stat_3299347043",
    "english": "# to maximum Life",
    "chinese": "# 生命上限",
    "reason": "核对当前来源页面并确认数值含义与顺序",
    "source_url": "https://poe.game.qq.com/api/trade2/data/stats"
  }
]
```

修正必须精确对应当前 ID＋英文分支，必须有中文、HTTPS 来源与理由，且值槽数量一致。重复修正、过期英文或参数数量不符都会使生成失败，不会静默套用。

## 覆盖率的含义

- `entries`：完整 ID＋英文分支的记录数。
- `fully_resolved_ids`：该 ID 的所有英文分支都已有候选译文。
- `distinct_english`／`covered_english`：跨交易类别去重后的英文文本数与有候选译文的文本数。
- `stages`：仅官方、分裂复用、PoE2DB 补缺、固定修正（`overrides`）、加入人工补缺后的最终累计覆盖（`manual`）。

分裂复用通常提升 ID 覆盖率，但不增加新的英文文本，不能重复计入文本覆盖收益。当前目录不包含完整的技能说明、天赋名称、任务或其他非交易文本；本仓库是**词缀／交易模板表**，不是完整游戏汉化包。

## 来源与访问边界

- GGG：<https://www.pathofexile.com/api/trade2/data/stats>
- 腾讯：<https://poe.game.qq.com/api/trade2/data/stats>
- PoE2DB：<https://poe2db.tw/>，语言入口 `/us/` 与 `/cn/`。

请求串行执行，PoE2DB 请求间隔至少一秒，使用可识别的 User-Agent。只访问配置中有限的页面，不进行全站搜索／爬取；不发送登录凭据，不跟随重定向，不绕过验证码，不自动重试 403 或 429。PoE2DB 明确拒绝请求时停止后续页面采集，失败和缺失保留在快照中。

每次读取 PoE2DB 的 robots.txt；若其规则与已审查版本不同，停止补充采集，要求维护者重新审核。robots 规则不是许可证。页面的 Wiki 授权也不能直接视作整个游戏数据集的再分发许可。

PoE2DB 是补充来源：下载或访问策略失败会记录原因，并允许用完整的官方目录及本次成功取得的页面生成快照，覆盖率可能降低。详情页中不能安全配对的内容同样只记诊断，不猜译。相反，任一官方目录缺失或没有非 `pseudo` 词条，或识别出的嵌入 JSON 无法安全解析，均使候选失败，不切换当前版本。

官方交易端点未提供游戏补丁版本。`Last-Modified` 与下载时间不是游戏版本号，快照的 `game_patch` 因此为 `null`；不得把国服、国际服及 PoE2DB 自动当成同一补丁。HTTP 200 也不是官方承诺长期提供公开 API。

原始 HTML 仅保存为压缩证据，不执行其中脚本。仓库没有为上游游戏文本、网页或素材授予新许可证。本项目不隶属于 GGG、腾讯或 PoE2DB，也未声称获得它们背书。
