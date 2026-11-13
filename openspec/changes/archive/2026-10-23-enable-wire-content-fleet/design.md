# Design: enable-wire-content-fleet

## Context

`docs/wire-content-fleet-requirements.md` 列了 paas 侧三件事。P1 是阻断项，P2/P3 非阻断。本文定实现落点。

关键运行时事实（读代码确认）：

- 舰队成员回合有两条入口，**都收敛到 `runPersonaTurn`**：有节奏岗由 cron 触发（`cron.js fireTask` → `engine.enqueueExecution` → `ctx.runCronJobTurn`），被动岗由 delegation 唤醒（`routes/delegation.js` → `createManualTask` → 同一条 `runCronJobTurn`）。`server/cron-runner.js:620` 的 `runCronJobTurn` 按 `targetType` 分派，persona 一律走 `runPersonaTurn`。
- 现成的 `{{fleetContext}}` 注入**只覆盖有节奏岗**：`cron.js:168` 要求 `task.sourceTag?.fleetId` 且 prompt 含占位符；delegation 创建的 manual task 不带 `sourceTag`，拿不到。
- 归属解析已存在且两条路都成立：`server/fleet-reports.js` 的 `resolveAttribution({ currentPreset, runningTasks, personaMembers, rosterPresetId })` 按「cell 当前 preset → 在岗岗位」判定，`report_status`/`escalate` 就靠它。
- `PACK_LIMITS.maxAgents = 3` 与 `maxMcpRefs = 5` 都在 `lib/pack-manifest.js`（顺带：`add-fleet-template-library` 设计里「agents≤3 上限未在代码定位」一句可以销案）。

## Goals / Non-Goals

**Goals**
- 成员回合内 agent 可读到自己的 `fleetId` / 岗位 `ref` / `title` / `memberId`，cron 与 delegation 两条路都覆盖。
- 非舰队回合零行为变化。
- 柏讯能单次远程校验「岗位节奏 vs 刷新调度」的等价冲突。
- 四个满编分析套件能追加产物构建服务。

**Non-Goals**
- 不改 `{{fleetContext}}` 的既有语义（身份是额外前缀行，不是第二个占位符）。
- 不注入凭据、不把舰队/岗位身份写进 AgentCard 或公开目录（承需求边界）。
- 不做 cluster 岗的身份注入（见 Risks）。
- 不新建身份服务、不缓存、不加第二个归属判定实现。

## Decisions

### D1. 注入点选 `runPersonaTurn`，不选 promptTemplate 占位符

需求给了 R1-a（占位符）与 R1-b（per-member env）两条路。两者都不够：

- R1-a 只对有节奏岗生效 —— 内容舰队的「内容岗」是被动岗，恰恰是产物写入的主力，会漏掉。
- R1-b 需要 runner 支持 per-member env，而 dsh 子进程是单例共享的，没有 per-turn env 通道。

选第三条：在 `runPersonaTurn` 里，把身份行**前缀**进本次回合的 `job.prompt`（同时进 `chatHistory.recordMessage`，因此会话史里也留痕）。该处是 cron 与 delegation 的唯一交汇点，一处改动覆盖两条唤醒路径，且不依赖模板作者写占位符。

身份行格式（一行，便于模型复制成 `source_ref`）：

```
【舰队岗位身份】fleet=<fleetId>; post=<memberId>; title=<岗位名>; target=<targetKind>:<targetId>
```

放在 prompt 最前，后接空行与原 prompt。

### D2. 归属复用 `resolveAttribution`，按 `job.preset` 解析

`runPersonaTurn` 拿到 `job.preset`（cron 岗物化时已解析、delegation 任务直接是目标 persona）。用它与 `personaMembers` 调 `resolveAttribution`：

- `kind === "preset"` → 注入该岗位身份。
- `kind === "none" | "ambiguous"` → 不注入（普通对话 / 一 persona 占多岗的歧义场景，与 `report_status` 同款诚实拒绝）。

