# add-serving-tool-face

> 2026-10-25 生产泄露事件（§15.43）的直接加固：寻数分身 v2 接待被问 corpus 外问题时
> grep /app 运行时文件作答、思考流直泄访客。persona 纪律（v4）是当前唯一闸，但 dsh
> 内建工具面（bash/文件/web/subagent）不经 mcpTools 白名单——需要平台级的结构性约束。

## Why

分身接待的工具面=完整编码 agent（bash、文件读写、web、子代理），而接待的职责只是
「读语料、直答、开事项」。工具面与职责的错配在 v2 上产出了真实泄露：内建工具绕过
mcpTools 白名单（那是 MCP 闸），persona 是唯一防线且已被证明会失守。服务契约需要一个
声明式工具面档位：接待类角色声明 `serving.toolFace: "chat"`，物化时结构性裁掉
文件/命令/web/子代理行——闸在挂载点，不是运行时判断，也不是纸面纪律。

## What Changes

- **服务契约新键**：`agents[].serving.toolFace`（可选，枚举 v1 仅 `"chat"`）。缺省
  = 现状逐字节一致（完整工具面）。
- **会话面裁剪**：`"chat"` 在物化时写 `tool-face.patch.yml`（disable 底座工具行：
  bash/pwsh/jobs/fs/fs-search/web×4/subagent×4/workflow/ralph），保留
  `tool-skill`（语料入口）、`tool-ask-user`、桥注入三件套（bot_notify/
  ask_user_question/matter 三工具经 ctx.inject 注册，不受行裁剪影响）。
- **零运行时判断**：闸在物化层（compose 门控），非 facade/接待的部署零变化。
- **范例跟进**：寻数分身 v5 接待声明 chat 面；工坊模板 v5 把 `toolFace: "chat"`
  写进接待骨架并更新硬约束清单。

## Non-Goals

- 内建工具的细粒度白名单（per-tool allowlist）——chat 面是档位不是清单编辑器。
- 访客侧呈现（thinking 流渲染策略）——fd-wanxing 车道议题。
- 非 facade 部署的任何默认变化。

## Impact

- 代码：`lib/pack-manifest.js`（校验）、`lib/agent-serving.js`（descriptor 携带）、
  `dsh-profile.js`（TOOL_FACE_DROPS+writeToolFacePatch）、`agent-runner/compose.js`
  （门控挂载）、单测、工坊与寻数两 pack 文案/骨架。
- 规格：a2a-agent-serving 增一条要求（声明式工具面档位）。
