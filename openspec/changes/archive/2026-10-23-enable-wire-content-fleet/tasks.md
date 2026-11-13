# Tasks: enable-wire-content-fleet

## 1. P1 · 岗位身份注入成员回合（阻断项）

- [x] 1.1 新增身份行渲染 `renderFleetIdentity`（`server/fleet-reports.js`）：给定 `{ fleetId, memberId, title, targetKind, targetId }` 产出 `【舰队岗位身份】fleet=…; post=…; title=…; target=…` 单行（纯函数）。验证：单测断言四字段齐、无凭据
- [x] 1.2 `server.js` 在 `attachCronRunner(ctx)` 之后挂 `ctx.resolveFleetIdentity(presetId)`：用 `getFleetDatabase()` 的 persona 岗 + `rosterPresetId` 调 `resolveAttribution`，`kind==="preset"` 返回身份行，`none`/`ambiguous` 返回 null。验证：注入 wiring 后非成员 preset 返回 null
- [x] 1.3 `server/cron-runner.js` 的 `runPersonaTurn`：在 `chatHistory.recordMessage` 与 `dshBridge.prompt` 之前，若 `resolveFleetIdentity(job.preset)` 非 null 则把它前缀进本次 `job.prompt`。验证：cron 岗回合 prompt 首行为身份行
- [x] 1.4 覆盖 delegation 唤醒路径：同一条 `runPersonaTurn` 已覆盖（manual task 也走它），补一条测试断言 passive 岗受委托回合同样注入。验证：单测红→绿
- [x] 1.5 非舰队回合不注入：普通 persona 对话、persona 未在岗任何岗位、一 persona 占多岗（ambiguous）三种情形均不加前缀。验证：三条断言
- [x] 1.6 回归 `scripts/test-fleet-report-lane.mjs` / `test-fleet-decision-lane.mjs` / `test-fleet-templates.mjs` 全绿

## 2. P2 · 舰队节奏只读契约

- [x] 2.1 `GET /api/fleets/:id/cadence`：`requireOwnedFleet` 作用域，返回 `{ fleetId, fleetName, posts: [{ ref, title, cron, tz, targetRef: { kind, id } }] }`；被动岗 `cron`/`tz` 为 null；不含 KPI 槽/报数/拍板/凭据。验证：新增小测断言响应形状与「不含凭据字段」
- [x] 2.2 未知/非本人舰队返回 404/403（沿用 `requireOwnedFleet` 既有语义）。验证：测试覆盖

## 3. P3 · pack 策略上限：默认 6 + 运维可配

- [x] 3.1 `lib/pack-manifest.js`：`maxMcpRefs` 默认 5 → 6；新增 `packLimits(env)`，`PACK_MAX_SKILLS` / `PACK_MAX_AGENTS` / `PACK_MAX_MCP_REFS` 逐次读取覆盖，非法值回落默认；`validatePackManifest` 默认参数改用 `packLimits()`。验证：默认 6 收、7 拒；覆盖成 8 后 8 收；空/0/负数/非整数回落 6
- [x] 3.2 `gateway/packs.js` 透出 `packLimits`（市场的唯一校验入口已走 `validateManifest`，无需额外接线）。验证：`node --check` + 市场校验测试全绿

## 4. 验证项 V1-V3（纯核对，不改代码）

- [ ] 4.1 V1：装好 cell 里查 `catalog.getAgentEntry("packs-kkcie7nlrhluo4likpnn0w-spider-heal")` 是否 `mode === "a2a"`；不等则回告柏讯改模板 id
- [ ] 4.2 V2：装「柏讯 · 产物构建」后 catalog 应有 `wire-fleet-patrol`、`wire-fleet-content` 两条 `status: "installed"`
- [ ] 4.3 V3：装包 → 建队应得 3 岗（巡线 cron `0 9 * * *`、内容无 cron、源岗 a2a 目标位）；源岗若 V1 未过则降级为待补岗（既有语义，非缺陷）

## 5. 收尾

- [ ] 5.1 出片 + 台账 `docs/registry-maintenance.md` 记 V1-V3 结论
- [ ] 5.2 `openspec validate enable-wire-content-fleet` 绿，apply 完结后归档
