## Why

上一步给了团队一张能被发现的名片，但名片不能当电话用。今天跨用户唯一能调的是**单个** agent：
`openspec/specs/a2a-agent-serving` 严格按 role 逐条注册，caller 拿到的是「某个岗」，拿不到「一支团队」。
于是「我有活要派给一支团队」这件事，只能由调用方自己知道该点哪个岗、按什么顺序点、怎么汇总——
把编排责任推给了外人，而这恰恰是团队这个一等公民存在的理由。

`add-agent-team-directory` 已经把「谁能被看见」定下来了；这一件把「看见之后怎么调」补上，
并且**一期就用真 a2a 形状**，使二期换成 registry 路由时服务端一行不改。

## What Changes

- 新增**团队级 a2a 端点**：`POST /api/teams/:cellId/:handle/a2a`，JSON-RPC `message/stream`，
  与 registry a2a 同协议同形状。一期入口在平台网关内，二期由 registry 网关路由到同一实现。
- 新增**路由岗（reception）**：团队卡声明的唯一入口岗，负责判断该由哪个岗/几个岗接、内部派活、
  汇总一个回复。路由岗不新造编排器——复用 `agent-fleet-core` 的既有编导边与派发语义。
- 新增**调用方身份适配层**：一期解析平台会话令牌，二期加外部 registry 凭据适配器；解析失败
  一律结构化拒绝，**绝不回落到任何默认身份**。
- 新增**授权判定**：按发布行的可见性与白名单——`open` 白名单内免批，`listed` 需主人批准
  （批准可一次性或带期限），`private` 一律不可调。
- 新增**配额扣减**：目录页已声明的三项硬配额在本能力里真正生效；触顶如实拒、流式中途触顶如实中断。
- 新增**长任务回投**：超过同步窗口的任务转为后台执行，完成（或失败）经既有事项/通知通道回投调用方，
  不把连接挂死等超时。
- **补齐深度逐跳 +1**：`agent-delegation-a2a` 已写明「出站 depth = 本站入站 depth + 1」，但调用点
  `server/cron-runner.js:991` 恒写 `depth: 1`，且**该行注释自陈**「chains get +1 only when in-cell turns
  are themselves delegated, a future state」——即一个被明确记账的未实现项
  （`docs/multi-agent-collaboration-explore.md:157` 同记）。团队级端点一上线，房间 → 团队 → 岗位就是两跳，
  环路界当天失效——**这条在本 change 内实现，不推到二期**。
- **不改**：既有 `a2a-agent-serving` 的按 role 部署语义、AgentCard 默认派生、计费键铸造；
  registry 的 path/kind 结构；`zhiyu-room` 的回合路由与邀请握手；团队内部编排与派发。

## Capabilities

### New Capabilities

- `agent-team-serving`: 团队级 a2a 服务契约——端点与协议形状、路由岗职责、调用方身份解析与授权判定、
  配额扣减与触顶语义、长任务回投、跨团队内容按不可信内容处理的安全约束、错误码封闭集、
  以及「一期入口在网关内、二期换入口不改服务端」的契约稳定性要求。

### Modified Capabilities

（无。深度逐跳 +1 是 `agent-delegation-a2a` 既有要求的实现补齐，不是行为变更；其余能力零改。）

## Impact

- **server（服务方）**：新增 `server/team-serving.js`（端点、JSON-RPC 分发、路由岗解析、配额扣减、
  错误码封闭集）；`server/team-card.js` 增 `reception` 字段的读取与校验（路由岗必须存在且是对外岗）；
  `server/routes/team-cards.js` 增批准/撤销批准的端点（`listed` 的批准）。
- **gateway（入口）**：`gateway/team-directory.js` 增 a2a 路由转发（一期把 `POST /api/teams/:cellId/:handle/a2a`
  原样代理到目标 cell，鉴权在网关解析调用者身份并以既有内部身份头转发），并保证不与目录 GET 路由冲突。
- **调用方身份**：新增 `server/caller-identity.js`（适配器注册表 + 会话适配器）；缺失/无效身份一律
  返回 `unauthorized` 结构化错误，无任何回落分支。
- **深度**：`server/cron-runner.js:971-991` 与 `:2042` 的出站 depth 改为「本站入站 depth + 1」；
  入站 depth 由 `agent-runner/a2a.js:126-134` 已解析并下传，本轮把它贯通到委托调用点。
- **web**：目录卡片增「调用」入口（`open` 直接可调、`listed` 走申请批准），调动面展示配额余量与
  错误码的可读文案；驾驶舱增「待批准调用」队列。
- **测试**：新增 `scripts/test-team-serving-a2a.mjs`（协议形状/错误码/配额矩阵）、
  `scripts/test-delegation-depth-hop.mjs`（两跳链被界拒绝、单跳放行）；
  既有 `a2a-agent-serving` 与 delegation 套件零扰动。
- **兼容性**：无新 env（配额与白名单在库）；未发布或 `private` 的团队端点与不存在同形；
  老 cell 无此端点时网关返回 `not_serving` 而非 500。
