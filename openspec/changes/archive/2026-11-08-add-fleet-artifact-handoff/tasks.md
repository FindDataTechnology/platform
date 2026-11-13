# Tasks — add-fleet-artifact-handoff

## 1. 资源库读取口（`resources.js`）

- [x] 1.1 `artifactsForSession({sessionId, sinceMs, limit})`：按会话 + 时间窗，最近优先，上限 8（1..32）
- [x] 1.2 库未就绪 / 表缺失 / 读失败 → `[]`（降级放行，绝不抛）
- [x] 1.3 走公开的原始句柄访问器（`db.getDb()`），不碰私有字段

## 2. 跨边下发（`server/fleet-handoffs.js`）

- [x] 2.1 `upstreamArtifactSection(...)`：生成「上游产物」段（库标识 + workspace 相对路径 + 不要重新生成）
- [x] 2.2 `igniteFleetEdges` 改 async（两个调用方本就 `await`）
- [x] 2.3 段插入位置：散文之后、`{{fleetEdgeContext}}` 之前
- [x] 2.4 接棒与扇出两处 persona prompt 都带；a2a / tool 不带
- [x] 2.5 无产物 / 读失败 → 整段缺席，其余逐字节不变

## 3. 测试（`scripts/test-fleet-artifact-handoff.mjs`，5 条）

- [x] 3.1 读取口：只取本会话、最近优先、窗口裁剪、空会话返回空
- [x] 3.2 接棒：persona 下游拿到段（含标题/workspace/库标识/「不要重新生成」），且散文在前、
      上下文占位符仍在末尾
- [x] 3.3 a2a 下游：不含产物段
- [x] 3.4 无产物：prompt 无段、散文零变化
- [x] 3.5 扇出：每个 persona 目标都带同一份段
- [x] 3.6 **反向证明**：`artifactSection` 置空 → 3.2/3.5 红；恢复后 5/5

## 4. 门禁

- [x] 4.1 `npx biome check resources.js server/fleet-handoffs.js scripts/test-fleet-artifact-handoff.mjs` 绿
- [x] 4.2 `openspec validate add-fleet-artifact-handoff --strict` → `is valid`
- [x] 4.3 全量逐文件扫（每文件 100s 超时，隔离克隆内）：449 文件 / **4003 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照取自远端线 7e7d877cd → GHA `sha-c4b5573`，digest `sha256:2e216994`，
      relay 105s 到位；fd-infra-deploy `58ab090` 双 bump → ArgoCD 75s → 两 rollout 完成；
      镜像内 5/5 绿；源码面 `upstreamArtifactSection`×2、`artifactsForSession`×1 均在）
- [ ] 5.2 观察项：滚版后看一次真实接棒，确认下游是"取用"而不是"重做"上游那份文件

## 6. 挂账（不在本变更）

- 6.1 a2a 目标的产物传递需要跨服务契约（本变更只做 persona）
- 6.2 产物段上限 8 条为常量，未做成舰队级可配
- 6.3 只按"本轮窗口内的资源库条目"判定产物；若某工具产出的文件未被自动捕获，这里也看不到
