# Tasks — add-cockpit-run-stop

## 1. API 封装

- [x] 1.1 `fleets-api.ts`：`cancelRun(fleetId, runId, reason?)` → POST 既有取消接口
- [x] 1.2 错误体 `error` 原样带出（不吞成通用文案）
- [x] 1.3 `RunListEntry` 补 `stoppedAt` / `stopReason` / `cost` 类型（读面此前已返回，类型缺字段）

## 2. 驾驶舱交互（`RunTimeline.tsx`）

- [x] 2.1 仅 `status=open` 且未停止时呈现「停止这一轮」（`data-testid="run-stop"`）
- [x] 2.2 点击先开危险态确认框（`ui/confirm-dialog`，取消在 DOM 前、Esc=取消），文案写清后果
- [x] 2.3 确认后调一次接口；三种回执分开（已停止/此前已停止/失败原因）
- [x] 2.4 停止后重读 detail + list（读面说真话，不本地改状态）
- [x] 2.5 停止后头部改呈现 `StatusPill status="paused"` + 停止原因，按钮消失
- [x] 2.6 5 语种文案齐全；`check-locales` 通过；`design-lint` 零新增违规

## 3. 测试

- [x] 3.1 `e2e/fleets.spec.js` 新增「fleet run stop」：按钮可见 → 确认框危险态 → 取消零请求 →
      确认恰好一次 → 回执含中断数 → 停止标记与原因出现、按钮消失
- [x] 3.2 `fleets.spec.js` 全文件 24/24 绿（含原有画布/时间线/岗位卡用例）
- [x] 3.3 后端运行生命周期套件：`test-fleet-runs`(26) / `test-fleet-run-budget`(9) /
      `test-fleet-owner-surface`(9) / `test-fleet-turn-events`(15) 全绿
- [x] 3.4 类型检查 `tsc --noEmit` 通过

## 4. 上线

- [x] 4.1 快照 → GHA → relay → skopeo digest `sha256:5c174f7e` → GitOps（并发会话已推同一 tag `5d79069`，其快照基线 004cbdb2c ⊃ 本提交，
      已按树 grep 验证含本刀）→ ArgoCD 对齐 → platform/facet 滚完 → **舱内实证**：`RunTimeline-BoBV99JO.js` 含
      `run-stop`(3)/`run-stopped`/`run-stop-notice`/`cancel`(3)，中英文文案齐
- [x] 4.2 归档（`openspec validate --strict` 通过后）
