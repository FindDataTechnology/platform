# 计费面挂在 sub2api：每个已部署 Agent 服务一把 key，部署者预充值、欠费即停

平台不自建计费服务：复用集群内已部署的 sub2api（用户余额 + 自助充值 + key 级额度与消费窗口）。映射为——部署者 = sub2api 用户（预充值余额），每个已部署 Agent 服务 = 其名下一把 API key（runner 组装子进程时注入），额度耗尽即回合优雅失败（agent「停机」，不删数据）。Day one 计费模型为「部署者全包」：别人聊这个 agent、别的 agent 委派它，烧的都是部署者的 key；防薅靠 key 级 5h/日/7d 消费窗口 + 限速 + registry `invoke_agent` 调用门三层兜底。

## Considered Options

- 纯净「发起方付费」（A 委派 B 扣 A 侧、人类聊天扣聊天用户）：dsh 子进程在组装时定死 LLM key，按回合换 key 需要 runner 侧换钥代理（LLM_BASE_URL 指向 runner 代理按发起方换上游 key）——中等工程量，列为 v2 路径，day one 不上。
- 驻留租金（按 agent·时间收租）：sub2api 只计量 token 不计量进程驻留，租金需平台侧另立账本；day one 用平台容量上限（500 agent）替代，容量吃紧再上租金。
- 平台自建计费账本：第一天就养一个计费服务，与 sub2api 已有能力（余额/充值/按 key 计量）全部重复。否决。

## Consequences

- 公开平台的失败请求形态会持续触发 sub2api 的上游账号健康下线逻辑（2026-09-30 事故），平台 agent 必须划独立上游账号池，与现有共享池隔离。
- sub2api 尚无按 key 的自助用量查询端点（上游 issue #6421），平台用量面板 day one 走 admin API，需对本机实例实测能力边界。
- 驻留租金免收意味着容量上限是唯一驻留成本闸门，扩容决策前必须先实测单 child 常驻内存。
