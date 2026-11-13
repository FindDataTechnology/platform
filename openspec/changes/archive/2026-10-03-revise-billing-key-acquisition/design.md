## Context

③ 的计费链已上线（余额门 402、两级发现、billing board），唯独 key 来源卡在身份死角：平台不持预存账户密码、上游无 admin 代铸（v0.2.x 全系核实），代铸路径静默降级。生产面板 OIDC 登录已全链路活（2026-10-02 验证），key 的真实来源只能是用户自己的面板会话。本片把 key 获取改为「按邮箱解析真实账户 + 用户粘贴」，其余链路（descriptor 引用、runner 取钥注入、计量）全部不动。

上游实证依据（Wei-Shaw/sub2api v0.2.13 main，2026-10-02 核对）：
- `GET /api/v1/admin/users?search=` 匹配 email/username/notes/**key 值子串**，响应含 email → 邮箱解析与 key 归属反查共用一个端点；
- `GET /v1/models`（Bearer sk-）模型列表本地构建、零上游调用、走完整计费门（余额>0/组/配额）→ 免费活性预检；
- OIDC：无同邮箱账户 + `email_verified=true` → fast-path 自动建号；同邮箱预存账户 → choice 屏要求本地密码绑定；邮箱未验证 → synthetic email（解析不到）；
- `PUT /api/v1/admin/users/:id` 实收 `password` 字段（旧判「无 admin 改密」是探针只试了 PATCH 的误判）。

实现起点：`git stash@{0}`（paste-flow 草稿，含 findUserByEmail 与部署块改造），**缺**活性/归属校验、agentId 白名单、同 key 去重、absent=keep 生命周期——本片补齐。

## Goals / Non-Goals

**Goals:**
- 零密码托管、零 sub2api 改动的前提下，让每个部署者能把**自己铸的** key 绑到 serving agent 上；
- 粘贴 key 的错误在部署当场暴露（形状/活性/归属/白名单四层），不留到生产回合；
- serving 部署必须有 key，堵住平台共享配额无门兜底；
- ③ 期间平台代建账户的存量死锁（choice 屏无密码）可清剿。

**Non-goals:**（proposal Non-goals 之外的设计层边界）
- 不动 deployment_keys 表结构与 runner 取钥路由（pk_ 引用与旧数字 id 引用同为不透明串，天然兼容）;
- 不做 key 元数据（额度/窗口）的平台侧读回——用户面板自管；
- 不为 degraded（无 admin key）模式实现任何粘贴语义——维持 pre-③ 无计费姿态，billingKeys 被忽略。

## Decisions

**D1 解析：admin search + 客户端精确匹配，映射行做缓存。** `findUserByEmail` 用 `users?search=<email>` 后按 `u.email === email` 精确过滤（search 是子串匹配，防误命中）。首次解析成功落 `sub2api_accounts` 行（email+user_id，无密码列写入）；`billing/me` 无行时现查并回填，供弹窗三态显示。备选「每次直查不落行」被否：弹窗打开即查、多一跳 admin 调用，且丢掉映射审计痕迹。

**D2 校验顺序：廉价在前，逐层短路。** shape（`^sk-`、≤256）→ agentId 白名单（当前 manifest 的 serving agents）→ 同 key 去重（本次请求内 + 与保留绑定比对）→ 活性（`GET {SUB2API_BASE_URL}/v1/models`，Bearer 该 key；失败即 `BILLING_KEY_INVALID/liveness`）→ 归属（`users?search=<key>` 反查持有人 id ≠ 解析出的 user_id 即拒，`reason:"ownership"`）。全部失败信息走结构化 code，错误串不含 key 材料。备选「只做形状」被否：typo/错主 key 拖到回合期 401/402 才暴露（拷问 Q2 定案）。

**D3 绑定生命周期：absent=保留 + 重验，null=受控解绑。** 重部署省略 `billingKeys` 时，服务端从 `deployment_keys` 取存量（pack+agent），把旧引用续写进新 descriptor，并对每个保留值重跑活性预检——死 key 当场 `BILLING_KEY_INVALID/liveness`，指引粘贴替换。显式 `null` 仅对非 serving agent 合法（清陈旧绑定）；serving agent 传 null → `BILLING_KEY_REQUIRED`。manifest 升级后不再 serving 的 agent，绑定随重部署删除。理由：key 值永不回显给客户端，用户无法重发旧值——absent=清除等于每次重部署强制销毁（拷问 Q3/Q9 定案）。

**D4 错误契约（结构化 code，i18n 按 code 走）。**
- `402 {code:"NO_SUB2API_ACCOUNT", panelUrl}` —— 无账户，先做（余额门之前）；
- `402 {code:"INSUFFICIENT_BALANCE", balance, floor}` —— 现有 402 加 code；
- `400 {code:"BILLING_KEY_REQUIRED"}` —— serving agent 无 key；
- `400 {code:"BILLING_KEY_INVALID", reason:"shape"|"unknown-agent"|"duplicate"|"liveness"|"ownership"}`。
无账户指引文案双分支：新用户（SSO 即建，fast-path 发注册余额）/ 预存账户（SSO 撞 choice 屏，输原面板密码一次）。

**D5 发现端点：扩展而非新建。** `GET /api/packs/billing/me` → `{linked, balance, accountState:"none"|"ok"}`（无映射行时 D1 现查）；新增 `GET /api/packs/:id/billing-bindings` → `{<agentId>: boolean}`，永不回显值。弹窗三态（无账户/有账户未绑/已绑）全靠这两个只读端点。

**D6 前端：新标签页 + 按 agent 粘贴框。** 面板 `X-Frame-Options: DENY` + `frame-ancestors 'none'`，连接按钮 `window.open(panelUrl)`。粘贴框按 serving agent 逐个渲染（多数 pack 仅一个）；已绑定态显示「已绑定（更换请粘贴新 key）」。五语 i18n 键按 D4 的 code 组织。

**D7 日志与回显卫生。** 部署路由不落 req.body（近期取证日志 cf6b3b3 的 first-40-bytes 模式不得波及此路由）；错误响应/日志只含 code+reason，不含 key 串；`deployment_keys.key_value` 明文存储与现状一致（平台 SQLite 库与 sub2api 自身可搜索存储同级）。

**D8 存量清理走 admin 改密，不走删号优先。** `PUT /api/v1/admin/users/:id {password}`（先在生产 fork 实测一次）改密后把新密码移交用户本人，用户用它在 choice 屏完成 SSO 绑定后自行改回——账户、余额、既有 key 全保留。删号+转账仅作用户失联时的兜底。同步 `UPDATE sub2api_accounts SET password=NULL`（列保留不 DROP，SQLite 版本兼容），停写 `sub2api_email`（cf6c311 列，遗留无害）。

## Risks / Trade-offs

- [生产 fork（FindDataRouter 换牌）与上游 v0.2.13 能力有漂移：search-by-key 或 PUT 改密缺失] → 上线门前实测两项（tasks 1.x）；search-by-key 缺失则归属校验不可用，属阻断项回炉重议，不做运行时降级开关。
- [Logto `email_verified` 不为 true → SSO 落 synthetic email → 邮箱解析死循环] → burn-in 真实 SSO 走查（tasks 验收段）；指引文案同时给出「面板手动注册同邮箱」逃生口。
- [粘贴流摩擦导致部署转化下降] → 接受（拷问 Q5 定案）：上游 PR 免粘贴优先，被拒则评估自维护 admin-mint 补丁；NEVER 回到密码托管。
- [活性预检为部署加 2×serving-agents 个请求] → 可忽略；`/v1/models` 本地构建、无上游调用。
- [用户在面板删 key 后部署持续 401] → Non-goal（轮换提醒延后）；重部署时活性预检已覆盖主动发现路径。

## Migration Plan

1. **上线门（滚动前）**：生产 fork 实测 `PUT /users/:id` password 与 `search=<key>`；真实 SSO 走查（email_verified）；清点 `sub2api_accounts` 密码非空行。
2. **发布**：单轮平台镜像滚动，sub2api 零动作。stash 草稿 pop 后按 D2/D3 补齐再提交（cf6c311 撤销随本提交）。
3. **上线后**：D8 存量清理（改密移交/兜底删号转账 + 密码列清空）；billing/me 三态与 billing-bindings 冒烟；`scripts/test-platform-billing.mjs` 全量绿。
4. **回滚**：revert + 重滚旧镜像即可——无破坏性 schema 变更（password/sub2api_email 列留而不用，deployment_keys 双向兼容）；已按新流绑定的 pk_ 引用旧代码按原样取钥（取值路由不变），仅丢失新校验。

## Open Questions

- `password`/`sub2api_email` 列最终 DROP 还是永久留空——取决于生产 SQLite 版本的 DROP COLUMN 支持，实现时定，不影响行为。
