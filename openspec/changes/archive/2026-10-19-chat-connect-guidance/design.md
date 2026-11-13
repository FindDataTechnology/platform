# chat-connect-guidance — 设计

## D1 分类放服务端，客户端只渲染

错误文本形态随上游变（dsh 的 LLM failure message、各 MCP server 的 401 文案），
分类规则跟凭据知识（ref→panel 映射）都住在服务端——`server/connect-guidance.js`
单点持有。客户端拿到的已经是结论 `{panel}`，渲染零逻辑。

## D2 两类入口，两条判据

- **模型车道**（turn 错误）：`TURN_CREDENTIAL_RE = /\b40[13]\b|unauthoriz|invalid[ _-]?api[ _-]?key|incorrect api key|api key (?:is )?invalid|credential/i`。
  命中即 `{panel:"ciyuan-account"}`——L2a 后词元账号是模型凭据的用户侧修复入口；
  部署种子 key 失效也指这张卡（绑定自己的账号即可继续），语义诚实。
- **MCP 工具**（tool 失败）：`mcp__<server>__<tool>` 前缀 → 复用
  `markCredentialStaleOn401` 的 server-config 解析（DB 记录或 mcp.json 基线）→
  `credential-refs.refFor(config)` → `KNOWN_CONNECT_PANELS.get(refName)`。
  解析不出（无凭据 ref 的 server、非 401 类失败）→ 不附 `connect`。

与既有 `UNAUTHORIZED_RE` 的关系：stale 标记判据（401/unauthorized）保持不动，
引导判据更宽（含 invalid api key 等非 401 形态）——两者目的不同，不强行合并。

## D3 同步解析的模块边界

`connect-guidance.js` 静态 import `extension-store` / `credential-refs`；
`dsh-events` 原有的动态 import 解析逻辑抽到 connect-guidance 里供两处共用
（stale 检测继续用自己的异步链路，只共享「toolName → server 配置」这一步）。
若 import 造成环，退回动态 import + 附着点同步可用的降级：tool_end 先不带
connect、只在下一事件补——**不为此引入环**。

## D4 旁挂不改文本、不进持久化

- `error` / `tool_end` WS 事件增加可选 `connect` 字段；模型 transcript（tool result
  文本、持久化 blocks）一字不动——UNKNOWN_TOOL 候选、subagent Diagnostic 那两处
  改文本是有意让模型读，本刀相反：凭据问题只有人能解决。
- 历史消息（`chat-history` 回放）不带 `connect`，回放无按钮——引导是「此刻怎么办」，
  不是历史注解。

## D5 客户端

- `Block` error 变体：`connect?: { panel: string }`；tool 变体同。
- `chat-store`：`case "error"` 与 `tool_end` 各透传一字段。
- `AssistantTurn`：错误块、失败工具块底部渲染 `data-testid="turn-connect-cta"` 按钮
  （图标 + 「去连接」），`navigate` 到 `/settings/connections?panel=<panel>`；
  无 `connect` 字段不渲染。i18n 五语言补 `turn.connectAction`。
