## Context

一期已落成：gateway/zhiyu 内核（五表/路由/router/agent-lane/SSE）、四类成员模型缺 guest、计费/settleTurn/预算闸、站内 UI。本仓内有三个参照系直接可借：`gateway/share.js` 的**令牌注册表**（128bit+吊销+限速+过期半透明）、`server/session.js` 的 `signEmbedToken/verifyEmbedToken`（**desk-embed 在产的 HMAC 身份链**）、gateway 静态供给（web/dist + SPA fallback，widget.js 与 embed 路由需在其前插条）。二期不碰 cell 与 1:1 会话；所有 guest 流量在 gateway 层结束鉴权，房间协议内部可见仍是现行回合路由。

## Goals / Non-Goals

**Goals:**

- 商家在一个流程里拿到可贴的 snippet；访客在第三方站点以 guest 席位与商户分身同房对话（接待台 2.0），可由 HMAC identify 升级；host 付钱且有闸；
- 白名单外嵌框被浏览器拒绝（不是我们提示的「拒绝」——平台主动下发的 CSP）；
- 治理件完整（吊销/限速/计费归属/banner 明示 guest 身份）。

**Non-Goals:**

- IM 群桥/外部 A2A 入席（三期）、LLM 自动纪要车道、非中文 locales 真翻、浏览器级双用户 playwright 拓扑、guest 跨设备账户合并（identify 已是单行并轨）；
- guest 使用工具/资源/KB 的 mount 策略（二期 guest 一律不挂载，纯对话）。

## Decisions

### D-A：guest 是**席位**不是会话（成员模型站台而非新对话建模）

zy_room_members 加 `kind='guest'`；ref = 平台自签访客代号（如 `g_3f2a…`，PII-free），display 初始化为「访客 · <host前缀> + 短号」。续访找同一个 ref ⇒ 会话自然接续。**备选（临时会话池）被拒绝**：待办/事项/计费续访没有落点，接待台语义破裂。

### D-B：令牌三件套分面：widget 令牌（装载面）/ zy_guest（身份面）/ site-secret（声明面）

- widget 令牌 `wtr_<id>.<sec>`：与 (roomId, domainAllowlist) 绑定，id 直查+sec 哈希比对（**不持久化明文**），吊销即亡；装载器与 embed 页一律携此令牌鉴权；
- guest 令牌放 `zy_guest=<sig>` cookie（`SameSite=None; Secure`）+ URL `tty` 兜底（ITP/旧 WebView）；令牌内容仅 {roomId, ref, exp, nonce} 的 HMAC 签名（复用 verifyEmbedToken 同款键 + 独立域盐）；
- site-secret `sk_<id>.<sec>` 每 widget 令牌伴随签发：identify 请求**直接出示 secret**（TLS 承载）+ts 短窗+一次性 nonce 防重放，服务端哈希比对后与 email/displayName 绑定升级——与 wtr 同强度的 bearer 模型，避开"服务器须持明文"的死结。

### D-C：计费回想为既有 settleTurn 且绝不新开结算轴

guest 触发前台应答走 settleTurn；`usage_id` 延续 `zyr-<roomId>-<seq>-<memberId>`（memberId 即 guest 席），host 部署键由既有部署键解析链承担。**预算闸不变**，超限=如实事件（budget_exhausted），不做 guest 单点另行封禁（那=多级闸，一期设计已拒绝）。

### D-D：动态 CSP 与装载器拆分：widget.js 静态、embed/:token 动态头

`GET /zhiyu/widget.js`：cacheable ESM（模块自产，不经 web/dist），职责=读 data-room 令牌→向 `GET /zhiyu/widget/meta?token=` 校验业面 host 在白名单→动态插 iframe→桥 `postMessage`（`open/close/toggle/identify/event hook`，`event.origin` 校验放行己方域）；`GET /zhiyu/embed/:token`：gateway 路由——按令牌行查白名单 → `Content-Security-Policy: frame-ancestors 'self' <allowlist>` → 回 SPA 精简壳 HTML。**网关全局 fallback 的正则必须新增排除 `/zhiyu` 前缀**（它现在吞一切非 api/ 路径，晚注册的模块拿不到 embed 与 loader）。Web 前端加 `/zhiyu/embed/:token` 精简路由（复用 ZhiyuRoomPage，`?embed=1` 关导航/站点式 banner）。

### D-E：滥用闸两侧落地：限速与熔断同属不同维度

加载限速（每 IP/widget.min）+消息限速（每 guest 席/秒窗），用 share.js 的 createRateLimiter；超限 429 + 节流节文案；熔断沿用一期（关键差异：guest 触发上限与会话超限的如实呈现，不做永久禁言）。**审计面**：widget 令牌与 guest 席首张消息进审计行（谁、何时、哪个白名单），方便商家复盘。

## Risks / Trade-offs

- **访客量显大 → 成本与配额被吃到爆** → 日预算闸是底线（已有）；再加 host 级软提醒（预算 80% 通知主办），阈值与措辞 apply 期定；
- **第三方 cookie 被拦（ITP/WebView）** → URL `tty` 兜底接受能力损失（链接分享丢失续访身份，显示为新增席位——如实展示，不做隐式替身）；
- **HMAC site-secret 被泄露 → 冒名顶替客户** → secret 可轮换且每令牌一把，签名窗 5min+nonce 一次一验；泄露即吊销令牌重签；
- **widget.js 被宿主热链到任意白名单外域** → frame-ancestors 解决渲染层，API 按令牌+白名单再校验挂载 host（加载器在页运行时取 `location.host` 并要求其挂白名单，否则不注 iframe——双保险）；
- **guest 消息海啸（脚本刷刷）** → guest 席秒窗限速 + 房间日预算 + 全局加载限速三重，二期不做按模型自适应熔断（三期的 LLM 方案）。

## Migration Plan

纯增量：`zy_widget_tokens` 新表（令牌哈希+白名单 JSON+吊销位），`zy_room_members` 的 kind 枚举扩入 'guest'（兼容.Eval 老行）；`zy_rooms` 小 ALTER 加 `widget_allowlist` 列（CREATE IF NOT EXISTS + guarded ALTER 惯例，零破坏既有行）；前端加 embed 壳路由与设置对话框（nav 注册不变）；出厂 `ZHIYU_WIDGET` 开关默认关——滚版走查后开。回滚=关开关+吊销现行令牌，表留存。

## Open Questions

- widget 令牌的**生命周期**（永驻 or 默认一年+nudge 续期）——apply 期定，倾向永驻+可吊销；
- guest displayName 呈现（「访客 · A3F2」、宿主 identify 自定义、是否可自助改昵称一次）——apply 期定；
- 老 Chatwoot 商家**共存层**是否做个一键转接链接（到 widget 启动页）——apply 期调研用况再定（若很多商家仍要 Chatwoot，保留两条线）。
