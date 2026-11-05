# PoE2 中文语言数据（简中／繁中）

[English](README.md) | **简体中文**

为 PoBR 及其他《流放之路 2》工具提供可追溯的英文、简体中文和繁体中文词条、名称与显示文本。本仓库采集交易词条、
配对客户端语言、维护人工补译，并把 PoBR 使用的语言文件发布为 GitHub Release `locale/<patch>-<n>`。仓库名沿用
最初的 `zh-cn-stats`。

每份输出都记录来源、版本身份和校验摘要；缺译和冲突单独记录，供维护者核对。

**语言范围**：只有英文（`en`）、简体中文（`zh-CN`）和繁体中文（`zh-TW`）。简中是重点，也需要单独处理：
它的官方文本属于腾讯国服，所以简中数据由腾讯交易目录、固定的客户端语言表和审核过的人工补译组成，区服与
语言分开记录。英文和繁中来自国际服客户端与 GGG 交易目录。国际服客户端里的简中文本不能证明国服数值相同。

## 从哪里开始

| 你的目的 | 入口 |
| --- | --- |
| 发布或更新 PoBR 语言包 | [RELEASING.md](RELEASING.md) |
| 在自己的工具里使用交易词条翻译 | [交易词典读取示例](docs/trade-dictionary.md#其他仓库如何接入) |
| 采集交易目录、补一条译文、修正模板 | [交易词典维护](docs/trade-dictionary.md) |
| 配对原件名称、技能说明或 stat 描述 | [原件显示目录](docs/native-catalog.md)／[原生描述接入口](docs/native-localization.md) |
| 审核原生文本补译和区服差异 | [补译与区服工作表](docs/translation-workbench.md) |
| 改代码或提交 PR | [AGENTS.md](AGENTS.md)（目录、命令、校验、约定）、[CONTRIBUTING.md](CONTRIBUTING.md) |

全部文档见[文档导航](docs/README.md)。

## 与 RePoE、PoBR 的关系

RePoE 解码客户端并发布游戏包 `game/<patch>-<n>`；本仓库负责译文、模板与人工补译，发布语言包
`locale/<patch>-<n>`；PoBR 用 `mise run data:bump` 在 `pipeline/data.lock.json` 里固定这两个 Release 的仓库、
tag、附件和 SHA-256，运行时只使用打包好的文件。分工和共同约定只在
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)里维护一份；当前跨仓缺口见
[数据现状](https://github.com/ackness/pobr/blob/master/docs/data-status.md)。

## 提供哪些数据

| 数据 | 来源与产物 | 使用边界 |
| --- | --- | --- |
| 交易词条 | GGG／腾讯交易目录、分裂词缀译文复用、PoE2DB 补缺；`data/snapshots/<id>/generated/` 的 `dictionary.json`、`pairs.json` | 主键为完整交易 ID **加英文分支** |
| 编号模板 | 交易词典的保守转换及 `curation/curated.json`；`templates.json` | 自动转换只接受零／单数值槽，多参数由人工审核 |
| 原生描述与名称 | 固定的 RePoE 客户端事实、CSD 描述和显式语言表 | 保留 stat ID、表身份、条件和分支，按精确上下文查询 |
| PoBR 语言包 | 名称、显示文本、选中的描述及固定的历史简中词典，另附简中辅助宝石说明 | 以 `locale/<patch>-<n>` Release 发布，PoBR 固定其附件的 SHA-256 |
| 人工补译 | `curation/` 下的工作表及审核记录 | 草稿不进入已审核输出，来源变化后需要复核 |

交易 ID、游戏 stat ID 和显示文本各有用途，不能互相代替。交易覆盖率也不代表完整汉化或计算机制覆盖率。
历史兼容词典保留其社区来源，繁中保留独立来源；不能把整个仓库描述为纯官方文本或完整客户端语言库。

## 本地开发

先安装 [mise](https://mise.jdx.dev/)，在仓库根目录执行：

```sh
mise trust
mise install --locked
mise run setup
mise run check
```

`mise.lock` 固定 Node 版本；`setup` 按 `package-lock.json` 安装依赖并禁用依赖包的生命周期脚本，首次需要联网。
`check` 运行测试，并离线核对当前交易快照的来源摘要与可重现生成。所有命令都经 mise 执行：有任务的用
`mise run <任务>`，其余用 `mise exec -- <命令>`。

```sh
mise exec -- npm run refresh   # 联网重新采集交易目录与配置的 PoE2DB 页面，验证后激活新快照
mise exec -- npm run build     # 编辑 curation/ 后，用保存的原始响应离线重建
mise run report                # 查看覆盖报告
```

| 要改的内容 | 编辑位置 |
| --- | --- |
| 已有交易 ID＋英文分支缺译 | [`curation/translations.json`](curation/translations.json) 的 `manual_chinese`、`manual_note`、`manual_source_url` |
| 明确覆盖既有交易译文 | [`curation/overrides.json`](curation/overrides.json)，附理由与来源 |
| 非交易模板、多参数模板、稀有名组成词 | [`curation/curated.json`](curation/curated.json) |
| 原生名称／描述补译 | [`curation/native-translations.json`](curation/native-translations.json)，按[工作表流程](docs/translation-workbench.md)审核 |
| 补充采集页面 | [`curation/trade-sources.json`](curation/trade-sources.json) |

## 目录

```text
curation/                     人工维护的输入（交易补译、模板、修正、原生补译、采集页面）
data/CURRENT                  当前交易快照的目录名
data/snapshots/<id>/          原始交易响应与页面证据（raw/）、词典与报告（generated/）
reports/                      已提交的可读待办快照，由 workbench 命令生成，不是输入
release/<patch>[-<n>].json    语言包 Release 的构建配置
release/regenerate/<patch>.json 从固定输入重新生成该包各成员的配方
inputs/                       配置固定的源字节（只读，与原提交相同）
src/cli.mjs                   交易词典与原生文本命令入口
src/trade/                    交易词典：采集、配对、生成与验证
src/release/                  release:build／release:publish／release:regenerate
src/pobr/                     PoBR 语言文件生产者与历史简中词典生成
src/*.mjs（其余 7 个）         原生目录库，路径与字节冻结（见 AGENTS.md）
test/<领域>/                  按 src/ 领域分组的离线测试（test/native/ 对应原生目录库）
docs/                         数据契约和维护指南
sources/                      语言来源台账
.cache/                       本地候选与临时文件，不提交
```

哪些可编辑、哪些冻结或生成，以及 7 个原生模块为何冻结在 `src/`，见 [AGENTS.md](AGENTS.md#layout)。

## 语言包发布

`release:build` 只打包配置固定的源字节，不重新生成；`release:regenerate` 另行从固定输入重新生成各成员并
逐字节比较；`release:publish` 发布 Release，PoBR 再用 `data:bump` 采用。CI 每次都重建每个已发布的包并与
Release 逐字节比较。步骤见 [RELEASING.md](RELEASING.md)。`locale/*` 和 `handoff/*` tag 一律不删除、不移动。

## 来源与权利

交易来源为 [GGG](https://www.pathofexile.com/api/trade2/data/stats)、[腾讯](https://poe.game.qq.com/api/trade2/data/stats)
和配置中的 [PoE2DB](https://poe2db.tw/) 页面。官方交易端点不提供客户端补丁号，所以交易快照的 `game_patch` 为
`null`。采集范围、访问限制和失败行为见[来源与访问边界](docs/trade-dictionary.md#来源与访问边界)。

游戏文本、原始响应及网页内容的权利归各自来源方。仓库公开不为这些内容授予新的许可；本项目与 GGG、腾讯和
PoE2DB 无隶属关系。
