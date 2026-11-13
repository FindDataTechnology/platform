# Tasks — fix-dispatch-delivery

## 1. 归因驱动的 initiator（`server/routes/fleets.js`）

- [x] 1.1 `initiator` 按归因分支取：`turn.sessionId` → `task.sessionId` → `currentSessionId()`
- [x] 1.2 补 `initiatorPreset`：非聊天车道 `rosterPresetId(from.targetId)`，聊天车道 `ctx.currentPreset`
- [x] 1.3 补 `initiatorGroup`（一次派发一组），复用 `fix-fanout-aggregation` 已落的字段
- [x] 1.4 注释写清为什么不能用全局指针（它承载 UI 语义，不是一个回合的身份）

## 2. 测试（`scripts/test-fleet-orchestration.mjs`）

- [x] 2.1 定时车道：在飞回合下派发 → `initiator === handle.sessionId`、人格为派发岗 roster 预设、带分组键
- [x] 2.2 聊天车道零变化：`preset` 归因分支 → `initiator` 仍是聊天会话
- [x] 2.3 tool 岗 prompt 仍与 JSON 参数逐字节相同（本次已复核）
- [x] 2.4 **反向证明**：把 `initiator` 还原成 `chatHistory.currentSessionId()` → 2.1 红；恢复后全绿

## 3. 门禁

- [x] 3.1 `npx biome check server/routes/fleets.js scripts/test-fleet-orchestration.mjs` 绿
- [x] 3.2 `openspec validate fix-dispatch-delivery --strict` → `is valid`
- [x] 3.3 全量逐文件扫（每文件 100s 超时）：427 文件 / **3869 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 4. 上线

- [x] 4.1 出片滚版 → 已在产（快照取自远端线 7613d4e7a → GHA `sha-aeb58e6`，digest `sha256:d0beeaa9`；
      fd-infra-deploy 双 bump（`88617c3` platform + `6acafc7` facet——并发线中途改过 facet 的起点 tag，
      两次提交分别对齐同一个镜像）→ ArgoCD → 两 rollout 完成；镜像内 `test-fleet-orchestration` = 17/17 绿）
- [ ] 4.2 观察项：滚版后看一条真实定时派发的回执是否落在派发岗会话
