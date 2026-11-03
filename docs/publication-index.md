# 完整语言 owner 发布索引

本库维护 `poe2/international` 的有序声明通道。发现入口是
`publication/index.json`；消费者先将入口所在 Git revision 冻结为 full40，再按
`head` 的 revision/path/bytes/SHA-256 读取 descriptor。源码 HEAD、分支时间和 patch
字符串都不是数据包排序规则。同 patch 新语言、reviewed 输入或工具也必须发布新序号。

## 产物身份与保活

产物只由完整 commit `revision`、`path` 与 bytes/SHA-256 定位；消费者按 revision 取该提交里的文件，
不按分支名选数据。未并入 `main` 的产物提交由同名 tag `refs/tags/handoff/<name>` 保持可取，
本库只保留 `main` 一个分支（原 `handoff/*` 分支已于 2026-11-02 换成同名 tag，revision 不变）。
发布新产物时推送 tag：`git push origin <revision>:refs/tags/handoff/<name>`，再用
`git fetch --depth=1 origin <revision>` 从远端核对。已被 descriptor、证据或下游锁引用的 `handoff/*` tag
不得删除或移动。

## v2 契约

索引恰有 `schema: owned-data-publication-index/v2`、
`channel: {game: poe2, realm: international}`、正整数 `sequence` 和
`head: {revision, path, bytes, sha256}`。revision 是小写 full40 commit，bytes 是精确安全整数，
sha256 是小写 hex64。descriptor 路径为
`publication/releases/poe2-international/<sequence>.json`。pin 固定文件原字节，包含换行；
不重新序列化后代替原 pin。索引自身不自引用。

descriptor 恰有以下字段：

| 字段 | 含义 |
| --- | --- |
| `schema` | `owned-data-publication/v2` |
| `owner` | `ackness/poe2-zh-cn-stats` |
| `target` | `{game, game_patch, realm}`；bootstrap 为 `poe2/0.5.5.5/international` |
| `sequence` | 通道正整数序号，bootstrap 为 1，后续必须恰好 +1 |
| `previous` | bootstrap 为 null；后续为前 descriptor 精确 `{revision,path,bytes,sha256}` |
| `scope` | `{complete: "declared-dependency-closure-only", freshness_certified: false, official_client_certified: false, translation_quality_certified: false}` |
| `components` | 下列七角色，每项恰为 `{sequence, input}` |
| `bindings.display_source` | 原 `data-imports.lock.json.packages.repoe` 完整声明，原样保留；来源 owner 仍是 `ackness/repoe` |
| `evidence.catalog_validation` | catalog 所在 commit、同目录原 `validation.json` 的精确 Git pin |

`complete` 仅指这些声明的依赖闭包完整。原 catalog、审核包的 `candidate`、
`production_ready: false`、观察 patch/realm 的 null、权利及来源声明继续保留。
不认证客户端、官方来源资格、翻译质量或上游新鲜度；不将目标身份填进观察身份。
繁中保持独立 retained 来源，不声称由简中生成。

bootstrap 对应 sequence 1 的三个历史消费锁，完整复制以下 JSON 子对象，不改嵌套 key、bytes 或 SHA：

| 角色 | `input` 原声明 |
| --- | --- |
| `language` | `build-data.lock.json.packages.language` |
| `display_catalog` | `data-imports.lock.json.packages.translation` |
| `display_library` | `data-imports.lock.json.library`（六模块闭包） |
| `reviewed_supplement` | `data-imports.lock.json.packages.supplement` |
| `workbench` | `data-imports.lock.json.workbench`（已发布的查询/导出模块，不是 203 MB 工作表） |
| `support_display` | `build-data.lock.json.support_display`，不能因旧锁 optional 而省略 |
| `locale_generation` | `locale-generation.lock.json` 整份文档，含 schema、target、三模块 producer 和 input manifest |

bootstrap 的所有角色 sequence 均为 1。后续将完整 `input` 作结构比较（JSON key 顺序不影响比较），
未变角色保留序号，变化角色恰好 +1。全局新发布须至少有角色 input、完整绑定或验证证据改变；
仅绑定或证据更新时，未变角色的序号保持不变。三者均未变化的空推进拒绝。
同序号不同 descriptor pin、回退、跳序、缺前驱或错误前驱均拒绝。
已登记的同一精确 head 再登记为 `unchanged`，不重写索引。
新 patch 仍沿相同 game/realm 通道递增，各角色实际 metadata 必须与新 target 相符。

## API 与命令

`src/publication-index.mjs` 只依赖 Node 标准库与现有 `strict-json.mjs`，不联网、不执行 producer。
导出：

- `bootstrapPublication({repo, buildLock, importsLock, localeGenerationLock})`：三个锁均为原始 Buffer；
  校验后返回 descriptor 对象，不写索引。
