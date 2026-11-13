## 1. 归因：读该回合的执行上下文，不读运行时默认

- [x] 1.1 `resolveAttribution`（`server/fleet-reports.js`）新增**在飞回合**分支：
  以运行账本 `openTurns()` 的 `{fleetId, memberId}` 为准，唯一命中才采纳。完成判据=
  parked 回合（部署默认为别的 persona）仍归属本岗位。
- [x] 1.2 运行中任务分支放宽：由「仅 `targetType==="cluster"`」放宽到「带 `sourceTag.fleetId`
  的运行中任务」，`kind` 区分 `cluster-task` / `job-sourceTag`。完成判据=既有 cluster
  场景字节不变 + persona 回合命中 `job-sourceTag`。
- [x] 1.3 唯一性收敛：在飞回合/运行中任务多命中时**不猜**，退回下一级；最终 `none`/
  `ambiguous` 诚实拒收。完成判据=多岗位共用 persona 仍拒收。
- [x] 1.4 六处归因调用点（`server/routes/fleets.js` 的 `/report` `/dispatch` `/escalate`
  `/deputy/queue` `/deputy/resolve` `/deputy/escalate-to-owner`）补传 `openTurns()`。
  完成判据=六处全部传参（grep 计数 6）。
- [x] 1.5 真机判据：驻留回合的 persona 岗位 `report_status` 正常受理（不再 409
  「not a member of any fleet」）。**实测 2026-10-31 10:20–10:24Z**：ob-scout /
  user-preset-2 / if-sentinel 三个 parked 岗位的回合 `status=ok` 且各自落 `source='self'`
  报数（cell1 10Z 档 4 条、cell2 1 条）。

## 2. 事实列

- [x] 2.1 `server.js` 加一次性事实桥 `recordFleetAttribution` / `takeFleetAttribution`
  （与既有 `takeFleetModelNotices` 同款纪律）。
- [x] 2.2 报数受理处按 `memberId` stash `{source, fleetId, memberId}`。
- [x] 2.3 回合收尾（`ctx.recordFleetTurnEvent`）取用并合入
  `member_turn_events.detail.attribution`；无 stash 的回合 detail 逐字节不变。
- [x] 2.4 完成判据：出片后真机回合台账可读 `detail.attribution`。**实测**：cell1 3 行 /
  cell2 1 行，形如 `{"source":"turn","fleetId":"fleet_…","memberId":"m_…"}`（含
  `carrierFallback` 的失败/回落行同样带 attribution）。

## 3. 工具面：按 preset 分段供给

- [x] 3.1 cell 侧 `writeMcpPatch` 补 `packPersonaToolFaces()`：每个已装 pack 的 persona
  一节，内容 = `effectiveMcpTools` 既有派生。完成判据=单测断言「某 persona 的段只含自己的
  server」。
- [x] 3.2 形状纪律：`byPreset` 非空才用 `{mcpTools, byPreset}` 包装形状，为空保持裸 map
  逐字节不变。完成判据=既有「flag off 逐字节等价」用例仍绿（真机自测曾写出
  `{"mcpTools":{"mcpTools":null}}`，此纪律即其来由）。
- [x] 3.3 `applyMcpToolRestrict(agentCtx, presetId)` 在 cell 侧能取到 `byPreset[presetId]`
  段（reader 未改，靠 own `byPreset` 键区分）。完成判据=reader 用例全绿。
- [x] 3.4 聊天车道零回归：既有 chat 车道用例全绿。
- [x] 3.5 真机判据：驻留岗位会话内可按工具检索命中自己声明的工具。**实测**：cell1
  `tool-filter.json` 顶层 `mcpTools + byPreset` 双键、byPreset 27 段，`ob-scout` 段含
  `wire_datasets_list` 等 10 工具；同轮自报原文「wire_datasets_list 取靶 cell 全 6 数据集」。

## 4. 测试

- [x] 4.1 `scripts/test-fleet-report-lane.mjs` 补三例：在飞回合胜出（parked）、多回合不猜、
  chat 车道不变。完成判据=41/41 绿。
- [x] 4.2 `scripts/test-full-mode-tool-scope-integration.mjs` 补四例：每 persona 自己的段、
  未声明回落 pack 级、无 MCP 引用不给段、卸载随删。完成判据=10/10 绿。
