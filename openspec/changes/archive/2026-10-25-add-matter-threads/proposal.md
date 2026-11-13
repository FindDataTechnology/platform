# add-matter-threads

> 2026-10-25 agents-native 沟通愿景的第二块砖（第一块=分身，已收口）。愿景原话：「大家基于
> 一些核心的事项进行交流沟通……预约真人交流，或者直接让 ai 自己交流」。分身解决了「地址」；
> 事项串解决「锚点」——跨方沟通围绕一个耐久、可引用、有状态的对象展开，而不是散在对话里。

## Why

分身接待今天有一个结构性断口：人设纪律要求它对价格、合同、对外承诺**一律不答、指给
分身主人**——但「指给」只是嘴上一句话。访客的真问题落在对话记录里，主人看不见、找不回、
没法回应；「预约真人」这个愿景里的 escalation 出口实际不存在。事项串 v1 就是把这个出口
建成结构化的：接待开一个**事项**（带访客的问题与上下文），事项落进主人的队列，主人回应/
关闭，访客下次对话时接待能如实读出进展。三方闭环，全部走既有面（对话车道零改动）。

## What Changes

- **新对象：事项（matter）**。归属一个分身部署；字段：不可预测 id（`mt_…`）、所属
  pack/agent、访客线索（v1=会话线索+对话中自述，如实局限）、事项摘要、时间线
  （开串/回应/关闭各一条）、状态（待回应 → 已回应 → 已关闭）。
- **接待工具面**：facade 部署的 serving child 经 overlay（循 notify/questions 先例）获得
  `matter_open` / `matter_status` / `matter_read` 三工具；child 只报事件，策略与出站全在
  runner——开串即 piggyback 既有 bot_notify（有绑定则主人即时得推送）。
- **主人队列**：包详情的分身面板下新增事项区——待回应清单、回应（追加时间线）、关闭。
- **平台路由**：facet internal 路由（服务凭据，host-settle 同型）承接 runner 侧开串/
  读状态；主人路由（登录态）承接队列与回应。

## Non-Goals

- 访客侧专属事项视图/推送（fd-wanxing 改动）——v1 访客体验=对话式经接待读状态；v2 再议。
- 事项串跨多分身/跨方共享、访客身份强认证（披露边界另案）。
- A2A 车道的事项（调用者侧）——v1 只做对话车道的 escalation。

## Impact

- 代码：`gateway`（matters 表+internal/主人路由）、`agent-runner`（matters overlay+执行器
  +notify 搭车，descriptor.facade 门控）、`web`（包详情事项区）、五语言、单测/e2e。
- 规格：新 capability `matter-threads`。
