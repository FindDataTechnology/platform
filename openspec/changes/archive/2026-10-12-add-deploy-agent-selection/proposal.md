## Why

M4① 部署向导（`docs/facet-wanxing-roadmap.md` M4 段）把部署从 4 裸字段升级为分步交互，第一个
gap 就是 agent 勾选：`my/packs` 已经返回 `deployableAgents` 清单，但 deploy 端点今天**无条件部署
全部 serving agent**——载荷里没有选择面，向导无从谈起。多 agent pack（如法律 ×6）的用户常常只
想让某一个 agent 上线，今天只能全量部署再手动暂停其余，这是「配得好」的第一道坎。

## What Changes

- facet deploy 端点（`POST /api/packs/:id/versions/:version/deploy`）接受新载荷键 `agents`：
  一个 serving agent id 的非空数组。缺省 = 全量（与今天的字节级行为一致，老调用方零迁移）。
- 校验：数组元素必须是本 pack 的 serving agent id，无重复；否则 400 指名。
- 语义收缩（只影响声明了 `agents` 的请求）：
  - 计费键准入规则「每个 serving agent 必须有键」只对**选中的** agent 生效；未选中的 serving
    agent 保留现有绑定不动（不重验、不要求、不丢弃）。
  - 面向未选中 serving agent 的 `billingKeys` 粘贴 / `secrets` 显式 null 解绑 → 400 拒收并指名
    （诚实拒绝优于静默无效：这些 agent 本次不重部署，动了绑定会与在产 registry entry 脱钩）。
  - 未选中 agent 的 deployment_keys / deployment_secrets 存储行原样存活（它们的 registry entry
    还活着）。
- `deployToRegistry` 接受 `onlyAgents`，只迭代选中的 serving agent；返回与记账（pack_deployments
  行）自然只含选中者。
- 响应不变：`deployed[]` 列出本次实际部署的 agent。

## Impact

- 代码：`gateway/packs.js` deploy 路由（载荷校验 + 绑定生命周期按选中集收缩）、
  `lib/agent-serving.js` deployToRegistry（onlyAgents 过滤）。
- 兼容：不传 `agents` = 全量，现有调用方（壹座功能集、fd-wanxing selfservice v1）零变化。
- 消费方：fd-wanxing `add-deploy-wizard`（M4① 主体，另仓 change）依赖本端点。
- specs：`a2a-agent-serving` 的 deploy 需求增补子集语义场景。
