# 0.5.5.8 语言源目录

目标为 `poe2 / 0.5.5.8 / international`。本目录承接正式 `locale/0.5.5.5-4` 的全部 14 个语言成员，英文由固定的游戏包提供。

游戏包固定为 `game/0.5.5.8-1`，SHA-256 `7dcb18ec41dff4deadfb3d9c9acfd128122c748ad1309d75bc301ccfecf0574a`。简中旧七个显示 scope 与繁中旧三个 scope 完整保留。简中通过既有固定 native catalog 的原始 ID、英文与简中记录加入 `ItemClasses.Name`；繁中通过官方英繁表加入同一 scope。两者都先读取真实目标 game 成员，再按唯一 ID 与当前英文逐字节匹配。

简中国服官方词条和三类显示表继续使用 `inputs/0.5.5.5-1`；繁中旧三类显示表继续使用 `inputs/0.5.5.5-2`。官方来源身份保留原补丁与 realm，显示输出以 `carried_from` 标记跨补丁沿用。旧 catalog 的逐 ID 行由使用方继续比较当前英文；不存在把来源版本改成目标版本的操作。未知来源国服材料没有加入，国际服文本不证明国服数值相同。

`evidence/upgrade-0.5.5.8.json` 记录本批真实输入、成员变化、逐 scope 采用与缺译计数，以及生产者回执 pins；其余 evidence 是原样保留的历史记录，身份不改成 0.5.5.8。繁中原有三条 frozen 记录不增加。配置与重新生成配方见 `release/0.5.5.8-1.json`、`release/regenerate/0.5.5.8-1.json`。

简中 ItemClasses 修正见 `evidence/cn-itemclasses-0.5.5.8.json`：118 条原 catalog 记录中，93 条目标 ID/英文一致并有原始译文；25 条空英文非目标记录全部排除，不发布空占位。既有 `evidence/upgrade-0.5.5.8.json` 保留初次候选的真实执行记录；旧提交与交接实物不改写。
