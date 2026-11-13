# 萬星对外面是平台门面：调用键即 API key，钱在边界结算

首个对外产品案例（finddata 爬虫自愈 agent，外部账号按需调用）把「外部怎么进门、谁付费」逼到台前。现状入口是 registry 网关双凭据（registry 凭据 + 全部署共享的 backend token）——共享密钥交不出去，也无按调用者计量，ADR-0011 的 day-one「部署者全包」对外卖不动。决策四条：①对外唯一入口是平台自有的萬星门面，协议无关内核（认证/鉴权/限流/幂等/计量/结算）+ 可插拔协议面，v1 面 = A2A 原生（JSON-RPC message/send|stream + `/.well-known/agent-card.json` + 公开目录）；registry 保持纯内部，内部调用者（网页聊天/委派）走原路双轨。②调用者凭自有 sub2api key 进门：验钥复用零成本探针（GET /v1/models 本就跑完整计费门）+ findUserByKey 解身份；调用键止步门面。③边界结算：agent 始终跑部署键，门面按（调用者, agent, 请求, 时长）计量、回合结束即时向调用键结算（v1 用 adjustBalance+幂等头，门面账本为权威，sub2api 补虚拟用量端点后切换）；套餐价目表在平台侧，sub2api 只管账本与硬顶（余额/key 消费窗）——它管钱，不管生意。④回合预算硬停：dsh 无中断 RPC，超预算即杀 child 重生，agent 跨回合真状态一律落文件。

## Considered Options

- registry fork 原生接受调用键（auth-server 学会 sub2api）：入口虽统一，但 registry 的组/可见性机制被迫耦合计费身份，fork 面扩大伤上游同步（PR #1791 的关系）。否决——registry 不参与对外。
- 逐回合换钥 passthrough（0011 曾列的换钥代理 v2 思路同族）：调用者 group 未授权 agent 模型车道时回合半路 403（组绑定坑，2026-10-01 实录）；child 凭据文件全局单份，并发回合串钥。否决。
- REST 薄包装为 v1 对外面：与 a2a 原生形成双契约双维护；萬星是长期独立平台，day one 直接说开放协议。REST 等真有客户要再加，纯增量。
- 软预算（超时只释放调用者、回合自然烧完）：对会跑 bash 循环的 agent 是无上界消耗。否决。

## Consequences

- dsh 若有朝一日提供中断 RPC，硬停应降级为优雅停——本 ADR 不视硬停为终态。
- 内外双轨长期并存：同一 agent，内部调用=部署者全包，外部调用=按量结算；统一是后续增量。
- sub2api backlog 随本决策落地：虚拟用量端点、按 key 自助用量查询；调用键签发 v0.2.x 无 admin 造键，走用户面板自铸回交。
- 外部会话=每请求独立 context + 24h 空闲回收（runner 小改）；「跨请求状态在文件、会话只载单次交互」自此成为 pack 作者的既定范式（inbox 模式）。
- 下一协议面（最可能 OpenAI 兼容：把 agent 当模型卖）纯增量可加；约束：内核不得感知任何协议细节。
- 试点形态：萬星运营号自营部署、finddata 作首个调用者；部署者=运营（驻留与自主回合成本），调用者=客户（被叫回合约量结算）。
