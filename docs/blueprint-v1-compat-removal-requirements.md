# 摘除蓝图 v1 兼容层 · paas 侧需求书

> **状态：已实施并归档**（change `remove-blueprint-v1-compat`，2026-10-29）。以 change 与 spec `fleet-blueprint-studio` 为准，本文当验收视图；文中行号为实施前快照。
>
> 交付对象：paas 实施者。背景：2026-10-29 用户裁决「**现在没有真实用户**」——不存在需要接住历史蓝图的存量客户，v1 兼容层（`normalizeIncomingContent`）从「必要兼容」降级为纯技术债，应摘除。
> 姊妹单：《fleet-blueprint-studio-requirements》《blueprint-studio-implementation-notes》《add-blueprint-llm-assertions》（本单与后者相邻但不重叠：那单加 `llm-judged` 断言，本单删 v1 读入适配）。
> 契约真源已对齐：finddata `fleet-packs/blueprints/schema.md` 已升 **v2**（change `blueprint-format-v2-alignment` 已归档），构造师 pack 已发 **v4**（persona 教 v2 字段）。

---

## 1. 现状（实测，2026-10-29）

**生产库只有一条蓝图**，且形状已是 v2：

```
/data/cells/1da519d4c1c0bf89/data/data/blueprints.db
  bp_1793191639268_dxi7sx  owner=aloadtree@gmail.com  v2  status=cast
  keys: boundary / dataSources / fleet / agents / mcpServers / monitoring / acceptance / board
  acceptance: [{id:"post-up",kind:"post-materialized"}, {id:"watch-fired",kind:"first-round-fired",target:"盯梢岗"}]
  cast: _PGsJcBwYoeZU0kCfU-2Qg v2
```

其余三个 cell 的 blueprints.db 均为 **0 行**。

**结论**：归一化层在生产数据上从未被真实使用过——它唯一服务的对象是 finddata 仓里那两份 v1 样例文件（历史证据，不转写、也不再被加载）。**摘除零风险。**

## 2. 摘除范围

| 编号 | 摘什么 | 位置 | 处置 |
|---|---|---|---|
| A | `normalizeIncomingContent` 函数本体 | `server/blueprint-validate.js:161` | 删除 |
| B | 两处调用点 | `server/routes/blueprints.js:136`（PUT 编辑）、`:175`（POST 创建或 validate 入口） | 改为直接读 `raw.content`；**但要保留抓「v1 形状误用」的明确拒绝**（见 §3）——落地为**写入层 `assertStorable` 硬拒（422）+ `validateBlueprint` 前置短路**两处，不是仅加在 `shapeFindings` 里 |
| C | import | `server/routes/blueprints.js:13` | 删除 |
| D | `free-text` 注释与相关分支 | `server/blueprint-validate.js:159` 附近 | 删除；`TRIAL_ASSERTION_KINDS` 保持五型闭集 |
| E | 测试中若有用例锚 `normalizeIncomingContent` | `scripts/test-blueprint*.mjs` | 删除或改为断言「v1 形状被明确拒绝」 |

## 3. 摘除后必须补的一件事：**明确的 v1 误用拒绝**

直接删干净会让「粘一份 v1 蓝图进来」变成**静默变空壳**：`boundary` / `dataSources` / `board` 三段静默缺位被存成草稿；校验时报的是 **4 条 `acceptance[N] must be an object` 形状错 + 一条无 `entry` 的包级错**（`a pack must contain at least one skill, MCP reference, agent, or bot`）——用户看不出根因是「格式是 v1」。（`fleet` / `monitoring` 键名 v1/v2 相同，不会缺、也不会报错；所以不是「六段全缺」。）这是比兼容层更糟的体验。

要求：加一条**前置判别 + 短路**——若 content 出现 v1 独有键（`vertical` / `sources` / `boards`）而无对应 v2 键（`boundary` / `dataSources` / `board`），报**唯一一条**指名错误并短路后续校验链：

```
蓝图格式为 v1（vertical/sources/boards + 自由文本 acceptance），本平台只接受 v2。
v2 字段：boundary{name, oneLine, outOfScope} / dataSources[{ref, note?}] /
board[] / acceptance[{id, kind, target?, expect?, rubric?}]。
格式真源：finddata fleet-packs/blueprints/schema.md（v2）。
迁移：把 vertical{name,tagline,non_goals[]} 换成 boundary{name, oneLine, outOfScope}、
sources[].registryName 换成 dataSources[].ref、boards 换 board、自由文本断言换成五型结构化条目。
```

**这是「如实拒绝而非静默猜测」的延续**，与 spec `fleet-blueprint-studio` D3「未知 kind 拒绝而非猜测」同族。

## 4. 不在范围

- `llm-judged` 第五型及其双钥匙（属 `add-blueprint-llm-assertions`）。
- 生产库那一条蓝图记录：已是 v2，不动。
- finddata 仓的 `cross-border-ecom-policy` / `sample-backfill` 两份 v1 样例：**历史证据，保持原样不转写**（前者是 L3 首单真跑验收凭据）。

## 5. 验收口径

1. **摘净**：`grep -r "normalizeIncomingContent" server/` 零命中；`free-text` 仅允许出现在「v1 误用拒绝」的错误文案里。
2. **v2 正常路**：按 v2 写的蓝图创建→校验→批准→铸造全链不变（回归 `test-blueprints.mjs` 全绿）。
3. **v1 明确拒**：粘一份 v1 蓝图（如 finddata 的 `cross-border-ecom-policy/blueprint.json` 原文），返回**一条指名 v1→v2 的错误**，不是 4 条 acceptance 形状错 + 一条无 entry 的包级错。
4. **生产无感**：那条已 cast 的 v2 蓝图在总览坞显示、试跑报告读取均正常。
5. `openspec validate` 与既有测试套（`test-blueprint*.mjs`）全绿。

## 6. 顺带确认（本单外，供参考）

- paas 侧 5 件已归档：`add-blueprint-studio` / `add-fleet-owner-surface` / `add-fleet-owner-iteration` / `add-market-revenue-share` / `add-pack-locale-tracks`；在途 `add-blueprint-llm-assertions`。
- 市场侧已由 finddata 清干净：74 包、包名零「舰队」、类目 `fleet` 归零（`cluster`/`cluster-shared`/`facade`），跨境电商重影与两枚测试残渣已下架（store 备份 `packs.db.bak-dup-20261028`）。
