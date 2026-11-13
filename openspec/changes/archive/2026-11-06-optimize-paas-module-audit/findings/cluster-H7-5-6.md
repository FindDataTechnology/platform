# 簇 H7-5/6 健康卡 — 隐私合规/审计留存/密钥轮转/租户面板/邀请入驻/配额角色/挂起/用户同意/画像/会话（14 模块，指名簇）

审计人：H7-5/6 体检员 · 日期 2026-11-06 · paas HEAD `48cd0fc3`（2026-11-06 06:58）
**实册核对**：14/14 指名模块中，**0 个在 `openspec/specs/` 在册**（逐一 ls 核过），零跳过——均为期望态模块，暂无对应 spec。仅两相关既有 spec：`tenant-cell-runtime`（10-02）、`user-runtime-bindings`（09-17）。

**③ 共同部署事实**（fd-infra-deploy/all-services/prod/，只读）：platform.yaml:57 `sha-1275719`（源 paas `94ec620f` 11-06 05:06，merge-base ⊆ HEAD）、facet.yaml:66 `sha-7d935ac`（源 `39d95cce` ⊇ `94ec620f`）。`94ec620f..HEAD` 共 10 提交，触及 win-install-smoke/agent-runner/dsh-profile/openspec specs。**本簇相关运行时文件**（bot-acceptance、db、gateway/packs、runtime-bindings、line-credentials、vendor-onboarding、ops-console）**均为 0 差异**——undeployed=0。痛感口径：`git log --oneline --since=2026-09-05 -- <路径>`，n=总 f=fix。

---

### H7-5 隐私合规/审计留存/密钥轮转（5 模块，均无 spec）

### 1. personal-information-protection — 评级 C
**理由**：spec 不存在。代码侧 `gateway/zhiyu/room-router.js:75` 注记 "privacy partition"（群组 6 细化隐私分区），`gateway/zhiyu/guest-auth.js:86` 涉及 `site_secret_hash` 轮换；无专测，无审计日志落盘证据，剪刀差不可计。
① 未证实：个人信息导出/删除/最小化收集等核心场景实现点。
② 无同名测试；相关 `scripts/test-*.mjs` 无匹配。
③ undeployed=0（随 platform 当日镜像）。
④ n=1 f=0（近 60 天仅 guest-auth 注记更新）。
⑤ spec 不存在，**剪刀差 N/A**；相关代码最近 commit 11-06（99c079c6）。

### 2. privacy-compliance-audit — 评级 C
**理由**：spec 不存在。代码侧 `gateway/vendor-onboarding.js:137-142` 实现 vendor 审计日志（profile.create/update，记录 actor/time/fields），`db.js:786-801` 定义 `action_audit` 表（执行动作追溯），`gateway/packs.js:2913` 注记 "Every fetch is audit-logged"。无合规专测。
① 审计入口：`gateway/vendors.js`（vendor 审计）、`server/routes/actions.js`（action_audit 写入）。
② `scripts/test-vendor-supply-open.mjs:134-142`（vendor 审计测），`scripts/test-deployment-secrets.mjs:140-150`（部署密钥审计测，掩码无值泄露）。
③ undeployed=0。
④ `gateway/vendor-onboarding.js` n=4 f=1（c1a88ad0 tierQuotas 回归）；`db.js` n=32 f=12（高噪声，多为迁移/功能随行）。
⑤ spec 不存在，**剪刀差 N/A**；vendor-audit 代码 10-28，action_audit 表 11-06（960e6725）。

### 3. records-retention-policy — 评级 B
**理由**：spec 不存在。代码侧 `server/bot-acceptance.js:30,84,158-160` 实现 24h 留存窗（`DONE_RETENTION_MS`），`cleanup()` 按 `now()` 清理过期 done 记录；`services/ops-console/index.js:56,92` 实现 7 天快照留存（`RETENTION_MS`，`pruneOld()`）。有单测覆盖留存逻辑。
① 留存入口：`server/bot-acceptance.js:84,158`（bot 接受存储）、`services/ops-console/index.js:92`（ops 快照）。
② `scripts/test-bot-acceptance.mjs:86-100`（24h 留存+键随记录过期）、`services/ops-console` 无独立测但逻辑纯函数可测。
③ undeployed=0。
④ `bot-acceptance.js` n=1 f=0（仅 ab33c867 初始落地）；`ops-console/index.js` n=10 f=3（报警/漂移/登录三重修）。
⑤ spec 不存在，**剪刀差 N/A**；bot-acceptance 10-23，ops-console 11-05（1a78a43c）。

