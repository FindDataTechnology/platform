## Why

底稿 `docs/agent-parallel-execution-explore.md` 切片⑥（终片）：自迭代闭环——让 agents 自己提议怎么改
自己与自己的团队。①-⑤ 落地后三样东西已齐：**独立执行单元**（承载可配）、**证据源**（细粒度台账+日
汇总）、**记忆面**（永忆锚+成本周报）。缺的最后两根线：①每个 agent 的**记忆章程**（自己决定记什么
——自定义长期记忆的声明面）；②**记忆→提案桥**（台账/周报异常自动提案，走既有决策车道人批）。
防中毒四闸全部借用既有结构（provenance 锚行已在、证据强制/人批终闸是既有车道纪律）。

## What Changes

- **记忆章程（manifest 声明 → persona 组成）**：pack manifest `agents[].memory.guidance`
  （可选，≤600 字）——agent 自己声明「我记什么/何时写/怎么召回」；catalog entry 透传、
  `catalogEntryPersona` 组成时追加为 persona 尾段「【记忆章程】」——fd-memory 的写面
  （memory_write_page）与召回面（回合前 fleetContext 记忆段，已在产）由此被章程塑造。
  章程随 pack 版本走（**章程本身是被迭代对象**）；格式不 fork OKF。
- **成本异常提案器（首个记忆→提案桥）**：`runFleetCostDigests` 周报 sweep 内——某成员
  queue_wait max ≥5min 且本周 ≥3 个独立日命中（carrier=cell/auto、样本 ≥6 回合）→ 向该舰队
  决策车道投 **carrier-change 提案**（新 item_type）：detail 带证据链（周/成员/等待分布/有价
  成本样本/turn_ids 抽样）与建议值（worker，附前置条件说明）；approve 回调 = updateMember
  carrier + 既有 captureFleetFact decision-resolved。**人批终闸**：提议≠生效。
- **防中毒钉住**：提案 detail 必带 provenance（proposedBy=platform:cost-anomaly + evidence）；
  同成员同型提案去重（在途即跳过）；证据不足（样本 <6 回合）不受理。
- **召回梯钉住**：fleetContext 记忆段（digest 面 → 缺席即段缺）已在产——spec 钉住其自迭代语义
  （章程塑造自写内容，召回由平台注入，两者正交）。

## Capabilities

### New Capabilities

- `agent-self-iteration`：自迭代闭环面——记忆章程（manifest 声明→persona 组成）、成本异常提案器
  （证据链→决策车道→人批生效）、防中毒纪律（provenance/证据强制/去重/人批终闸）。

### Modified Capabilities

（无——`agent-fleet-core` 的记忆层语义不变；`agent-fleet-carrier` 的解析/降级不变（提案器只是
配置面的新写入口，走同一 updateMember）。

## Impact

- **代码**：`lib/pack-manifest.js`（memory.guidance 校验）；`catalog.js`（entry 透传）；
  `dsh-profile.js`（catalogEntryPersona 追加章程段 + defs diff 自然重启）；`server/fleet-cost-digest.js`
  （异常评估→提案投递）；`server/fleet-decisions.js` 或 routes/fleets.js（carrier-change 批准回调）。
- **契约**：manifest 新可选字段（旧 pack 零变化）；决策车道新增 item_type（既有面零影响）。
- **测试**：章程校验/组成、异常判据（阈值/样本门/去重）、提案投递与批准回调；既有面零回归。
- **风险**：提案噪声（去重 + 阈值双闸）；runner 声明的提案在池未开时 fail-open（切片⑤语义，
  提案 detail 说明前置条件）。
