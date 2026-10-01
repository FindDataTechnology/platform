# Agent 服务跑在多租户 agent-runner 里，registry 是运行时单一分发面

角色要能按服务契约（A2A 协议）部署为独立的常驻对话服务，而 cell 内共享 dsh 运行时同一时刻只有一个 active persona，无法同时对外服务多个角色；因此新建一个多租户 agent-runner（每个已部署角色一个专用 dsh 子进程，复用 dsh-profile 组合机器，空闲休眠），而不是从平台网关对外转发（会撞共享运行时天花板）或每角色一个 k8s 部署（N 倍内存与部署仪式，与资源优化方向相反）。bundle 分发选 registry 为运行时源（custom entity + a2a agent 条目）：runner 运行时只认 registry 一个 API、与 paas 解耦、外部世界可发现；pack marketplace 退居创作/订阅前端，"部署"动作把 bundle 推进 registry 并通知 runner。

## Considered Options

- 平台网关直接对外服务 A2A：改动最小，但外部流量与用户会话抢同一个 dsh 子进程，且单 active persona 语义与之根本冲突。
- 每角色一个 k8s 部署（GitOps per agent）：隔离最彻底，但内存 N 倍、部署仪式 N 倍，生产节点 4GB 有 OOM 前科。
- runner 直拉 packs.db（marketplace 为源）：少一次推送，但 runner 需要接入 paas 用户鉴权体系取服务凭证，且 bundle 对外部不可见，paas 成为隐性单点。
