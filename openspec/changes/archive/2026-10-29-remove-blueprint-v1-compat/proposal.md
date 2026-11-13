## Why

2026-10-29 用户裁决「现在没有真实用户」——不存在需要接住历史蓝图的存量客户，蓝图 v1 兼容层（`normalizeIncomingContent`，2026-10-28 跨仓对账时加的读入侧单向归一化）从「必要兼容」降级为纯技术债。它在生产数据上从未被真实使用过（四个 cell 的生产库只有一条 v2 蓝图，其余 0 行）。

更关键：`add-blueprint-llm-assertions` 落地后，这个兼容层的行为已经变质——它把 v1 的自由文本断言**静默升级**成 `llm-judged` 条目（原文当 rubric），替作者凭空造出模型判决言，而且即便如此仍过不了发布门（缺内联物件）。它既不再「如实指名不支持」，也不真的让 v1 可用。留着它只会让「粘一份 v1」变成一堆难以归因的散错加一份被冒名的模型判据。

## What Changes

- 删除 `server/blueprint-validate.js` 的 `normalizeIncomingContent`（函数本体 + 整段跨仓兼容注释 + 自由文本归一分支）。
- 删除 `server/routes/blueprints.js` 的 import 与 POST/PUT 两处调用，改为直接读 `raw.content`。
- **新增 v1 方言如实拒绝**：content 出现 v1 独有键（`vertical` / `sources` / `boards`）而缺对应 v2 键（`boundary` / `dataSources` / `board`）时，报**一条**指名 v1→v2 的错误（含 v2 字段清单与迁移指引），**短路**后续校验链——不是 4 条 acceptance 形状错 + 一条无 entry 的包级错。
- 拒绝落在两处：写入层 `assertStorable` 硬拒（422，与凭据禁带同级，覆盖 POST/PUT 及未来任何写路径）+ 校验链 `validateBlueprint` 前置短路（`/validate`、`/approve`、`/cast` 防线）。
- **BREAKING**：v1 形状的蓝图不再被归一化接受；粘入即被指名拒绝。无存量客户受影响（生产库零 v1 记录）。
- 把锁住旧行为的测试（`scripts/test-blueprints.mjs:461`「v1 原样粘入即可编辑/校验/铸造」）翻成「v1 → 422 + 一条指名 v1 错误」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `fleet-blueprint-studio`：新增「v1 方言如实拒绝」要求（替代此前的静默归一化读入路径）；契约真源 v2 之外的方言必须被指名拒绝而非猜测或归一。

## Impact

- 代码：`server/blueprint-validate.js`（删函数、加 `v1FormatFindings`、`validateBlueprint` 前置短路）、`server/routes/blueprints-db.js`（`assertStorable` 增 v1 判别）、`server/routes/blueprints.js`（删 import 与两处调用）。
- 测试：`scripts/test-blueprints.mjs` 的 v1 兼容用例改写；其余 `test-blueprint*.mjs` 回归不变。
- 契约：`finddata fleet-packs/blueprints/schema.md` 的「平台在读入侧做了单向归一化适配 / v1 仅作历史资产兼容读入」注记需在 finddata 仓同步更正（跨仓，非本仓实施项，见 design「契约源滞后」）。
- 生产数据：唯一一条已 cast 的 v2 蓝图不受影响（总览坞显示、试跑报告读取照常）；其余 cell 库为空。
- 不在范围：`llm-judged` 第五型与双钥匙（属 `add-blueprint-llm-assertions`）；finddata 仓两份 v1 样例（历史证据，原样保留不转写）。
