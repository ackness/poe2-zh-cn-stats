# 简中词典生成（`locale-producer`）

`src/pobr/locale-producer.mjs` 把一份固定的社区词典和本仓库的模板包投影成 PoBR 的简中词典文件
（`i18n/zh-CN/` 下的 `base_items`、`classes`、`mods`、`passive_names`、`rare_words`、`skills`、
`stat_lines`、`words` 和 `_meta.json`）。它只做离线投影：不联网、不修改交易快照或任何已发布目录，
也不决定来源是否被接受。依赖只有 `src/pobr/legacy-translation-merge.mjs`、`src/strict-json.mjs` 和
Node 内置模块。

## 示例（0.5.5.5）：固定生成

以下是 0.5.5.5 的具体做法，其他补丁的清单与计数不同。

`release/regenerate/0.5.5.5.json` 的 `zh-cn-dictionary` 任务固定了 0.5.5.5 用的生成清单
（`9aba3687` 的 `handoff/locale-generation-shaman-mantle-20261103/input-manifest.json`），CI 每次都用它重新
生成这 9 个文件并与 `inputs/locale-0.5.5.5/` 逐字节比较。要在本地看到具体输入：

```sh
mise run release:regenerate -- --fetch --keep-work
```

`--keep-work` 保留 `.cache/regenerate/<target>/work/zh-cn-dictionary/`：其中有清单、按清单取到的全部输入和
生成结果。

## 直接运行

```sh
mise exec -- node src/pobr/locale-producer.mjs \
  --manifest <input-manifest.json> --manifest-sha256 <清单的 SHA-256> \
  --input-dir <输入目录> --out <新的输出目录>
```

四个参数都必填；输出目录不能已存在，父目录必须存在。

清单 `poe2-locale-generation-input/v1` 写 `profile`、`target`、`identity`（社区词典与模板包的仓库和提交）、
`inputs`，可选 `expected_files`。`inputs` 的键是**输入目录下**的路径，不是相对清单的路径；每项带 `bytes`、
`sha256` 和 `source`：

- `source.url`：从该 URL 下载（URL 里含完整提交，不查 HEAD）；
- `source.repository` + `source.path`，`source.revision` 为 `producer-commit`：取自另行固定的生产提交。

调用方自行把每个输入放到输入目录并核对字节数和 SHA-256。生产者再核对清单、完整输入清单、每个输入的 pin、
来源身份、投影和分层，以及 `expected_files`（有的话），全部通过才写输出；写入失败会删掉新建的输出目录。

两种 `profile`：

- `legacy`：只需 `dictionary/<file>`（十个词典文件）和 `templates.json`，按传入的词典和模板身份写新的
  `_meta.json`。这是对另一份固定来源可复用的生成方式，不代表结果已被任何补丁接受。
- `retained-selected`：另需四个固定证据输入。它用另行固定的旧元数据核对生成的计数和身份，核对 140 条原生
  配对增量的输入与中间 pin，再叠加选中的字面译文层并核对最终 pin。原元数据和原有的三个选取块原样保留，
  不重标为当前生成。示例（0.5.5.5）：0.5.5.5 的清单用这个 profile：27896 条历史配对、140 条原生配对和 6 条选中字面译文
  （两条原有的，加四条来自 `curation/curated.json` 的 Shaman Mantle 别名），共 28042 条。

输出的 9 个 `i18n/zh-CN/*.json` 和 `generated/translation-audit.json` 的 pin 写在 `receipt.json` 的 `files`；
回执还记录 schema、`target`、`profile`、清单摘要、输入 pin、来源身份和各层条数，不含主机路径和时间。

`projectLegacy`、`layerSelectedPairs`、`produceLocale` 也作为函数导出。按实际 CSD 分支选取新的原生译文
是另一个入口（`pobr:stat-lines`，见 [PoBR 语言文件生产者](pobr-locale-producers.md#词条译文stat_linesjson)）；
把旧的选取收据喂回这个固定 profile 只是组合，不是重新选取。繁中文件和 `display_texts.json` 不由这里生成。

生成的文件要进入语言包，按 [RELEASING.md](../RELEASING.md#新补丁) 放进新的源目录并发布。