注入走 server 层新注入的 dep（`resolveFleetIdentity(presetId) => string | null`），`cron-runner.js` 保持 fleet 无感知 —— 与既有 `renderFleetContext` 的注入风格一致。

### D3. P2 只读契约：`GET /api/fleets/:id/cadence`

挂在既有 `server/routes/fleets.js` router 上，`requireOwnedFleet` 作用域。响应：

```json
{ "fleetId": "...", "fleetName": "...", "posts": [
  { "ref": "<memberId>", "title": "巡线岗", "cron": "0 9 * * *", "tz": "Asia/Shanghai",
    "targetRef": { "kind": "persona|cluster|a2a", "id": "..." } } ] }
```

只返回在岗（未归档舰队、未删除岗位）的岗位；无 cron 的被动岗 `cron`/`tz` 为 null（柏讯据此判定「不参与等价比较」）。**不含** KPI 槽位、报数、拍板、凭据。

### D4. P3：pack 策略上限默认 6，且可由运维配置

三个「数量」上限（`maxSkills` / `maxAgents` / `maxMcpRefs`）是**市场策略**而非结构事实，不该硬编码。`lib/pack-manifest.js` 新增 `packLimits(env)`：默认取 `PACK_LIMITS`（`maxMcpRefs` 由 5 调到 6），可用 `PACK_MAX_SKILLS` / `PACK_MAX_AGENTS` / `PACK_MAX_MCP_REFS` 覆盖。`validatePackManifest` 的默认参数改为 `packLimits()`。

三个约束：
- **逐次读取**（与 `PACK_FILES_ENABLED` 同款），运维改 env 即生效，不重启市场。
- **非法覆盖回落默认**（空、0、负数、非整数），一个笔误不能把天花板整个拆掉。
- **字符/字节上限不动** —— 那些是防滥用护栏，不是策略。

上限只在市场侧（`gateway/packs.js` → `validatePackManifest`）执行；cell 安装路径不校验这些数量，所以配置面就落在市场部署上，与 `PACK_FILES_ENABLED` / `PACK_ACCESS_MODE` 同层。

## Risks / Trade-offs

- **[cluster 岗不注入身份]** cluster 任务会把 prompt 扇出给多个成员 agent，身份行在扇出前拼一次即可，但「哪个成员」在扇出时才确定 —— 当前不做。若后续有 cluster 岗要写产物，需要把身份下推到扇出层。需求方（柏讯内容舰队）不用 cluster 岗，故不在本次范围。
- **[a2a 岗不注入]** a2a 回合走 `runA2aTurn`（远端），prompt 由本侧发出但执行在远端；且 a2a 目标允许多岗，归属本就歧义。身份对 a2a 岗无意义 —— 远端 agent 的 `source_ref` 应由调用方在 prompt 里显式传。
- **[身份行进入会话史]** 注入进 `job.prompt` 意味着会话史首条 user 消息带身份行。这是有意的（审计可读），代价是会话标题派生可能带上它 —— 注入点放在 `chatHistory.setTitle` 之前需确认标题派生取自原文还是注入文（实现时以 `recordMessage` 传注入文、`setTitle` 仍用 `job.sessionTitle` 为准，既有代码已如此）。
- **[P2 跨服务调用的身份]** 柏讯的 `wire-build-mcp` 在 cell 内运行。`AUTH_MODE=none` 下只读端点直接可读；`forward_auth` 下调用方需带身份头。本次按普通 owner 作用域路由实现，不做 loopback 豁免（不为一个只读端点开认证口子）。若柏讯侧证实必须匿名可读，再议。

## Migration Plan

无数据迁移。镜像出片后即生效；回滚按常规 tag 回退。P3 上限提高是宽松变更（既有 pack 不受影响）。

## Open Questions

- P2 端点在 `forward_auth` 部署下柏讯怎么带身份 —— 待柏讯侧确认调用上下文后再定是否需要内部凭据通道。
