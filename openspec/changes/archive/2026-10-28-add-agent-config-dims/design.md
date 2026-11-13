# Design: add-agent-config-dims

## Context

- 模型已有五层解析链(`fleet-model.js#resolveModelChain`):post → post-fallback → fleet-default → cell-default,纯函数、可单测、write-time 与 turn-time 同一份判据。
- effort 今天只有一个存储位:`llm.effort.<provider>` 偏好表,由 `dsh-profile.js#writeLlmProfile` 投影成每条 route 的 `reasoning`。注释事实(`dsh-profile.js:232`):**dsh 按 provider 读 effort,不按 model** —— 因此"每 agent 一个 effort"不能靠改 profile 实现(同 provider 的多个 agent 会互相覆盖)。
- live 路径已存在:`dshBridge.setModel({ provider, model, effort })` 通过 model/set RPC 生效,**不重启子进程**(`agent-session.js` 的 switchEffort/switchModel live 分支已在用)。
- context 今天只有模型声明里的 `contextWindow`(家族硬编码只读),dsh 无修改接口。

## Goals / Non-Goals

**Goals:** 两维可声明、可解析、可生效、可在检查器里改;缺声明时与现状逐字节等价。

**Non-Goals:** 不改模型真相;不做 per-agent provider 路由;不做自动摘要/滑动窗口;不做模板分发(属列车 B/C)。

## Decisions

### D1 · effort 只做「声明 + 回合级 live 生效」,不写 profile

新增列 `fleet_members.effort`(可空字符串)。回合开始时:解析生效 effort → 若与当前 runtime effort 不同,调 `dshBridge.setModel({ provider, model, effort })`(live,不重启) → 回合结束不还原(下一个回合各自按自己的声明切)。

备选:把 agent effort 写进 profile 的多条 route —— **否**,dsh 按 provider 读,同 provider 多 agent 必冲突。
备选:每次切换都 restart —— **否**,代价是分钟级停机,与 live 路径冲突。

### D2 · effort 解析链与模型链同形,不合并实现

独立纯函数 `resolveAgentEffort({ agentEffort, fleetEffort, cellEffort, model }):
- 依次取第一个「非空且被该模型 `reasoningEfforts` 支持」的值;
- 全部不支持/未声明 → 返回 `{ effort: null, notices: [...] }`,由调用方决定回落到 provider 全局值(`setModel` 传 null 即不加 effort 字段);
- notices 与模型链的 notices 同风格(声明了但不可用才报,继承不报)。

不合并进 `resolveModelChain`:两者判据不同(模型判"在 roster 里",effort 判"该模型支持该档"),合并会让一个纯函数承担两种语义。

### D3 · 上下文做「使用上限」,在回合收口判定

新增列 `fleet_members.context_budget`(可空整数)。语义:该 agent 单回合允许消耗的上下文 token 上限。判定点在**回合收口的 usage 落地处**(`fleet-events.js` 的 shaping 之后、写行之前):

- usage 可用且总量 > budget → status 记 failed,errorKind 新枚举值 `context_budget`,error 文案含实际用量与上限;
- usage 不可用(provider 没报) → **不判**(没有依据就不冤枉,继续保持诚实缺失语义);
- 不在流式过程中硬中断(那需要 runtime 侧支持,本刀不做)。

备选:在 prompt 前预检 token 数 —— **否**,需 tokenizer 且与模型对齐,成本高于收益;事后判定已能给出可行动的信号。

### D4 · 解析链顺序沿用现有覆盖语义

agent 声明 > 舰队默认 > cell 默认。fleet 级同样增两列(`fleets.effort`, `fleets.context_budget`),使"给整支舰队设一个 effort"成为可能,与 default_model 同层。

### D5 · 写面校验复用既有形状守卫

effort:必须是字符串且在**任意**已知模型的 `reasoningEfforts` 并集内(否则 400,文案提示可选值);空串/null = 清除声明。
context_budget:正整数且 ≥ 1024(低于此无意义)且 ≤ 模型家族最大值;非法 400。

### D6 · 前端只加两个控件,不加新页面

检查器配置页签在模型输入旁:effort 下拉(选项=当前生效模型支持的档;模型不支持则不渲染该控件)、context 数字输入(空=不限)。bot 页同。i18n 五语言各两键 + 错误文案一键。

## Risks

- [live setModel 在回合起点引入额外 RPC 延迟] → 仅当生效值变化时才调;同值跳过(与 `switchEffortToInner` 的 early-return 同判)。
- [同一 cell 并发回合争用 runtime effort] → 现有架构本就串行(单共享 child),回合排队语义不变;此处不引入新并发。
- [context_budget 事后判定给不出早期警告] → 本刀的定位是"如实记失败并可查",早期预算告警属后续。
- [provider 不报 usage 时预算形同虚设] → 明确记录在案:无 usage 不判,不虚构。

## Migration

纯增量两表各二列(可空),老行读 null = 未声明 = 现状。回滚零 down-migration。