- `validateDescriptor(bytes)`、`validateIndex(bytes)`：严格解析原字节并检查结构，返回解析对象。
- `checkPublication({repo, indexPath = 'publication/index.json'})`：只读验证索引、descriptor 及全部前驱与声明，返回 `{index, descriptor}`。
- `registerPublication({repo, head, indexPath = 'publication/index.json'})`：head 必须指向已经存在的
  Git commit，全部检查成功后原子替换小索引；返回 `{changed, index, descriptor}`。
- `bytePin(bytes)`、`OWNER`、`ROLES`、`SCOPE`：计算精确 bytes/SHA 及读取固定契约常量。

CLI 不接受未知/重复选项。下面是历史 bootstrap 的重放接口：三份锁须从
[固定 PoBR 版本](https://github.com/ackness/pobr/tree/0fb6f913cc3fac980f9d84e855b26103860d6b96/pipeline)
分别取 `runtime/build-data.lock.json`、`imports/data-imports.lock.json` 和
`imports/locale-generation.lock.json`，导出到调用方显式指定的证据目录。
PoBR 当前只使用 `pipeline/data.lock.json`，本 bootstrap 不读取该格式；不要将当前数据锁改名冒充旧锁，
也不要用此重放接口代替新的 owner 生产与发布。

```sh
node src/publication-index.mjs bootstrap \
  --build-lock /path/to/bootstrap-evidence/build-data.lock.json \
  --imports-lock /path/to/bootstrap-evidence/data-imports.lock.json \
  --locale-generation-lock /path/to/bootstrap-evidence/locale-generation.lock.json \
  --out publication/releases/poe2-international/1.json
```

输出路径的父目录须已存在，descriptor 不能覆盖。先本地提交 descriptor 与代码，再用该真实 commit
及 descriptor 原 bytes/SHA 登记，最后另一次本地提交索引，避免 descriptor/index 自引用：

```sh
node src/publication-index.mjs register \
  --revision <descriptor-full40-commit> \
  --path publication/releases/poe2-international/1.json \
  --bytes <actual-integer> --sha256 <actual-hex64>
mise run publication:check
mise run publication:test
```

后续发布 descriptor 由 owner 在完成生产、完整 guard、发布且确认全部不可变产物可用后编写。
`register` 没有生成数据或将草稿改 reviewed 的功能。此处 `published` 仅接受原声明；没有该字段的
历史 imports 声明以已存在的固定 Git 包和原完成证据登记，不往原 input 添加字段。

## 检查范围及失败行为

登记会验证自己的固定 Git commit/blob 可读且为普通文件，catalog/reviewed ZIP 的原 bytes/SHA、
成员清单和 expanded_bytes、小 manifest/request/审核运行 JSON 的原 bytes/SHA；
catalog 与 RePoE source manifest、language 与 catalog/审核包、六模块 library/七模块审核 producer、
workbench 指纹、support 原 metadata/asset 声明及 locale-generation 三模块/完整 15 输入与 10 输出声明
必须相符。原 0 条真实审核继续为 0，未批准草稿不生效。

为复用已完成的大 guard，catalog 的原 `windows-fk-validation/v1` 小收据必须与 manifest、文件 pins、
独立 FK 完成标记和原 boundaries 相符。该收据是既有证据，不冒充本次重跑。
每份 metadata 最大 1 MiB，压缩包最大 64 MiB；只解压小 metadata，不解压 catalog 或
335 MB verification，不读取 203 MB 工作表，不执行已有完整 guard。
retained 大词典/繁中证据与 support payload 仅核 Git 清单、普通文件及声明大小，不重新读取/哈希内容；
locale-generation 的四份小 evidence 则核 bytes/SHA。完整内容验证仍由现有 exporter/producer/PoBR guard
承担，索引校验不能代替它们。原始词典仅由固定 source URL/producer commit 定位，未复制到源码。
RePoE ZIP 的完整原声明保留以供跨 owner 比较；这里校验 catalog request 绑定的 source manifest SHA，
不获取或认证另一 owner 的 ZIP。PoBR resolver 仍须与 RePoE publication 的完整 source 声明精确比较。

重复 JSON key（包括转义别名）、无效 Unicode/数值、缺/多角色、坏 pin/fullrev/path、缺文件、
文件或任一祖先 symlink、不可用 Git 对象、未发布包、错误 target/source/library/review 绑定均失败。
前驱链最多 1024 项，超限显式失败。读缺失对象不自动 fetch。

`register` 用排他 `.lock` 防同进程间并发，核当前索引、完整候选及前驱后在同目录写临时文件，
fsync 文件，再核原索引未变并 rename；失败不写成功索引，旧索引保持原字节。
正常失败只移除本次临时文件/锁。进程崩溃留下的锁会阻止下一次登记，须人工核实后恢复，
不会自行清理或猜测可覆盖。失败日志/测试 fixture 可保留在 `.cache`。

本地登记不表示 artifact refs 已 push 或经 fresh fetch，也不执行远端发布。root 后续负责跨库消费、
真实远端发布、PR/CI 和采用。本次 bootstrap 只登记当前已发布原 pins/既有证据；
真实上游发现、冻结新源、生成、完整验证和发布是后续阶段。反复 check/index 登记不能证明永远自动同步。