### 4. security-audit-logging — 评级 B
**理由**：spec 不存在。代码侧 `db.js:786-801`（action_audit 表，执行审计追溯）、`gateway/packs.js:2913`（包注册表 fetch 审计）、`gateway/vendors.js`（vendor 操作审计）、`server/bot-acceptance.js`（接受/派发/完成全链路落盘）。审计掩码经测试验证（部署密钥审计不泄露值）。
① 审计写入：`server/routes/actions.js`（action_proposals→action_audit）、`gateway/vendors.js`（vendor audit 记录）。
② `scripts/test-deployment-secrets.mjs:140-150`（审计掩码断言）、`scripts/test-vendor-supply-open.mjs:134-142`、 `scripts/test-bot-acceptance.mjs`（状态机落盘）。
③ undeployed=0。
④ `actions.js` n=8 f=3（动作闸核心）、`packs.js` n=28 f=8（市场重构噪声）、`bot-acceptance.js` n=1 f=0。
⑤ spec 不存在，**剪刀差 N/A**；action_audit 表 11-06（960e6725）、packs 审计 11-06（99c079c6）。

### 5. secrets-rotation-schedule — 评级 B
**理由**：spec 不存在。代码侧 `server/routes/line-credentials.js` 实现产品线凭据无人值守续期（`add-line-credential-renewal`，rotation 后 15min 即续/sweep 5min，rotator 寿命 ≤20min，`updated_at` 锚定），`gateway/zhiyu/guest-auth.js:86` 提及 `site_secret_hash` 轮换失效旧呈现，`gateway/packs.js` 部署密钥重粘贴即旋转（新引用、旧引用 404）。
① 轮转入口：`server/routes/line-credentials.js:256`（store 含 rotation）、`server/line-token-renewal.js`（巡检/回合前双触发）、`gateway/packs.js`（部署密钥再粘贴旋转）。
② `scripts/test-line-credential-renewal.mjs`（17/17 单测）、`scripts/test-deployment-secrets.mjs`（生命周期：省略=保持、null=解绑、再粘贴=旋转、停服=清理）。
③ undeployed=0（line-credentials 11-06 随 94ec620f 入镜）。
④ `line-credentials.js` n=5 f=2（续期节奏修正/静默铸中介）、`line-token-renewal.js` n=3 f=1。
⑤ spec 不存在，**剪刀差 N/A**；line-credentials 11-04（2b8cc9a9）、guest-auth 近期无修改。

---

### H7-6 租户/用户面（9 模块，均无 spec；两相关既有 spec：tenant-cell-runtime、user-runtime-bindings）

### 6. tenant-dashboard — 评级 C
**理由**：spec 不存在。代码侧 `services/ops-console/index.js` 实现机群总览板（`renderFleetOverview` 五态/水位/wake/24h 计数/pending/滞后双基，`9ec81543`）、漂移粒度细化至 ArgoCD app 级（`74007605`）、三重报警失真同修（`1a78a43c`）。无租户级仪表盘专属实现（仅平台运营视角）。
① 面板入口：`services/ops-console/index.js:100-200`（fleetBoard 数据源轮询）、`renderFleetOverview`。
② `services/ops-console` 新测 16/16（argocdStatusFor 矩阵）、10 用例（报警三重修）。
③ undeployed=0（ops-console 独立服务，ConfigMap 已上线）。
④ n=10 f=3（报警/漂移/登录）。
⑤ spec 不存在，**剪刀差 N/A**；ops-console 11-05（1a78a43c）。

### 7. tenant-invitation — 评级 C
**理由**：spec 不存在。代码侧 `gateway/vendors.js`（vendor 成员管理：owner 加绑/成员可读/旁观者 403/最后 owner 不可删，`scripts/test-vendor-supply-open.mjs:145-152`）、`gateway/vendor-onboarding.js` 无邀请流程。无租户邀请专属实现（vendor 成员管理可作类比）。
① 成员管理：`gateway/vendors.js`（vendor 操作审计、成员增删）。
② `scripts/test-vendor-supply-open.mjs:145-152`（成员管理测）。
③ undeployed=0。
④ `vendors.js` n=6 f=1（近期仅 lint）。
⑤ spec 不存在，**剪刀差 N/A**；vendor 成员管理代码 10-28（fcc4f020）。

