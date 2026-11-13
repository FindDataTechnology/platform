# Tasks: add-agent-notifications

## 1. 绑定与描述符

- [x] 1.1 `gateway/packs.js` + `lib/agent-serving.js`：deploy 请求 `notifyChannel`（per agent，string|null）录入与描述符 `notify_channel`（省略=保留、null=解绑，同 rhythms 语义）。验证：单测三态落描述符

## 2. bridge 能力与转发

- [x] 2.1 `agent-runner/compose.js` bridge 行增 `bot_notify` 面（event/text/channel?）；handler 以宿主身份转发 `POST {relayUrl}`（`AGENT_RUNNER_RELAY_URL/TOKEN` env，token 不进 child）；未配置 token/未绑通道/显式通道≠绑定 → 结构化拒绝。验证：单测——绑定投递/三拒绝形状/token 不出现在 spawn spec
- [x] 2.2 per-agent 限流（默认 6/min，env 可调）+ runner 侧审计行（agent/channel/outcome/textLen）。验证：单测——第 7 次/分钟被拒且无外发

## 3. 端到端与文档

- [x] 3.1 staging e2e（fd-prod+cheap1 runner 实跑，scripts/probe-agent-notify-live.mjs 全绿）：绑定回合投递（child 收据+runner 审计 sent+平台 relay 审计 sent 三方实锤）/7 次超限 runner 侧拒发零外发/v2 解绑后拒绝指名缺绑定；前置全通——gateway relay 机器路由(14c76d4)+BOTS_RELAY_TOKEN/OWNER 入 GitOps+test-channel 绑定+runner 容器重建(env-file 只在创建时生效的坑)
- [x] 3.2 文档：DEPLOY.md 通知段（绑定形状/relay env/四类事件为 pack 作者示例）。验证：文段与 spec 一致
