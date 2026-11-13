## Why

copilot-dock-focused-preset 的模型回合级验收暴露：`propose_action` 入口不校验参数键名。模型三轮都先对
`facet.pack.visibility` 传 `packId/packName`（影响面渲染成「包「undefined」」），再自纠成 `id`——前几轮各落一条
**不可批准的 pending 垃圾行**（批准会把错键原样递给执行器工具；要等 24h 才由 `lib/action-expiry.js` 过期）。
对代码与上游源码核对后，根因有四层，且比登记时更深：

- `server/actions-mcp.js` 把 `args` 声明成「对 MCP 层不透明的 object」，模型拿不到任何动作的键名，只能试错；
- `lib/action-registry.js` 的 `filterKnownArgs` **只过滤不拒绝**、别名只做 snake↔camel，且只对声明了 `argKeys` 的动作
  生效——facet.\* 四条 / wanxing.\* 五条全无声明，原样透传；
- 注册表影响面模板与上游签名不一致：wanxing 上游 `wanxing_agent_pause(pack_id, agent_id)` 等全是下划线而模板读
  `agentId/packId`（模型按模板传驼峰 → 执行时 pydantic 422）；`facet_market_pack_curation(id, category?, featured?)`
  根本没有模板读的 `action`；`wire_dataset_create(name, csv_content?, columns?)` 的声明写成 `["name","source"]`
  （CSV 体与列声明被静默丢弃）；
- `server/routes/actions.js` 过滤后不校验必填就 INSERT pending，`impact` 直接吃 undefined 进 `impact_text`。

## What Changes

- 注册表 19 个动作全部按上游源码签名钉 `argKeys` + `requiredArgs`（真源：`facet_ops_mcp/tools_marketplane.py` +
  `tools_market.py`、`wanxing_ops_mcp/tools_fleet.py`、`wire_ops_mcp/tools_console.py`，2026-10-22 读取）；
  visibility/curation 声明 `packId/pack_id → id` 别名；影响面模板改读规范键；`wire.dataset.create` 声明纠正。
- `filterKnownArgs` 归一顺序：逐字 → 驼峰/下划线对偶（双向）→ 声明别名；新增 `validateArgs`。
- `POST /api/actions/propose` 在 **preflight 之后、落库之前**校验必填键：缺则 400
  `{ error: "invalid args", details, missing, expected }`，不落库（缺凭据的用户仍先看到连接指引）。
- `actions-mcp.js` 从注册表生成逐动作键名清单进 `args` 描述（`*` 必填）；桥接错误把 `details` 透给模型，
  使其可在同一回合自纠。
- 看板四个 `args: {}` 的 stub 按钮（管理可见性 / 暂停 agent / 发布新包 / 新建数据集）由「落一条批准必 422 的
  pending」变为即时 400 并在看板显示缺失键——诚实失败，待各看板真适配器补上参数。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `action-gate`: ADDED 需求「提议参数按注册表声明校验与归一」（4 场景）。既有「动作注册表声明风险与影响面」
  不改，参数声明作为并列需求新增。

## Impact

- 代码：`lib/action-registry.js`、`server/routes/actions.js`、`server/actions-mcp.js`。
- 测试：`lib/action-registry.test.js`（声明不变量 / 别名归一 / validateArgs / 模板无 undefined；突变验证：删别名红 2、
  模板回驼峰红 1）、`scripts/test-wire-line-board.mjs`（400 不落库 + 空白即缺失；两个 approve 用例的 propose 体改为合法体）。
- 不出片不归档：随下一次 platform 列车；aloadtree 真 cell 回合级复验后归档。