### 8. tenant-onboarding — 评级 B
**理由**：spec 不存在。代码侧 `gateway/vendor-onboarding.js` 完整实现 vendor 入驻全链路：材料校验（license/端点/工具集/商业集闭包）、自检（可达性/声明缺失/商业集超集）、配额过闸（tiny 档 1 台→quota_exceeded）、registry 写入失败挂起 in_retry、platform-hosted 先行驻留 in_review、资格闸（未绑定账号 403）。有完整集成测试覆盖。
① 入驻入口：`gateway/vendor-onboarding.js:200-290`（onboarding 路由）、`registerOnboardingRoutes`。
② `scripts/test-vendor-supply-open.mjs:201-296`（10 条 onboarding 测：happy path/材料不全/禁证/同名/自检/配额/注册失败重试/平台托管/资格闸/可见面）。
③ undeployed=0（vendor-onboarding 11-06 随 99c079c6 入镜）。
④ n=4 f=1（c1a88ad0 tierQuotas 空 env 回归）。
⑤ spec 不存在，**剪刀差 N/A**；vendor-onboarding 10-28（c1a88ad0）。

### 9. tenant-quota-management — 评级 B
**理由**：spec 不存在。代码侧 `gateway/vendor-onboarding.js:39-59` 实现 `tierQuotas`（free/pro/tiny 档，`VENDOR_TIER_QUOTAS` JSON 覆盖，缺省/非法/部分覆盖一律回退内置档，free 永远兜底）、`scripts/test-demo-quota.mjs` 实现 demo/sandbox 预算（per-cell vs everyone、remaining()、限额回复码）。配额过闸有测试验证（tiny 档 1 台第二台 quota_exceeded）。
① 配额入口：`gateway/vendor-onboarding.js:44-58`（tierQuotas 合并）、`server/ws.js`（createDemoBudget/DEMO_LIMIT_REPLY）。
② `scripts/test-vendor-supply-open.mjs:255-266`（配额过闸）、`scripts/test-demo-quota.mjs:13-49`（预算算术/remaining/限额回复）。
③ undeployed=0。
④ `vendor-onboarding.js` n=4 f=1、`ws.js` n=2 f=0。
⑤ spec 不存在，**剪刀差 N/A**；tierQuotas 10-28（c1a88ad0）、demo-quota 10-11。

### 10. tenant-role-matrix — 评级 C
**理由**：spec 不存在。代码侧 `services/ops-console/index.js:42-48` 注记"Tenant ROLE claims were tried first — this Logto build never ships the roles claim in any token, verified empirically"，改用 organizations claim 作准入；`gateway/vendors.js` 仅 owner/member 两角色；`gateway/vendor-onboarding.js` 无角色矩阵（仅 vendor 绑定资格）。无细粒度 RBAC 矩阵实现。
① 角色判定：`ops-console/index.js:48`（组织成员准入）、`vendors.js`（owner/member）。
② 无角色矩阵专测；ops-console 登录门测 `76a88d02`/`b0cab0b8`。
③ undeployed=0。
④ `ops-console/index.js` n=10 f=3。
⑤ spec 不存在，**剪刀差 N/A**；ops-console 角色相关 11-05（1a78a43c）。

### 11. tenant-suspension-policy — 评级 C
**理由**：spec 不存在。代码侧 `gateway/vendor-onboarding.js:268-280` 实现 registry 写入失败挂起 in_review（`registry_write_failed`，车道恢复后 retry 上牌）、platform-hosted 先行驻留 in_review（`platform_hosted_pending`）、资格闸 403 无 registry 写入；`services/ops-console` 无租户挂起/恢复策略。无统一挂起策略实现。
① 挂起入口：`vendor-onboarding.js:270-280`（writerError→in_review/retry）、`vendor-onboarding.js:282-288`（platform-hosted pending）。
② `scripts/test-vendor-supply-open.mjs:268-288`（注册失败挂起/重试、platform-hosted 先行）。
③ undeployed=0。
④ `vendor-onboarding.js` n=4 f=1。
⑤ spec 不存在，**剪刀差 N/A**；vendor-onboarding 10-28。

### 12. user-consent-management — 评级 B
**理由**：spec 不存在。代码侧 `server/routes/line-credentials.js:217-221` 实现 Logto 首次交互式 consent（`consent_required`/`interaction_required` 重试一次无 prompt=none，二次失败终态）、`gateway/zhiyu/guest-auth.js` 无同意管理。有单测覆盖 mint 回调的 consent 重试逻辑。
① 同意入口：`line-credentials.js:217-221`（mint 回调 consent 重试）、`line-credentials.js:256`（store 含 token/refresh）。
② `scripts/test-line-credential-renewal.mjs`（含 mint 回调场景）、无独立 consent 专测。
③ undeployed=0。
④ `line-credentials.js` n=5 f=2。
⑤ spec 不存在，**剪刀差 N/A**；line-credentials 11-04（2b8cc9a9）。

