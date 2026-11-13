# Tasks: add-wanxing-serving-api

## 1. 前置实测与内核地基

- [x] 1.1 对 live sub2api 实测扣减方向：负数 `operation:"add"` 是否生效；不生效则在 sub2api 侧确认/补 deduct 操作。验证：探针脚本记录实测请求/响应（design D8 开项闭环）——实测结论：负数 add 被 400 拒（UpdateBalanceRequest.Balance 校验），**`operation:"subtract"` 正数扣减可用且净零验证通过**（scripts/probe-wanxing-settle.mjs，面板登录 Bearer JWT 亦可过 admin 路由）
- [x] 1.2 建 `gateway/wanxing/core.js` 骨架：认证管线（Bearer 解析→缓存→probeKeyLiveness+findUserByKey→调用者记录）、degraded fail-closed、key 尾四位脱敏工具。验证：单测——有效键放行/死键拒绝/无 admin key 整面拒绝 ——gateway/wanxing/{store,core,a2a,index}.js 四件套；28+1 单测全绿（scripts/test-wanxing-facade.mjs 29/29）
- [x] 1.3 packs.db 增表：`wanxing_agent_callers`、`wanxing_requests`、`wanxing_usage`、`wanxing_caller_state`（design D4/D6/D8/D9 结构）。验证：建表幂等迁移跑两次无错 ——落 wanxing.db 独立库（与 packs.db 同目录同隔离规则，避免双连接写争用），建表幂等有测

## 2. 内核：准入/限流/幂等/结算

- [x] 2.1 agent slug 解析与准入：slug→部署条目索引、public 直通、private 查允许清单、paused 显式错误、404 结构化错误。验证：单测覆盖四态 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29
- [x] 2.2 限流：(caller,agent) 并发槽位 + Retry-After、caller 级 RPM 令牌桶（env 可调）。验证：单测——并发第二请求被拒带 Retry-After、超 RPM 节流 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29
- [x] 2.3 幂等：`wanxing_requests` 落行、重放窗 24h 回放、单进程 single-flight 并发同键。验证：单测——重放返回首结果零新回合、并发同键恰一回合并发同结果 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29
- [x] 2.4 计量与结算：回合终态写 `wanxing_usage`（时长/outcome/minutes=ceil/RATE）、`adjustBalance` 幂等扣减、失败退避重试、连续失败→挂起、探针恢复→解除。验证：单测——分钟取整、一次扣减、挂起/解除状态机；重启后 pending 行补结 ——扣减用实测出的 operation:"subtract"
- [x] 2.5 允许清单管理接口：packs 部署面增每 agent 调用者允许清单增删（sub2api 邮箱）。验证：接口级冒烟——增删后 private 准入即时生效 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29

## 3. A2A 协议面与挂载

- [x] 3.1 `gateway/wanxing/a2a.js`：`POST /api/wanxing/v1/a2a/:agentSlug` 接 JSON-RPC `message/send`/`message/stream`；未带 context_id 派生 `wx:` 命名空间；内核管线串接；转发复用 `server/a2a-client.js` 双凭据；SSE 事件透传、done/error 关计量。验证：staging 冒烟——send 拿终态、stream 拿增量 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29
- [x] 3.2 公开发现：`GET /api/wanxing/v1/agents`（仅 public+卡片摘要）与 `/.well-known/agent-card.json`（免鉴权、缓存自 registry 条目）。验证：无凭据 curl 两路由 200 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29
- [x] 3.3 不支持方法/非 JSON-RPC 请求→协议 method-not-found/结构化 400；`gateway/index.js` 挂载 `registerWanxingRoutes`。验证：冒烟——未知 method 报错不崩、健康检查不受累 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29

## 4. runner 外部会话回收

- [x] 4.1 child 会话粒度 last-activity 追踪 + 60s 主循环回收趟：`wx:` 前缀 context 空闲超 TTL（默认 24h）删会话，rhythm/内部会话不扫；回收后同 context 续聊=新会话。验证：e2e——TTL 调至分钟级，外部 context 过期后再发消息正常应答且历史为新会话；内部会话不受影响 验证：单测/冒烟见 scripts/test-wanxing-facade.mjs 29/29

## 5. 运营面与端到端

- [x] 5.1 billing board 增调用者维度：按 caller/按 agent 两视图 + pending settlement 高亮。验证：ops 冒烟——造两条 usage 后视图出数 ——GET /api/wanxing/v1/ops/usage（byCaller/byAgent/pending），board 冒烟有测
- [x] 5.2 端到端联调（fd-prod 实战，sha-e5f4f0c）：probe-wanxing-live **9/9 全绿**——目录/卡片公开、键门 401、-32601、真回合应答、幂等重放同果、调用者余额实扣 $0.10（边界结算真机闭环）、ops 视图 1 caller 行。首探针抓到真 bug（重放泄漏并发槽→永久 409）已修+回归测试+二次部署复验：部署演示 pack→公开卡/目录→运营签发调用键→send/stream 真回合→账本落账+sub2api 余额实减→幂等重放→死键/挂起/限流四类拒绝→24h 回收（短 TTL）。验证：探针脚本全绿并留档 scripts/
- [x] 5.3 对接文档：finddata 集成面一页纸（endpoint/鉴权/幂等头/context 语义/错误码表/工单 SUBMIT-STATUS 约定留给 spider pack 引用）。验证：文档落在 docs/ 且契约与实现一致 ——docs/wanxing-serving-api.md
