## Why

柏讯（wire）是壹座的第三条产品线，但在壹座里它仍只是一张标着「建设早期」的外链卡（`web/src/lib/appCatalog.ts`）：用户看柏讯状态必须离开壹座，AI 也无法代他操作柏讯。两端的闸现在都已就位——壹座侧 `add-line-boards-and-action-gate`（960e6725）立起了看板 / 动作闸 / 副驾的骨架，柏讯侧 `wire-copilot-action-gate`（fd-wire a228bfa）实施了**同 id 同风险语义**的动作闸，两个操作 MCP（wire-ops-mcp 10 工具 / wire-build-mcp 15 工具）在产且 `tool-surface.json` 已带 `tool_risk`，`wire-customer` 凭据轨道也在产。缺的只是把柏讯接成壹座的一条线。

本次探查同时发现：姊妹 change 交付的是**骨架**，柏讯恰好是第一条要走通「提议 → 确认 → 执行 → 审计」全链的线，会踩中骨架里所有没填的洞——`executeAction` 是只打 log 的空壳（`server/routes/actions.js:233`）；`propose_action` 的 loopback 调用不带任何身份，提议落库 `proposer_email=null` 后永远过不了 owner 校验（`server/actions-mcp.js:84` / `actions.js:124`）；迁移计划承诺的 `LINE_BOARDS_ENABLED` 回滚杆全仓零命中；官方 pack 的写工具 lint 只是发布说明里的一句话。这些地基不在本 change 填实，柏讯全链就是死的，所以它们被**显式纳入范围**，而非留给姊妹 change 慢慢补。

## What Changes

- **柏讯线看板 `/boards/wire`**：新增 `WireBoardAdapter`，服务端直读柏讯客户面 REST（`GET /api/v1/datasets|artifacts|demands`、免费档配额 `datasets/quota`），四块：概览（指标）/ 我的数据（列表）/ 产物（列表）/ 需求单（时间线）；市场浏览列为 v1.1 可选。凭据 = 该用户的 `wire-customer` ID token，连接判据 = `liveToken` 非空（不是「有无 email」）。未连接 → 未连接态 + 去连接入口；上游 401 → 清凭据回未连接并提示重连（既有 ID-token 机制，**不引入 stale**）。每块独立错误信封、原站深链。**这是第一个非占位的 board adapter**（facet / wanxing 两个仍是 TODO 占位，不在本 change 范围）。
- **动作注册表柏讯八条**：`wire.demand.submit`（write）、`wire.market.subscribe`（cost）、`wire.market.unsubscribe`（write）、`wire.dataset.create`（write）、`wire.artifact.publish`（write）、`wire.artifact.archive`（write）、`wire.dataset.correct`（write）、`wire.dataset.correction.revert`（write）——id 与 fd-wire `REGISTRY` 逐字一致，风险与两 MCP 仓 `tool-surface.json` 的 `tool_risk` 逐条对拍；`riskToTier` 不动（与 fd-wire `RISK_TO_TIER` 已逐字一致）。新增三方对拍测试：注册表 ↔ 本仓快照为 CI 硬门，快照 ↔ 两仓源文件为本地门 + 刷新脚本。
- **闸执行器从空壳变真**（地基修补）：新增 MCP 客户端执行路径，按 `action.tool` 调 wire-ops-mcp / wire-build-mcp 的写工具（Streamable HTTP，`Authorization: Bearer <wire-customer liveToken>`）；上游 422 逐字段透传、401 清凭据并把提案置为失败；审计落 `action_audit`。facet / wanxing 的既有动作后续复用同一条路径。
- **提议身份链修补**（地基修补）：`propose_action` 子进程经 per-user effective profile 注入的身份调 loopback，提议落真实 `proposer_email`；`/api/actions/propose` 加入 loopback 信任家族（仅 propose；approve / reject / query 仍走完整认证）。preflight 由此能判「该用户 wire-customer 是否已连接」。
- **执行前用户补填参数**（新通用机制，首个消费者 = 需求单合规）：注册表条目可声明 `userFilledArgs`；propose 时服务端**强制剥除**模型提供的这些字段，确认卡渲染空输入，未填齐确认钮不可点，approve 携带用户填值合并后执行。`wire.demand.submit` 的「公开源 URL + 公开数据声明」两字段走此机制，**绝不代填代勾**。
- **官方 pack「柏讯助手」**：照 `谦面助手` 形状；读面 = wire-ops-mcp 7 读工具 + wire-build-mcp 4 读工具（`dataset_schema` / `artifact_list` / `artifact_get` / `dataset_corrections_list`）；persona 纪律沿谦面助手句式并加需求单合规不代填；控制台 playbook 改编自 wire-build-mcp 指南并附能力边界表；`requiredGroup: wire-customers`；先 private。**写工具 lint 落为仓库级测试**：官方 pack 的 `allowTools` 不得命中两仓 `tool_risk` 键全集（12 个写工具名）。
- **应用中心 IA**：`wire` 卡加入看板线——主行动「看板」进 `/boards/wire`，「打开原站」降为次要，摘「建设早期」徽章。看板主行动的可用条件 = **该看板所需凭据已连接**（柏讯 = `line-wire-customer`），**不要求卡片聚合态为 connected**（wire 卡聚合了 `paper-trading`，与看板无关）。
- **`LINE_BOARDS_ENABLED` 回滚杆**（地基修补）：实现姊妹迁移计划承诺的 env 门，默认关，覆盖全部 `/api/boards/:line` 路由、`/boards/:line` 前端路由与应用中心看板主行动。关门即回到现状。
- **五语 i18n** 补齐柏讯看板块标题、动作影响面、合规字段文案、能力边界提示。

