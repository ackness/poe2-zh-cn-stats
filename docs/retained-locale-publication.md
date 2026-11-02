# 固定旧语言资产的交付契约

`handoff/locale-retained-20261101` 由翻译库独立维护，固定承接 PoBR
`0.5.5.5/international` 已接受的过渡语言字节。它不是客户端版本证明，
也不把旧词典重标为新补丁。`manifest.json` 固定每个文件的字节数和
SHA-256；`evidence/locale-decision.json` 保存逐项来源、接受范围和未解决事项，
同时保留原简中元数据、原 stat pairs、140 条增量证据及繁中 consumer receipt。
简中元数据原样保留了旧生成命令和三个后续选取收据。繁中有独立来源，
不可用作简中证据。原始 stat pairs 27896 条，固定投影 28038 条，保留全部原对及
140+2 新对；实际投影字节和顺序原样导出，不能重新排序或去重。

此包的 SC display 是已有的紧凑投影，目录包含三个 ID scope 和 literal
冲突阻断；它引用 catalog SHA-256，而不是原生客户端事实或完整语言库。
`observed_sc_client` 的补丁和 realm 均未知。审核补译包固定在翻译库
`5d019466678522e1ff3535b27951ad8056498ff8` 的
`handoff/reviewed-supplements-20261101/runtime.zip`，1585 字节，SHA-256
`989293a62f212f56c2f8e2b26aec6439709d55600f5cb8360d6c9ab5ccc968a8`；
其中实际审核记录为 0，不包含两个未批准的 Freezing Pulse 草稿。

消费方必须独立固定本目录所属的翻译库 Git commit 及 manifest SHA-256，
在临时目录离线导出；例如：

```sh
node src/retained-locale-export.mjs \
  --publication handoff/locale-retained-20261101 \
  --manifest-sha256 f90362c7bca642267ce9906c2a060336a8d2c472c73053707909d497eb22a551 \
  --game poe2 --patch 0.5.5.5 --realm international --locale zh-CN \
  --catalog /temporary/catalog.json --reviewed-supplement /temporary/runtime.zip \
  --out /temporary/new-locale-output
```

繁中使用 `--locale zh-TW`，不需要 SC catalog 和审核包。输出目录必须尚不存在；
结果为 `i18n/<locale>/...`，可临时接入构建，不能作为 PoBR Git 或自有 artifact
ref 的完整词典副本。导出器校验整个清单、显式目标、locale、SC catalog 和
审核包字节以及 display 的内嵌身份，不访问网络。验证失败不会留下部分输出。

这只是固定已接受投影的重放，不替代现有 v3 catalog、原始大 verification sidecar、
RePoE binding 与 reviewed workbench 的构建时校验；生成新投影时仍必须运行原有完整
guard。sidecar 属于构建校验输入，不能塞进运行时显示投影。导出不改变 PoBR 的锁、
CURRENT、来源接受决定或发布状态。当前固定消费接线及 PoBR 完整语言副本迁出已完成（PoBR PR218／219）；
后续语言产物变化仍需更新精确消费锁并验证，不能把重放成功当作新的接受或采用。

实际旧词典投影及固定选取层的独立生成契约见 [locale-generation.md](locale-generation.md)；本导出器仍只重放固定字节。
