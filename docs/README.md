# 文档导航

按你要做的事选择入口。命令以 `mise.toml` 为准，格式与行为以代码和回归测试为准。仓库目录、可编辑与冻结的
边界、校验方式和 PR 约定见 [AGENTS.md](../AGENTS.md)。

## 语言包（PoBR 的 `locale/<patch>-<n>` Release）

| 想做什么 | 入口 |
| --- | --- |
| 发布新补丁的语言包、换文件、补辅助宝石说明 | [RELEASING.md](../RELEASING.md) |
| 查配置、重新生成配方和回执的字段 | [语言包配置参考](release-config.md) |
| 生成 PoBR 的显示文本、繁中名称、词条译文 | [PoBR 语言文件生产者](pobr-locale-producers.md) |
| 生成或重放简中词典文件 | [简中词典生成](locale-generation.md) |
| 查语言来源的接受记录 | [语言来源台账](../sources/README.md) |

## 交易词典（`data/CURRENT`）

| 想做什么 | 入口 |
| --- | --- |
| 采集交易目录、补一条译文、修正模板 | [交易词典维护](trade-dictionary.md) |
| 在自己的工具里读取交易词条翻译 | [其他仓库如何接入](trade-dictionary.md#其他仓库如何接入) |

## 原生客户端文本

| 想做什么 | 入口 |
| --- | --- |
| 配对原件名称、技能说明等显示字段 | [原件显示目录](native-catalog.md) |
| 配对原生 stat 描述 | [原生描述接入口](native-localization.md) |
| 审核原生文本补译、区服差异 | [补译与区服工作表](translation-workbench.md) |

## 跨仓库

三个仓库（RePoE、PoBR、本仓库）的分工、Release 格式和 PoBR 的采用方式只在
[PoBR 数据架构](https://github.com/ackness/pobr/blob/master/docs/data-architecture.md)里维护；当前缺口见
[PoBR 数据现状](https://github.com/ackness/pobr/blob/master/docs/data-status.md)。