- [x] 4.3 相邻套件回归：`test-fleet-turn-attribution` / `test-tool-scope-bridge` /
  `test-tool-scope-register-seam` / `test-focus-overlay` 全绿（合计 87/87）。
- [x] 4.4 `openspec validate fix-parked-preset-attribution --strict` 绿；
  `validate --specs` 225/0。

## 5. 出片与验收

- [x] 5.1 出片（走 `fd-build-channel` 判路，公开仓免费线）。快照 `d452833`（源 `6253d08e`）→
  镜像 `yizuo/platform:sha-d452833` 2.47GB，五道烟测全绿。**未 bump**：另一车道 10:06Z 已把
  `sha-a3f603c`（源 `c8faf5ff` ⊇ `f83c6098`）滚上产，本修随它在产；两车道互不为超集
  （`f6edb5ba` 缺 `c8faf5ff`）→ 谁 bump 谁回退对方，故零 bump。
- [x] 5.2 **硬判据**：复算「首个 parked 事件之后 `member_reports`（`source='self'`）不再
  归零」。**实测两 cell**：cell1 出前（06:10Z 后）0 条 → 修复上产后 10Z 档 4 条
  （10:20/10:21/10:23/10:24）；cell2 10Z 档 1 条（10:23）。归零回归消除。
- [x] 5.3 本体建设舰队首轮重跑：盘账岗命中 `wire_datasets_list` 并产出报数。**实测**：
  `m_1793422472811_5fptz1`（ob-scout）回合 ok（10:20Z）→ 自报（10:21Z）原文记「wire_datasets_list
  取靶 cell 全 6 数据集」；`member_reports` 该岗位行已存在。
- [x] 5.4 台账 `docs/registry-maintenance.md` §15.119 记实录（时间线/根因/两缺陷/判据数据），
  并把「parked 不动默认 preset」的 grep 复核补上 `server/routes/`（原 tasks 5.1 漏项，
  记为复核纪律缺口：grep 复核必须覆盖 `server/routes/`）。

## 6. 挂账（不在本 change）

- [ ] 6.1 **server 级集合差异**：`mcp.patch.yml` 按部署默认 persona 组合时被丢掉的 server
  （如 `wire-ops-mcp`）对任何 persona 都不在——per-preset 段只管 allowlist，管不到 server
  供给。独立立项。
- [ ] 6.2 **`registryName` 语义分叉**：「注册表服务名」vs「部署别名」两条清单须在 pack
  校验层分开校验（现只校字符形状不校存在性）。挂给柏讯侧需求书 B 段。
- [ ] 6.3 柏讯侧「registry 未在册」的取证口径：其查的 `GET /api/servers` 是 MCP 服务注册表，
  非 pack 市场货架——回执时一并订正。
- [x] 6.4 **他人在途缺陷（实测 2026-10-31，不属本 change）**——已由该车道修（`ea06c727`）：
  `server/routes/fleets.js` 的 member PATCH 解构缺 `carrier`（`const { … } = req.body ?? {}`
  未取 `carrier`，下方 `if (carrier !== undefined)` 直接引用）→ 每次 member PATCH 抛
  `carrier is not defined` → 500。证据=`scripts/test-fleet-core.mjs` 两条路由用例在
  **本 change 改动之前**即红（stash 对照已证）。归属=`add-fleet-carrier` 在途车道。
- [ ] 6.5 **既有红（与本 change 无关，仍未修）**：`scripts/test-fleet-event-wake.mjs` 1 条
  （`actual 'cron' !== expected 'event'`）+ `test-fleet-runs.mjs` 的 usage 三列与 seam×2 +
  `test-official-starter-teams` 两条 + `test-bots-event-wake` 超时。**A/B 实证**：`main`(ca6a7b4a)
  32/32 绿、基线 `ea06c727`（现役镜像源）同样 7 红 → 全为分支既有，非本修引入。
- [ ] 6.6 **快照 scrub-rot**：`make-public-snapshot.mjs:329` 只脱敏 `scripts/test-facet-cli-mcp.mjs`
  的字面 clientId，未脱敏 `facet/cli/facet.js:51` 的运行默认值 → 镜像仓 CI 必红。修法=测试改比
  `DEFAULT_OAUTH_CLIENT_ID` 常量并删该 scrub 项。
- [ ] 6.7 **新发现（非本修引入）**：`volces/deepseek-v4.1-flash` 07Z 起成片 503
  （近 3h 两 cell 42 条 failed），压住回合成功率；交词元车道。
