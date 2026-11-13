# Tasks — fix-decision-delivery-context

## 1. 判据（`cron.js`）

- [x] 1.1 `hasFleetContextRenderer()`：渲染器是否挂载（非函数视为未挂载）
- [x] 1.2 `keepFleetContextPlaceholder(prompt)`：带占位符 **且** 渲染器在位
- [x] 1.3 两者从模块导出，供路由与后续车道复用同一判断

## 2. 送达拼装（`server/routes/fleets.js`）

- [x] 2.1 模板路径改调 `cron.keepFleetContextPlaceholder(task.prompt)`：
      保留占位符时只追加一句执行指令（**不再拼 digest**，避免与注入段重复）
- [x] 2.2 不保留时维持旧行为（`buildExecuteNowPrompt`：指令 + 裁定正文）
- [x] 2.3 手动送达车道（persona）prompt 追加 `{{fleetContext}}`；a2a/tool 不动
- [x] 2.4 送达标记路径不改（`addOnFinished → markDelivered` 与 prompt 形态无关）

## 3. 测试（`scripts/test-decision-delivery-context.mjs`，4 条）

- [x] 3.1 访问器：挂载/未挂载/非函数
- [x] 3.2 判据：有渲染器 + 有占位符 → 保留；无占位符/null/undefined → 不保留
- [x] 3.3 判据：无渲染器 → 不保留（否则占位符成字面量，裁定丢失）
- [x] 3.4 **反向证明**：把判据改成恒 false（= 旧行为）→ 3.2 红；恢复后 4/4
- [x] 3.5 相邻套件：decision-lane 10、report-lane 44、core 22、orchestration 18 全绿

## 4. 门禁

- [x] 4.1 `npx biome check cron.js server/routes/fleets.js scripts/test-decision-delivery-context.mjs` 绿
- [x] 4.2 `openspec validate fix-decision-delivery-context --strict` → `is valid`
- [x] 4.3 全量逐文件扫（每文件 100s 超时，隔离克隆内）：451 文件 / **4015 条全绿、零红**；
      仅 2 个既知超时（`lib/test-sleeper.mjs` 设计上长跑、`test-bots.mjs` 既有悬挂）

## 5. 上线

- [x] 5.1 出片滚版 → 已在产（快照取自远端线 50245ed02 → GHA `sha-c721105`，digest `sha256:b0b76953`，
      relay 120s；fd-infra-deploy `60b8f48` 双 bump → ArgoCD 75s → 两 rollout 完成；
      镜像内 `keepFleetContextPlaceholder` cron.js×2 / fleets.js×1、套件 4/4 绿）
      ⚠️ 过程事故：先滚了并发线的 `sha-d145aaf`，其快照基线早于本提交 → 镜像内 grep 为 0。
      教训已落：**出片/滚版前必须验「这棵树/这片镜像含不含该提交」**（本次改为对快照树 grep + 核基线 sha），
      不能只核「提交在分支上」
- [ ] 5.2 观察项：滚版后点一次「立即执行」，确认该回合 prompt 含巡视上下文且裁定只出现一次

## 6. 挂账（不在本变更）

- 6.1 两条送达车道文案仍不完全同形（模板路径一句指令 / 手动路径 `buildExecuteNowPrompt`）——
  语义等价但措辞不同，若要统一需一次文案对齐