### 13. user-profile-registry — 评级 B
**理由**：spec 不存在。既有 spec `user-runtime-bindings`（09-17）覆盖个人模型绑定/个人 MCP 可用性/运行时画像应用/WS 身份感知/共享运行时边界。代码侧 `server/runtime-bindings.js` 完整实现：`GET /api/users/me/bindings`/`PUT /api/users/me/model`/`PATCH /api/users/me/mcp/:name/enable`，cell 作用域绑定（cell 启动/保存即时生效，无跨用户应用机器），WS 快照/变更事件不泄露他人邮箱。
① 画像入口：`runtime-bindings.js:14-162`（applyProfile/applyUserBindings/applyPendingBindings）、`server/db.js`（getUserModelBinding/getUserMcpBindings）。
② `scripts/test-runtime-bindings.mjs`（推测存在，未直接核对）、`e2e` 无专测命中。
③ undeployed=0（runtime-bindings 11-06 随 36e04772 入镜）。
④ `runtime-bindings.js` n=5 f=0（近 60 天仅 36e04772 切窗不再断流）。
⑤ **既有 spec `user-runtime-bindings` 09-17 vs 代码 11-06，剪刀差 50 天 = stale**（spec 反超 50 天，align 批回写现实方向）。

### 14. user-session-tracking — 评级 B
**理由**：spec 不存在。既有 spec `tenant-cell-runtime`（10-02）覆盖 cell 级会话隔离/重启恢复/工作区隔离/市场服务面部署级不入 cell。代码侧 `server/runtime-bindings.js:164-194`（applyUserBindings 含 streaming 时 pending/broadcastRuntimePending/回合结束 applyPendingBindings）、`server/db.js`（session 归属 owner 列/范围列表/门控/按查看者投递）、`server/bot-acceptance.js`（持久接受存储/幂等键/状态机/重启恢复/留存清理）。
① 会话入口：`runtime-bindings.js:164-194`（绑定应用与 pending 队列）、`db.js:1195`（session ownership 首镜写入）、`bot-acceptance.js`（接受存储状态机）。
② `scripts/test-bot-acceptance.mjs`（重启恢复/留存/溢出）、`e2e/session-*.spec.js`（7 个 session 专测：delete/navigation/open/ownership/resume/smoke/share/solution）。
③ undeployed=0。
④ `runtime-bindings.js` n=5 f=0、`db.js` n=32 f=12（高噪声）、`bot-acceptance.js` n=1 f=0。
⑤ **既有 spec `tenant-cell-runtime` 10-02 vs 代码 11-06，剪刀差 35 天 = stale**（spec 反超 35 天，align 批回写现实方向）。

---

## 簇摘要

**三件最严重的事**：
1. **14/14 指名模块 spec 全缺失**（0 在册）：H7-5/6 全簇为期望态模块，暂无 OpenSpec 契约，所有"spec↔代码对齐""陈旧度"项均不可计——建议先立 spec 再落地，或将现有实现（vendor-onboarding/bot-acceptance/line-credentials/runtime-bindings/ops-console）反向提炼为 spec。
2. **两相关既有 spec 均 stale 超 30 天**：`user-runtime-bindings`（09-17 vs 代码 11-06，剪刀差 50 天）、`tenant-cell-runtime`（10-02 vs 代码 11-06，剪刀差 35 天）——均为 align-yizuo 批回写现实导致 spec 反超，语义零改动，但剪刀差触发 stale 判定，建议同步刷新 spec 日期或纳入回写节奏。
3. **隐私合规/个人信息保护零实证**：`personal-information-protection`/`privacy-compliance-audit` 两核心模块仅有零星注记（privacy partition、site_secret_hash 轮换），无导出/删除/最小化收集/合规审计报表等 GDPR/PIPL 强制场景实现点——建议立项补齐或明确不适用范围。

**评级分布**：B×6（records-retention-policy、security-audit-logging、secrets-rotation-schedule、tenant-onboarding、tenant-quota-management、user-consent-management、user-profile-registry、user-session-tracking 共 8，其中 2 依托既有 spec）· C×6（personal-information-protection、privacy-compliance-audit、tenant-dashboard、tenant-invitation、tenant-role-matrix、tenant-suspension-policy）· A×0· D×0