# design

## D1 · 档位裁剪 = overlay disable 底座工具行

0.2.0 的主机工具面全部由 `dsh-base` 底座组合（标准组合文件只带 persona+ask）。裁剪
机制沿用既定 disable+insert 语法：`tool-face.patch.yml` 对底座工具行逐条 disable——
不插新行，纯 disable。基础设施服务行（sandbox/subprocess/ptc-runtime 等）保留：
无消费者的服务只是闲置（既有 pending 语义），裁服务行反而有依赖断裂风险。

## D2 · chat 面裁剪清单（只裁工具行，动词语义）

`tool-bash`（命令执行——/app 翻找向量）、`tool-pwsh`、`tool-jobs`（后台执行）、
`tool-fs`（read/write/edit/glob/grep——主泄露向量）、`tool-fs-search`、
`tool-web`+`web`+`web-search-deepseek`+`web-fetch-http`（外发面）、
`tool-subagent`+`tool-subagent-fork`+`tool-subagent-list-agents`+`tool-subagent-control`
（完整 agent 逃逸）、`tool-workflow`（PTC 代码执行）、`tool-ralph`。
保留：`tool-skill`（语料读取入口——接待的知识通道）、`tool-ask-user`、
`tool-todo`/goal 族（无 fs 触手）、桥注入三件套（ctx.inject 注册，不经行）。

## D3 · 校验在发布门，裁剪在物化层，两端单一来源

`serving.toolFace` 校验进 `lib/pack-manifest.js` 的 serving 块（枚举+未知键拦截）；
descriptor 携带 `tool_face`；`compose.js` 按 descriptor 门控写 patch。runner 对未知
档位 fail-loud（物化拒绝）——发布门与 runner 之间没有静默降级通道。

## D4 · 范例同径

寻数分身 v5 与工坊模板 v5 都走普通发布门；chat 面不是平台后门而是清单里的一个
声明键，任何创作者都能用。
