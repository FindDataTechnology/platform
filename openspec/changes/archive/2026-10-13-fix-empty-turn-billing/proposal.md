# Proposal: fix-empty-turn-billing — 空返回合采集器识别（免单收口）

## Why

挂账②（selfhost-funnel-case 坑 ②）的最后一项：**模型失败的「静默空返」回合照常计费**。
当模型在 dsh 内失败但从不发出 finish-error chunk（典型：UNKNOWN_MODEL 类模型解析失败——
过车道门但不在 dsh 花名册），dsh 会话照常转 idle，采集器（agent-runner/child.js）以
`settle(true, {text:"", usage:null})` 成功结算：

- 计量行记 `ok:true`（生产实测 700/700 ok:true 行 tokens 全 null——usage 在本 dsh 版本
  从不上报，null-usage 不构成判别式，唯一诚实判别式是**零 assistant 文本**）；
- A2A 适配层返回 `result: assistantMessage(ctx, "")`——**成功形状的空回复**；
- facade 侧只看 JSON-RPC error 对象（fix-error-turn-billing 已上线），空 result 被判
  `outcome:ok` → **照常计费+分成**，且调用者收到的是无声空返。

部署门+配置门（add-deploy-roster-gate / add-config-roster-gate）已封住**新增**暴露面
（新部署/新配置写不再能选到不在册模型），本片封住**残余语义面**：任何来源的零输出回合
一律按失败结算，端到端免单。

## What Changes

- **agent-runner/child.js（采集器语义，唯一代码改动面）**：`session.status=idle` 结算时，
  若本回合未收集到任何 assistant 文本（finalText 空白），settle(false)——结构化错误
  `code:-32005`（"turn ended without any assistant output"），与 -32003（LLM 请求已
  自报失败）区分以便排障归因。
- **零改动的下游（既有语义自动接管）**：
  - manager.turn 的 catch 记计量行 `ok:false` + turn_ended 事件 `outcome:"error"`；
  - a2a.js 对 message/send 返回 JSON-RPC error（HTTP 200）、对 message/stream 发
    `event: error`；
  - facade（fd-wanxing，已上线）按 JSON-RPC error 判 `outcome:error` → **waived/0 分钟/
    零分成**；
  - rhythm self-turn / rollover digest 同走该纪律（它们已有 -32003 抛错存活路径，
    生产 503/429 行实证，scheduler 无楔死）。

## Impact

- **受影响 spec**：agent-runner（ADDED 一条需求：零输出回合按失败结算）。
- **受影响代码**：agent-runner/child.js 单文件（idle 结算分支）；测试两处
  （scripts/test-agent-runner.mjs 采集器用例 + a2a 空回合→JSON-RPC error 回归）。
- **不受影响**：计量行 schema（沿用 ok/error 字段）、fleet 事件 schema（outcome 枚举
  既有 error）、facade/网关/registry 全部零改动。
- **风险**：极端假阳性——某回合真实发生但全程零文本（纯工具调用无最终文本）。按
  caller-pays 公平性（无交付=不收费），免单是诚实取向；平台自担上游成本，与错回合
  豁免同一既定政策（ADR-0022 负保护）。
