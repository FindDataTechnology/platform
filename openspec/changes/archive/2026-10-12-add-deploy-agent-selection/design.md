# Design — add-deploy-agent-selection

## Context

M4① 部署向导的前置半边（fd-wanxing 侧另立 change `add-deploy-wizard`）。本 change 只动
facet deploy 端点与 deployToRegistry，让「部署哪些 agent」成为载荷一等公民。

## Goals / Non-Goals

- Goals: `agents` 子集载荷；选中集语义收缩（计费/密钥生命周期）；缺省全量字节级兼容。
- Non-Goals: 不做向导 UI（fd-wanxing）；不动 models/rhythms/budgets 的校验语义（它们对
  未选中 agent 本就是 no-op——deployToRegistry 不迭代它们）；不做「部分下架」（undeploy 独立）。

## Decisions

### D1 — 选中集在路由层解析为 `deployIds`

`const deployIds = req.body?.agents === undefined ? servingIds : new Set(验证后的数组)`。
校验规则：非空字符串数组、无重复、每个 ∈ servingIds；违例 400 指名（含重复/空数组两种形状错）。
传给 deployToRegistry：`onlyAgents: [...deployIds]`。

### D2 — 绑定生命周期按选中集收缩，存储行按 serving 集清洗

三处使用点替换 `servingIds → deployIds`，一处保留：

| 逻辑点 | 集合 | 理由 |
|---|---|---|
| billingKeys unknown-agent 拒收 | servingIds→**deployIds**（serving 之外仍拒） | 面向本次不部署的 agent 粘键=无效操作，拒收指名 |
| kept 绑定收集（缺席骑行现有键） | → **deployIds** | 只重验要部署的 |
| 「每个 serving agent 必须有键」准入门 | → **deployIds** | 未选中者不要求 |
| 非 serving agent 的旧行清洗（keys/secrets） | **保持 servingIds** | agent 离开 serving 集=绑定确实作废，与子集无关 |

secrets 同理：显式 null 解绑面向 serving-but-unselected → 400 拒收指名；`bound` 结果集只对
deployIds 生成 refs（未选中的现有行不进本次 descriptor，也不删）。

### D3 — deployToRegistry 的过滤点在 `serving` 列表本身

```js
const serving = listServingAgents(manifest);
if (onlyAgents) { /* filter + non-empty check */ }
```
只过滤迭代对象；端口规划、技能 upsert、descriptor 组装全部随之自然收缩。`onlyAgents` 缺省
null = 旧行为（不传数组进去，不做过滤），零 diff。

### D4 — 记账与响应自动正确

`recordDeployment` / `recordDeploymentKey` / `recordDeploymentSecret` 都在 `out.deployed` 循环
里——选中集过滤后它们只看到选中的 agent，无需改动。响应 `deployed[]` 同理。

## Risks / Trade-offs

- **未选中 agent 的配置漂移**：向导后用户改主意再全量部署时，未选中期的新 binding 会被
  重验/替换——这正是重验逻辑的职责，不是本 change 的回归。
- **老调用方**：壹座功能集与 selfservice v1 都不传 `agents`，走缺省全量，字节级不变
  （单测断言缺省路径 deployed 数不变）。

## Migration Plan

无 schema 变化、无配置变化。部署=镜像滚动（platform/platform-demo/facet 三面同滚，facet
Service 是 selfservice 的通道）。

## Open Questions

无。
