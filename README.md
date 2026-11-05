# PoE2 中文语言数据（简中／繁中）

为 PoBR 及其他 PoE2 工具提供可追溯的英文／中文词条、名称和显示文本，覆盖简体与繁体中文。仓库名沿用最初的 `zh-cn-stats`。本库负责采集交易词条、配对客户端语言、维护人工补译，并生成 PoBR 使用的固定语言文件。

每份输出保留来源、版本身份和校验摘要；缺译和冲突有独立记录，供维护者核对。

## 从哪里开始

| 你的目的 | 入口 |
| --- | --- |
| 发布或更新 PoBR 语言包 | [RELEASING.md](RELEASING.md)（`locale/<patch>-<n>` GitHub Release） |
| 在自己的工具里使用交易词条翻译 | [交易词典格式与读取示例](docs/trade-dictionary.md#其他仓库如何接入) |
| 采集交易目录、补一条译文、修正模板 | [交易词典维护指南](docs/trade-dictionary.md) |
| 配对原生名称、技能说明或 stat 描述 | [原件显示目录](docs/native-catalog.md)／[原生描述接入口](docs/native-localization.md) |
| 审核原生文本补译和区服差异 | [补译工作表](docs/translation-workbench.md) |

## 与 RePoE、PoBR 的关系

三个仓库的分工和共同约定只在 [PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)里维护一份；当前跨仓缺口见[数据现状](https://github.com/ackness/pobr/blob/master/docs/data-status.md)。

## 提供哪些数据

| 数据 | 来源与产物 | 使用边界 |
| --- | --- | --- |
| 交易词条 | GGG／腾讯交易目录、分裂词缀译文复用、PoE2DB 补缺；`dictionary.json`、`pairs.json` | 主键为完整交易 ID **加英文分支** |
| 编号模板 | 交易词典的保守转换及 `curated.json`；`templates.json` | 自动转换只接受零／单数值槽，多参数由人工审核 |
| 原生描述与名称 | 固定 RePoE 客户端事实、CSD 描述和显式语言表 | 保留 stat ID、表身份、条件和分支，按精确上下文查询 |
| PoBR 运行时文件 | 名称、显示目录、选中的描述及固定历史词典 | 发布后由 PoBR 按 commit、路径与 SHA-256 导入 |
| 人工补译 | 独立工作表及审核记录 | 草稿不进入已审核输出，来源变化后需要复核 |

交易 ID、游戏 stat ID 和显示文本各有用途，不能互相代替。语言与区服分别记录：国际服的简中内容不能证明国服数值相同。交易覆盖率也不代表完整汉化或计算机制覆盖率。

历史兼容词典保留其社区来源；繁中保留独立来源。各数据域分别记录 provenance，不能把整个仓库描述为纯官方文本或完整客户端语言库。

## 本地开发

先安装 [mise](https://mise.jdx.dev/)，在本仓库根目录执行：

```sh
mise trust
mise install --locked
mise run setup
mise run check
mise run report
```

`mise.lock` 固定 Node 版本，`setup` 按 `package-lock.json` 安装依赖，并禁用依赖包的生命周期脚本。首次安装需要联网；安装后，`check` 运行测试并离线核对当前交易快照的来源摘要和可重现生成结果，`report` 读取已保存的覆盖报告。

### 常见维护操作

下列原生 npm 命令通过 `mise exec --` 执行；已激活 mise 时可直接运行。

```sh
# 联网重新采集交易目录与配置中的 PoE2DB 页面，验证后激活新快照
mise exec -- npm run refresh

# 仅采集官方交易目录；本次快照不沿用旧 PoE2DB 页面
mise exec -- npm run refresh -- --trade-only

# 编辑人工输入后，使用保存的原始响应离线重建并验证
mise exec -- npm run build
mise run check
```

| 要改的内容 | 编辑位置 |
| --- | --- |
| 已有交易 ID＋英文分支缺译 | [`translations.json`](translations.json) 的 `manual_chinese`、`manual_note`、`manual_source_url` |
| 明确覆盖既有交易译文 | [`overrides.json`](overrides.json)，附理由与来源 |
| 非交易模板、多参数模板、稀有名组成词 | [`curated.json`](curated.json) |
| 原生名称／描述补译 | [`native-translations.json`](native-translations.json)，按[工作表流程](docs/translation-workbench.md)审核 |
| 补充采集页面 | [`sources.json`](sources.json) |

交易生成器为已发布快照创建新候选，完整验证后才切换 `data/CURRENT`；失败保留旧快照。恢复中断、工作表状态、占位符和配对优先级见[详细指南](docs/trade-dictionary.md)。

## 目录与版本入口

```text
release/<patch>.json          PoBR 语言包 GitHub Release 的构建声明
data/CURRENT                  当前交易快照的目录名
data/snapshots/<id>/raw/      压缩保存的原始交易响应与页面证据
data/snapshots/<id>/generated/ 词典、模板、覆盖、缺口和冲突报告
translations.json             交易补译工作表
curated.json / overrides.json 人工模板与精确修正
native-translations.json      原生文本补译输入
reports/                      已提交的可读待办快照（原生文本待办、区服／版本差异），由 `workbench` 命令输出生成，不是输入
src/                          采集、配对、生成与验证代码
test/                         离线回归用例
docs/                         数据契约和维护指南
sources/                      语言来源台账（自 PoBR 迁入）与说明
inputs/                       release/<patch>.json 固定的源发布（只读，字节与原 tag 相同）
.cache/                       本地候选与临时文件，不提交
```

**PoBR 语言包看 GitHub Release `locale/<patch>-<n>`，交易词典快照看 `data/CURRENT`。** 两者承担不同职责。旧的 `handoff/*` 交付位于各自 tag 所指的提交，不在当前树里；已被引用的 tag 一直保留。

## 消费与发布

消费方固定发布声明中的完整 commit、文件路径、字节数与 SHA-256，验证后再读取。源码 `main` 的新提交不自动更新已发布语言数据。PoBR 在唯一的 `pipeline/data.lock.json` 中记录采用的发布与产物；产品运行时使用已打包文件。

PoBR 的显示文本、繁中名称和词条译文由本库三个[语言文件生产入口](docs/pobr-locale-producers.md)生成。固定历史简中词典的再生见[离线生成契约](docs/locale-generation.md)，已有字节的重放见[保留语言发布](docs/retained-locale-publication.md)。

### 语言包 GitHub Release

PoBR 的语言包以不可变的 GitHub Release `locale/<patch>-<n>` 发布（`release:build` → `release:publish` → PoBR `data:bump`），构建只打包 `release/<patch>.json` 固定的源字节、不重新生成。步骤、新补丁和排障见 [RELEASING.md](RELEASING.md)。

已被 PoBR 锁引用的 `handoff/*` tag 必须持续可取，不能删除或移动。

## 来源与权利

交易来源为 [GGG](https://www.pathofexile.com/api/trade2/data/stats)、[腾讯](https://poe.game.qq.com/api/trade2/data/stats)和配置中的 [PoE2DB](https://poe2db.tw/) 页面。官方交易端点没有提供客户端补丁号，交易快照因此保留 `game_patch: null`。采集范围、访问限制和失败行为见[来源与访问边界](docs/trade-dictionary.md#来源与访问边界)。

游戏文本、原始响应及网页内容的权利归各自来源方。仓库公开不为这些内容授予新的许可；本项目与 GGG、腾讯和 PoE2DB 无隶属关系。
