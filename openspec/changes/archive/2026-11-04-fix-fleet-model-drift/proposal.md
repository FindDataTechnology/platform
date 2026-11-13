## Why

2026-10-27 凌晨真机实录（§15.60/61）：CEO 时辰巡逻 160/161/162 三连 `400 model_not_available: qwen3.8-flash is not available for the selected accounts`，而 member_turn_events.model 一律记 `deepseek-v4.1-flash`——dsh child 的真实请求模型被不知道是哪条车道改写成了 qwen3.8-flash（且**只在进程内存**，皮上没有证据），但 `server/agent-session.js:switchModelToInner` 的早退判据用的是我们自记的 `ctx.session.model.id`，它仍说 deepseek → 每一阵 normalizeModelForJob 都判定「已正确」、什么都不做，child 就永远困在中毒态。pod 重启（重新 spawn）才治。这是与 config-dims 上产同夜被看到的**独立真缺**。

机制三角（已实证）：
- dsh SDK jsonrpc 只回答三个方法（initialize/session/prompt/shutdown）——**不存在 model/get 或 model/set RPC**，我们无法外查 child 真选模型。
- `agents.create(agentOptions.model)` 只在**会话创建时**决定默认；jsonl 持久化的历史会话重命中时其末模型可以回写覆盖 initialize 的注入值。
- `switchModelToInner` 的早退信任自家账本（ctx.session.model）——账本可以被任何不走 `switchModelToInner` 的车道绕过时失审计与 child 真正漂移。

## What Changes

- **自愈兜底（核心）**：cron-runner 回合失败归因为上游模型不可用（400 `model_not_available` / `INVALID_MODEL` / upstream 报告模型拒绝）且 post 存在显式链时，强制一次 `switchModelTo(force)`（绕过早退）重新 spawn 后**重走链一次**；两次都败才按现口径记失败。·
- **早退收敛（放深蹄结构性信号）**：normalizeModelForJob 对**显式链岗位**不再信任 `ctx.session.model` 早退；改为每次回合**强制一份 initialize 重新 spawn**（保持原优化路径对无显式链的 cron/preset 岗位不受影响）。spawn 25ml 量级，代价可忍，换取 child 端默认模型与声明链同源。
- **可观测**：member_turn_events.detail 增 `modelMismatch` 事实列（早退判值 vs 实际 request header model，不一致才记）——日后 veracity/selector 可读，不再"假正常"。

## Capabilities

### Modified Capabilities

- `agent-fleet-core`: normalizeModelForJob 显式链岗位模型断言语义升级（详见 add-fleet-post-model 镜像修改）；memberTurnEvents detail 增 modelMismatch。
- `turn-dispatch`：回合失败归因加 model_not_available 类归因 → 触发自愈重断言。

## Impact

- `server/cron-runner.js`：normalizeModelForJob 分叉；banned drift 识别 + 重走逻辑。
- `server/agent-session.js`：switchModelTo/switchModelToInner 加 force 开关（不传不得绕过早退）。
- `server/dsh-bridge.js`：initialize 侧记录 lastRequestedModel（读路径来源，不改协议）。
- tests/e2e 同步补：已有失败三连场景固定不再复现。
- rollback：环境变量 `FLEET_MODEL_ASSERT_SOFT=1` 回到旧行为（仅判断信任 + 允许一次重试非 force）。
