# add-caller-preferences

## Why

调用者今天对 Agent 服务没有任何个人化入口：除了换套餐/换键，异步 agent 干完活只能轮询结果，外部 context 的收割窗也只有一个全局值。探索定案（2026-10-07 拷问，[[agent-service-config]] 姊妹篇）：调用者偏好（Caller Preference，词条已入 CONTEXT.md）以回合完成回调为主打维度——它是唯一改变产品能力大小的项；模型车道明确不做（计费按时长结算，车道归套餐策划，不归调用者）。

## What Changes

- 新增**调用者偏好**层：调用者对某 Agent 服务的个人化定制，v1 维度 = **回合完成回调**（被叫回合结束后 facade 发签名 webhook，URL+密钥存偏好）+ **上下文收割窗**（外部 context 空闲多久被收割，默认回落平台全局值）
- 偏好随调用键生效、止步门面：facade 是唯一同时看见调用者身份与回合完成的组件，回调与收割窗都在门面层或经门面传导生效
- 回调语义：尽力送达 + 有界重试（15 分钟窗内指数退避，至多 N 次），不保证 exactly-once——回调体带回合 trace_id 与 outcome，调用者幂等去重
- 收割窗传导：门面把生效 TTL 编进派生 context_id 的命名（`wx:` 前缀空间内下放 per-agent 生效值），runner 的既有 reap pass 按前缀解析生效——不新增传播通道
- **入口 = facet CLI `prefs` 子命令**（调用键即凭证，调用者的母语）；Web 调用者门户后置
- 明确不做：模型车道（归套餐演化）、呈现偏好（A2A 调用方是程序，语言格式 prompt 自理）

## Capabilities

### New Capabilities

- `caller-preferences`: 调用者偏好层完整行为——维度与读写面（CLI 经调用键认证）、回调的签名/送达/重试/幂等语义、收割窗的解析与回落

### Modified Capabilities

- `wanxing-facade`: 「外部流量按调用者与 agent 限界」requirement 变化——上下文收割从全局单值变为“调用者偏好 → 平台默认”的解析值；「计量与边界结算」requirement 变化——被叫回合的完成事件除计量外可选触发签名回调（不改变结算语义）

## Impact

- **facade（fd-wanxing 仓）**：store 增偏好表（caller 维度 × agent 维度的回调配置与收割窗）；a2a 被叫回合结束点挂回调派发；contextIdFor 派生时编入收割窗；新 prefs 端点（调用键认证——门面已有的 caller 身份解析复用）
- **runner（paas 仓）**：reap pass 从“全局 TTL + wx: 前缀”升级为“按会话名解析生效 TTL”——解析函数共享定义（一处，两仓锁步纪律如 slugFor）
- **CLI（paas facet/cli）**：`facet prefs <agent-slug> [--callback-url URL --callback-secret S | --reap-minutes N | --clear key]`，`--key sk-…` 传调用键
- **测试**：fd-wanxing 单测（偏好门/回调签名重试幂等/收割窗解析）；paas runner 单测（TTL 解析）；e2e fast lane（prefs CLI 面形状 + stub 回调接收）
- 词条「调用者偏好」已先行入 CONTEXT.md；不触碰计费语义（ADR-0014 不变）