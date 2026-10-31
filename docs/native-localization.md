# 原生客户端描述接入口

`native` 命令从固定的 `repoe-native-descriptions/v1` 包生成
`poe2-native-localization-candidate/v1`。计算 stat ID、原始描述上下文与交易 ID
分别保留。它不请求 API，不读取 `data/CURRENT` 或人工工作表，也不激活快照。
命令只向 stdout 输出候选；文件路径由调用方选择。

```sh
mkdir -p .cache/native
mise run native:candidate -- \
  --facts /path/to/repoe-description-package \
  --expected-manifest-sha256 <trusted-manifest-sha256> > .cache/native/candidate.json
mise run native:check -- \
  --facts /path/to/repoe-description-package \
  --expected-manifest-sha256 <same-trusted-manifest-sha256> \
  --candidate .cache/native/candidate.json
```

外部摘要必须来自单独核对的版本记录。现场对不可信包求摘要再立即采用，不能认证来源。
读取器先验证包的完整文件清单和三个 payload 的大小／SHA-256，再解析保留的字节。
它核对 source-lock 原字节、选定来源、game／realm／patch、资源清单、根文件、
记录范围、stat 索引、语言／handler 汇总及诊断的具体分支引用。
重复 JSON 键、非法 Unicode、越界数字、文件 symlink、缺失／循环／过深 include、
未知分支字段及不一致证据均使读取失败。文件深度按图检查，重复 include 不展开成指数工作。
最多 128 个原始文件、64 MiB 原始资源、256 MiB 包 payload、64 层 JSON。
这些是已固定事实包的完整性检查，不重新解码或认证原始客户端文件。
producer 必须是非空的文件／SHA-256 指纹表。候选检查以非阻塞方式打开文件，
再按描述符核对普通文件和大小；FIFO 不会等待写入方。不能序列化的值直接报错。

每个描述只在同一文件、同一记录内配对隐式默认语言与显式 `Simplified Chinese`。
条件、限制、按序 handler、参数编号／格式／出现次数和显式符号必须一致，允许参数重排。
ASCII `+`／`-` 和数学负号 `−` 都保留在显式符号比较中；不会将负号当作无符号。
两边匹配必须各自唯一；多分支不能按位置配对。字面数字不一致、缺少中文、重复候选、
未解释占位符、无汉字的中文声明等保留为 `excluded`。原有源诊断完整保留。
这只能建立结构一致的候选，不能证明每个译文语义都正确。

输出保留：

- `pairs`：有序 `stat_ids`、原始中英文模板、条件、限制、handler 和参数格式，
  双方的文件／记录／语言组／分支位置及原始 UTF-16 字节范围。
- `excluded`：未安全配对的来源位置、原因和相关分支；不生成猜译、默认品质或补造参数。
- `input`：精确输入 manifest 摘要、来源与上游 producer 指纹；数值补丁和服别不由语言推断。
- `consumer`：本仓库 source／依赖 manifest 指纹及 Node 版本，便于固定脚本后离线重放。

隐式默认语言保留为隐式默认。把它理解为英文是项目约定，不伪称客户端有显式
`lang "English"`。国际客户端的简中组仍是国际服文本证据，不证明国服数值、补丁或面板相同。
当前实物验证覆盖国际服候选；China 身份通道尚无真实客户端验收。

`stat_ids` 为原生 ID 列表；文件／记录／分支位置只是该精确 manifest 内的证据地址，
不能当作跨版本实体 ID。完整原始事实继续在输入 RePoE 包中保存。
完整事实包用于离线生成与追溯。产品构建时按所需 ID、语言和上下文选择交付子集，
不把整个描述档案加入浏览器运行时；子集仍须记录完整输入摘要和精确来源地址。
查询某项翻译应绑定实际描述来源与上下文，不能压成 `Map(英文, 中文)` 或无条件取第一条。
同名词条、多个 stat ID 和本地／继承描述的不同含义都可能合法共存。

该导出不应用 include 覆盖、`no_description` 抑制、formatter 或品质作用域规则，
不执行数值 handler，也不构建交易 ID 与原生 stat ID 的猜测映射。
`pairs` 不能直接并入旧 `generated/templates.json`；旧模板的匹配与参数格式契约仍须遵守。
这些候选为 PoBR 的原生显示接入提供来源，并保持现有交易表、人工修正及冲突流程可继续维护。

`native-check` 重新导出并比较完整候选字节。它要求同一输入、脚本和 Node 版本；
脚本更新后应产生新候选。该命令不修改输入包、工作表、既有候选或活动快照。
候选均声明 `production_ready: false`，发布时仍需分别完成来源、语义和消费验收，
保留 GGG 游戏文本的权利归属；本仓库不为上游内容新增许可。