**不做**：facet / wanxing 占位适配器补真；fd-wire 侧任何代码改动；新增凭据 ref；wire 侧动作审计的 board 呈现（跨产品审计聚合留 v2）；DOM 级界面操控或引入 CopilotKit；`COPILOT_ENABLED` 杆（归姊妹 change）。

## Capabilities

### New Capabilities

（无。柏讯接入复用 `line-boards` / `action-gate` 两个 capability，不另起。）

### Modified Capabilities

- `line-boards`: **ADDED** 三条柏讯专属需求——看板真读客户面 REST、凭据态诚实呈现（未连接 / 401 回未连接）、每块原站深链。该 capability 由在途 change `add-line-boards-and-action-gate` 引入、尚未归档；本 change **只 ADDED 不 MODIFIED** 其既有需求，归档顺序互不耦合。
- `action-gate`: **ADDED** 五条需求——柏讯八条注册与三方风险对拍、柏讯写动作经 MCP 执行器与用户凭据、提议携带真实身份、执行前用户补填参数（合规不代填）、副驾 pack 不含柏讯写工具。同上，只 ADDED。
- `app-center`: **MODIFIED**「统一网格——一卡一生态产品」——柏讯加入看板线（主行动「看板」、次要「打开原站」、摘早期徽章），看板主行动的可用条件改为「看板所需凭据已连接」。文本叠加在姊妹 change 对同一需求的修改之上，按先姊妹后本 change 的顺序归档可直接合流。

## Impact

- `lib/board-adapters.js`（`WireBoardAdapter` 真读 + 注册到 `ADAPTERS`）、`lib/action-registry.js`（+8 条、`userFilledArgs` 字段）、新 `lib/wire-tool-risk.js`（两仓 `tool_risk` 快照 + 八对 action↔tool 映射）、新 `scripts/refresh-wire-tool-surface.mjs`
- 新 `lib/action-executor.js`（MCP 客户端：endpoint 解析、一次性 connect → callTool → close、Bearer 注入、422/401 映射）；`server/routes/actions.js`（`executeAction` 改调执行器、approve 接收 `userArgs`、propose 剥除 `userFilledArgs`、`LINE_BOARDS_ENABLED` 不在此）；`server/routes/boards.js`（env 门）
- `server/actions-mcp.js`（loopback 调用携带身份）、`dsh-profile.js`（为 `actions` stdio server 注入 per-user 身份 env）、`server/auth.js`（`POST /api/actions/propose` loopback 豁免）
- `web/`：`ActionCard.tsx`（补填字段渲染与确认门控）、`AppCenterPage.tsx` + `appCatalog.ts`（wire 看板 CTA、摘 `status: "early"`、CTA 条件按看板凭据）、`BoardsPage.tsx`（wire 四块与深链）、路由 env 门、五语 locale
- `docs/official-packs/wire-assistant-manifest.json` + 仓库级 lint 测试；`docs/acceptance-criteria.md` 追加柏讯十场景
- 依赖：`@modelcontextprotocol/sdk ^1.29.0` 已在 `package.json`，无新包；两 MCP server 的 `mcp_endpoint` 经 registry-bridge 推导（`{REGISTRY_URL}/{path}/mcp`），网关 Bearer 透传 10-20 已修
- 外部仓：**零改动**。fd-wire 侧两处小缺口（`ACTION_TO_TOOL_NAME` 漏 `wire.dataset.create`；`wire_artifact_update` / `wire_artifact_restore` 有工具无 action id）与 `draft.create` / `promote` / `share.create` 的映射挂账记入 design Open Questions，作 fd-wire 线 follow-up
- 对姊妹 change 的影响：本 change 把它 tasks 1.3（executor）、1.5（preflight 身份）、8.3（env 杆）的缺口补实；facet / wanxing 适配器占位（3.1 / 3.2）原样保留并在 design 中点名
