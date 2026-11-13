## Why

萬星·智语一期把房间关在了站内。接待台（客服）是平台已售的拳头场景（crm-desk/Chatwoot 线），而开源界没有任何产品做到「托管接待 widget：站点访客与商家的分身/服务智能体同房共话，随时召唤真人接管」——智语内核恰好备齐了全部零件。二期把房间从站内开出一扇**第三方网站门**，成为接待台 2.0；并顺带把同一机制弱化为「授权链接进房」。商业账不走新轴：guest 触发的应答全计 host（商家部署）的账，闸=一期已立的房间日预算 + 应答上限。

## What Changes

- 新入住席类别 **guest**：商家在房间设置里开启嵌入（**domain 白名单必填**），获得 snippet（`<script src=…/widget.js data-room-token=…>`）；站点访客经 iframe 进入房间，读自己的历史窗口（join_from），以人类消息的回合协议点名/广播与商户在场的分身·服务智能体对话。
- 游客身份为**每访客一个 guest 席位**续访续话（cookie SameSite=None;Secure 与 URL 令牌双轨，Safari ITP 可回退）；宿主可经 HMAC `identify(email, sig)` 把 guest 席位升级并轨为登录成员（HMAC 链与 desk-embed 同款）。
- guest 参与规则收紧：只可发消息与点名、只读加入后共享历史、无邀请/移除/私窗权限；其消息**作为人类触发**走一期回合路由与熔断三件套（@定向/广播可过/回复不连环/上限）。
- 计费：guest 触发应答按座位部署**各记各的部署键**（usage_id 后缀 guest scope 可追）；房间日预算闸与应答上限同样生效。
- 滥用防线：widget 加载与消息的**双向限速**；房间级 widget 令牌一键吊销；iframe 路由按房间动态放行 `frame-ancestors`，白名单外拒绝同指。
- **BREAKING（温和）**：`zhiyu-room` 的「在席成员」从三类扩为四类（新增 guest）——既有三类的行为零变化。

## Capabilities

### New Capabilities

- `zhiyu-widget`: 托管接待嵌入面——embed 开关与令牌/descriptor、公共 widget 资源与动态 CSP、游客铸币与 identify 升级、限速吊销、计费归属、授权链接进房弱档、空间设置里的嵌入对话框。

### Modified Capabilities

- `zhiyu-room`: 「在席成员与邀请握手」加入 guest 类别与升级并轨规则；「无权者不可见」扩到 guest 令牌鉴权；「计费与配额挂钩」指明 guest 触发的计费挂靠座位部署键并沿用房间日预算。

## Impact

- gateway/zhiyu 新增 `guest-auth.js`（铸币/identify/吊销）与 `widget.js`（公共资源+动态 CSP+限速）；客房设置面板加嵌入对话框；SPA 加 `/zhiyu/embed/:token` 精简壳复用房间视图；清一色服务端与前端新增，**cell 与不变量零触碰**。
- 既有路线：dmains allowlist 存房间行；widget 令牌存 store 新表（可吊销、限速窗口）；usage 键式延续 `zyr-…-guest:<seatId>`。
- 台账：发布后更新 `docs/registry-maintenance.md`（§1 运行表+§9/§15 发布记录）。二期出片走与一期同一镜像链与四面滚纪律。
