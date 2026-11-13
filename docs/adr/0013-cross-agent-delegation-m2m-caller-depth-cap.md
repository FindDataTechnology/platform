# ADR-0013: 跨 agent 委派走 registry 网关，每 cell 一个 M2M 调用身份，深度上限断环

cell 里的角色委派市场 Agent 服务时，平台作为 A2A 客户端经 registry 网关路由调用（复用既有 a2a fork 的双凭证模型）；调用身份是**每 cell 自动开通的 registry M2M 服务账户**（挂仅含 `invoke_agent` 规则的 scope），而不是复用用户个人市场 token（上游没有替用户铸 token 的 API，且用户 token 默认带全量 scope、TTL 8h 不适合服务身份）。防环用**协议内深度头**：出站委派调用带 `X-Delegation-Depth`（人发起=1，每跳+1），runner 拒绝 depth≥3——跨请求环 3 跳内必断，不做全局环检测（复杂且阻塞）。

## Considered Options

- 复用 MARKET_REGISTRY_TOKEN（平台服务凭证）作调用身份：一证多 cell 无法归责/吊销，且该证是 admin 域（过权）。否决。
- 每用户个人 token：铸 token 需浏览器会话、无程序化路径；scope 过宽。否决。
- 全局环检测（调用图追踪）：阻塞式、跨请求状态复杂；深度上限以极小成本达到同等的断环保证。否决。

## Consequences

- ops 一次性前置：registry 建 `paas-agent-callers` scope（仅 `{agent:"*",actions:["invoke_agent"]}`）+ 组映射；本机实测现状仅 admin 域带 invoke_agent（2026-10-02 /api/export/scopes）。
- M2M 凭证是 cell 级长驻秘密，存储与轮换走 registry-credentials 同款面；泄漏的爆炸半径=仅能调 agent。
- 发现不进工具全量：`delegate_task` 描述只带分类摘要，`search_agents` 按需取——控制面 context 占用（grill Q8 决策）。

## 修订（2026-10-02，实施期实测）

「每 cell 一个 M2M」在本部署不可实现：`/api/management/iam/users/m2m` 依赖未部署的 IAM provider（返回 IAM provider error）；静态 token 面关闭；用户 token 为引用型（claims 无 scope/groups），Logto 用户在 registry 侧无组可映射 invoke scope。**Day-one 改为部署级服务凭证**（与人类 a2a 聊天同款，过 invoke 门），断环/限流安全不受影响；每 cell invoke-only 身份（归属与吊销）移入 ③ 凭证加固，候选：静态多 key（env+重启）或 Logto 组桥（用户 token 即身份）。已预建的 `paas-agent-callers` scope 留置待用。
