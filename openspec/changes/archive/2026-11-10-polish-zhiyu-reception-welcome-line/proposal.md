# polish-zhiyu-reception-welcome-line

## Why

两处接待面的小口径问题，都在访客第一眼可见的位置：

1. **欢迎行只列前 3 席**（`gateway/zhiyu/index.js:1155` 的 `.slice(0, 3)`）。演示房实有 4 个 agent 席，欢迎行说的是「你可以直接说事，或点名：@产品向导 @壹座专家 @识律专家」——**柏讯专家在席却不在欢迎行里**。官网文案本轮已改成如实四席，欢迎行成了唯一说三席的地方；访客照欢迎行点名，第 4 席永远不会被点到。
2. **主动招呼的「有没有人说话」判定读 `messagesAfter(roomId, 0, {limit:1000})`**——只读空间**最前面** 1000 行。房间一旦超过 1000 条，`findLast(guest_joined)` 落在那 1000 行内部，断流后的新访客会被判成"已经有人说过话"，主动招呼静默不发。这与我本轮修的消息分页是同一个病根：`after` 从 0 起读 ≠ 从尾部读。

## What Changes

- 欢迎行的席位列举改为**列全部在席 agent/facade**（`slice(0, 3)` 取消；若席位过多按 5 个截断并在末尾加「等」），使"点名"提示与在席名单一致。
- 主动招呼的判据改读**尾部窗口**（`messagesTail`，取最近一批行），以「该访客 joined 之后有没有人说过话」为准；长房不再误判。
- 两处都不改对外契约：欢迎行仍是 `kind=system` 且 `meta.event=guest_greeting`；主动招呼仍是每房 opt-in、20 秒延迟、有人说话即放弃。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——`skip_specs: true`。欢迎行的具体文案与判定实现都不在 spec 的 requirement 里：spec 只要求"访客进房有欢迎/席位可点名"，这两处是实现没有对齐自身意图，不是需求变更。）

## Impact

- 代码：`gateway/zhiyu/index.js` 两处（欢迎行 `agents` 构造、主动招呼的 `messagesAfter` → `messagesTail`）。
- 测试：`scripts/test-zhiyu-widget.mjs` 或 `test-zhiyu-rooms.mjs` 补一条「欢迎行列出全部在席席位数」；主动招呼的长房判定改由单测覆盖（构造 >200 行尾部窗口，断言仍判为"无人说话"）。
- 不改 schema、不改 API、不动计费与回合协议。
- 生产侧：演示房 `proactive_greeting` 已由本轮授权开启（2026-11-10 04:57，实测 20 秒内值班席真开口）；本单只改代码，让该行为在长房里也成立。
