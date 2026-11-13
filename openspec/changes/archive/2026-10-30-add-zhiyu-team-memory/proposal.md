# add-zhiyu-team-memory

## Why

团队跑起来之后，两处「断了」：

1. **团队的连续性只活在对话史里**。壹座现役团队的岗位连续性 = 岗位专属会话史（子进程会话）+ 报数史/KPI 槽位；
   `{{fleetContext}}`（`server/fleet-context.js`）注入的是下级报数与拍板 digest——**没有记忆段**。
   于是清史重开=经验归零，岗位只能靠往工作区里堆文件当记忆用（PATROL_DISCIPLINE 治的正是这个病的
   症状）。永忆（fd-memory u/ 面、L0→L1→L2 蒸馏、永不删页只 supersede）已全建制，萬星部署侧
   （fleet-memory d/ scope）也有团队共享区——**唯独壹座现役团队没有接上**。
2. **团队进不了智语空间**。空间成员三类（user/facade/agent，agent ref=部署 id）——一支团队的关键
   动态（报数、等你拍板、连败/失联/恢复）没有任何通路流进空间；想把团队的部署成员拉进空间讨论，
   只能逐个手动邀请。

路线线5（`docs/roadmap-agents-native-teams.md`）：智语是组织的会议室、永忆是组织的记忆体——
本案把团队接上这两块底座。

## What Changes

- **刀A · 岗位回合接入永忆（fleet-turn-memory）**：
  - 团队节奏回合的关键事实（报数摘要+槽位值、拍板产生/裁决、连败/失联/恢复、换防）以 L0/L1 观测
    capture 进 owner 的 u/ 记忆，namespace 形状 `u/<owner>/f/<fleetId>`（团队一个 project；
    条目带 `metadata.fleetId/memberId`）；零 LLM，L2 蒸馏沿既有 distiller 预算与选材纪律。
  - `{{fleetContext}}` 增「本岗位记忆 digest」段：从记忆面取该岗位相关（memberId 过滤 + 团队共享）
    的 digest，渲染复用 `chat-memory` 的既有契约（硬预算、layer/tier 标注、过期排除、同源检索）。
    provider seam 可空：记忆面不可用→段缺席，**不阻塞回合**（纯读面降级，沿决策 digest 同款姿态）。
  - 换防连续性：清史重开清的是对话史，**岗位记忆照旧**（永不删页）——新在岗者经记忆 digest 接续
    「这个岗位做过什么」，经验不再随对话史蒸发。
- **刀B · 团队×智语（fleet-room-bridge）**：
  - 空间可**订阅**一支自己拥有的团队（订阅关系，非成员形态）：报数摘要、待拍板产生、连败/失联/
    恢复三类关键事件以既有 `kind=system|event` 消息行流入空间（带深链回驾驶舱），频控沿报数防洪
    语义，订阅可随时解除。
  - **一键带队召唤**：空间内从自己的团队清单选一支，其部署成员（`packId:agentId`，既有 agent 成员
    形态）批量邀入 + 该团队事件订阅一并建立；壹座现役团队的 persona 岗**如实不进空间**（无 serving
    面，不假装能说话）——空间内讨论，行动回驾驶舱。
- **明确不做**：不为团队引入第二记忆服务（复用 fd-memory u/ 面）；不自动全量蒸馏对话史（沿
  distiller 选材纪律）；不做 persona 岗在空间内发言（那是 deployment/serving 的事）；不做平台侧
  向机器推送（事件流是空间拉取/网关写入，不改 cell 上行白名单）。

## Capabilities

### New Capabilities

- `fleet-turn-memory`: 团队节奏回合的记忆接入——观测 capture、fleetContext 记忆 digest 段、
  换防连续性语义。
- `fleet-room-bridge`: 团队与智语空间的桥——事件订阅流入、一键带队召唤、频控与解除。

### Modified Capabilities

- `agent-fleet-core`: 换防/清史重开语义补一句——清史只清对话史，岗位记忆（永忆）不随清史删除，
  连续性由记忆 digest 接续。
- `zhiyu-room`: 空间新增「团队订阅」关系（非成员形态）与团队事件消息行；订阅即事件源，解除即断流。

## Impact

- **server**：`server/fleet-context.js`（记忆 digest 段，provider seam）；新 `server/fleet-memory-capture.js`
  （回合事实 capture，零 LLM，走 fd-memory u/ 面）；换防/清史路径不动写面只不动记忆。
- **gateway**：`gateway/zhiyu/store.js`（room 订阅表 + fleet 事件行写入）；新桥模块（fleet 事件→空间行，
  频控）；`gateway/index.js` 挂载。
- **web**：空间详情页团队订阅/召唤入口；`fleetContext` 无新 UI。i18n 五语言同批。
- **记忆侧（fd-memory 仓）**：零契约变更——`f/` 是 `u/` 下普通 project，digest 渲染走既有 MCP/query 面；
  唯一核对项=渲染器的 project 过滤参数支持（若不支持则本项目内先按 scope 前缀过滤）。
- **测试**：capture 单测（五类事件、namespace 形状、失败不阻塞回合）；digest 段 seam 单测（有/无/超预算）；
  桥单测（订阅/频控/解除/深链）；换防连续性单测。
- **不影响**：fleet-memory d/ 侧（萬星部署）、chat-memory 1:1 会话注入、决策 digest、上行白名单。
