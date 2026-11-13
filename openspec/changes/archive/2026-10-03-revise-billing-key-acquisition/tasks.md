## 1. 生产事实验证（上线门，可先做）

- [x] 1.1 在生产 fork 实测 `PUT /api/v1/admin/users/:id` 带 `password` 字段可用（拿测试账户改密再改回，不留痕）——design D8 的前提；失败则本任务组后续改走删号+转账兜底
- [x] 1.2 在生产 fork 实测 `GET /api/v1/admin/users?search=<sk-key>` 能按 key 值反查到持有人（design D2 归属校验前提）；缺失属阻断项，回炉重议归属校验
- [x] 1.3 真实 Logto SSO 走查面板一次，确认落的是真邮箱账户而非 synthetic `oidc-…@invalid`（`email_verified=true`）；同时记录 choice-屏（预存账户）实际文案供 402 指引对照 —— 2026-10-03 02:xx lawbench 走查：OIDC 建号 id 49 真邮箱（lawbench-test-admin@findmail.com），非 synthetic ✓
- [x] 1.4 清点 prod `sub2api_accounts` 密码非空行（`SELECT email, user_id FROM sub2api_accounts WHERE password IS NOT NULL`），产出存量清理名单（D8）—— 结果：名单为空（唯一行 aloadtree→user_id 2，password 本为 NULL）；sub2api 侧残留旧探针账户 id 45（paas-ops-probe4@finddatatech.cloud）可删；生产 fork `DELETE /admin/users/:id` 实测 200 可用

## 2. 客户端改造（lib/sub2api-admin.js）

- [x] 2.1 `git stash pop 'stash@{0}'` 取回 paste-flow 草稿，确认 findUserByEmail 与删除 ensureDeployerUser/mintAgentKey 的改造在位，测试套件当前失败点记录在案 —— 基线 5 测试 3 绿 2 红（红的正是旧 ensure/mint 两测）
- [x] 2.2 增 `probeKeyLiveness(key)`：`GET {baseUrl}/v1/models` Bearer 该 key，2xx=活、401/403/429=key 死或不可用；超时 5s；单测覆盖 fake gateway 的活/死两态 —— 另带 403 时的上游 code 透出（INSUFFICIENT_BALANCE/KEY_DISABLED 实测区分）
- [x] 2.3 增 `findUserByKey(key)`：`users?search=<key>` 精确匹配含该 key 值的持有人，返回 `{userId}`；单测覆盖命中/未命中 —— 多命中（>1）判不可证明返回 null
- [x] 2.4 删除 callAsUser 及一切密码登录残留（含 import 清理），grep 确认仓库无 sub2api 密码语义残留 —— slugify/callAsUser/ensureDeployerUser/mintAgentKey 全清；packs.js password 列按 D8 保留不写

## 3. 网关部署链路（gateway/packs.js）

- [x] 3.1 账户解析门：无账户 → `402 {code:"NO_SUB2API_ACCOUNT", panelUrl}`（余额门之前）；余额 402 加 `code:"INSUFFICIENT_BALANCE"`；映射行只写 email+user_id —— 单测断言两态 + panelUrl 在场
- [x] 3.2 四层校验按 D2 顺序落地（shape→白名单→去重→活性→归属），失败 → `400 {code:"BILLING_KEY_INVALID", reason}`，reason 枚举 shape/unknown-agent/duplicate/liveness/ownership；错误路径不落 req.body、不回显 key 串 —— 单测逐 reason 覆盖（含 dead key 与 foreign key）
- [x] 3.3 serving 无 key → `400 {code:"BILLING_KEY_REQUIRED"}`（含无 serving agent 的 pack 豁免——实际被既有「无可部署角色」守卫前置拦截）；degraded（无 admin key/selfCheck 失败）时忽略 billingKeys，维持 pre-③ 姿态 —— 两向单测
- [x] 3.4 absent=keep 生命周期：省略 billingKeys 时从 deployment_keys 续写旧引用进 descriptor 并对每个保留值重跑活性；显式 null 仅非 serving agent 合法；不再 serving 的 agent 绑定随重部署删除；单测覆盖 keep/replace/null-refused/stale-drop 四路
- [x] 3.5 `billing/me` 扩展：无映射行现查 findUserByEmail 并回填，返回 `{linked, balance, accountState}`；新增 `GET /api/packs/:id/billing-bindings` 返回 `{<agentId>: boolean}` 且永不回显值 —— 单测覆盖 none/ok 两态 + bindings 布尔（私包 404 矩阵同步覆盖）
- [x] 3.6 pk_ 引用生成迁移到新流（randomBytes 12 字节 hex），确认与 runner 取钥路由（按引用取值）兼容——既有 e2e（agent-serving 真实 turn）跑一遍绿 —— internal/llm-key 路由单测断言按 pk_ 引用分发原值

## 4. Web 部署面

- [x] 4.1 packs-api.ts：deploy 请求带 `billingKeys`（裸串 map，null 显式解绑）；接 billing/me 新形状与 billing-bindings 端点
- [x] 4.2 PackDetailDialog 三态：无账户（连接按钮 `window.open(panelUrl)` 新标签页 + 指引双分支文案）/ 有账户未绑（按 serving agent 渲染粘贴框）/ 已绑定（「已绑定（更换请粘贴新 key）」，不回显值）
- [x] 4.3 五语 i18n：文案键按结构化 code 组织（NO_SUB2API_ACCOUNT 双分支、INSUFFICIENT_BALANCE、BILLING_KEY_REQUIRED、BILLING_KEY_INVALID×reason）；余额横幅沿用 —— 五语文件全量新增 + `check:locales` 过
- [x] 4.4 浏览器走查：无账户 402 → 打开面板 → 粘贴 → 部署成功全链（本地 fake sub2api），截图/录像留档 —— 组合走查分两半补齐：三态/粘贴框/低余额横幅由 lawbench 会话真实浏览器走查确认（2026-10-03 02:xx）；真链路等价物 6.2 于 2026-10-03 深夜在生产闭环（真实粘贴 key 部署 + runner 真实 turn + sub2api 记账）

## 5. 测试与回归

- [x] 5.1 scripts/test-platform-billing.mjs 改造：fake sub2api 增 `/v1/models`（活/死可控）与 search-by-key（可编程归属），覆盖 402 no-account/402 balance/400 required/400 invalid×4 reason/absent-keep/null-refused —— 7 测试全绿，另覆盖 duplicate 与 stale-drop
- [x] 5.2 既有回归全绿：`node --test`（或仓内现行命令）相关套件 + e2e 冒烟（dsh 清理按 [[test-cleanup-dsh-leftovers]] 惯例 pkill）—— `npm run test:unit` 702/702；platform-ops + packs 系 e2e 20/20（pack-agent-scoping 的 @smoke 红为环境性死 LLM：基础 chat-turn @smoke 同样红，fast 全绿，与本片改动零交集）

## 6. 上线与存量清理（fd-prod）

- [x] 6.1 提交（含 cf6c311 撤销清理）→ 构建滚动一轮平台镜像；sub2api 零动作确认 —— 9d8d4f6 推 GitHub → GHA image.yml 绿（~3.5min）→ ccr 中继 → GitOps **8cbc389** 双 yaml bump（gitee 为 ArgoCD 真源，github 仅镜像；首轮误推 github 已修正）→ ArgoCD refresh → platform + platform-demo 双 rollout 完成，pod Running
- [x] 6.2 上线冒烟：billing/me 三态、billing-bindings、真实粘贴部署一个 serving agent、runner 侧真实 turn 计量落账 —— 服务端侧已验（pod 内 billing-bindings 回网关鉴权 JSON=新路由活，非 404；board 带 runner token 200 degraded:false）；**真实粘贴部署 + runner turn 于 2026-10-03 深夜闭环**：ref `pk_8920c39cf2d899c2a762f1c3` → aloadtree key 26，runner 日志 `running on its own billing key`、meter `ok:true`、sub2api `quota_used 0.00030125` / 余额 `$2→1.99969875`（途中修复 registry invoke 门、caller-group 形状、runner 取钥同步、测试 key 组绑定四处，见 DEPLOY.md「③ 计费链闭环」节）
- [x] 6.3 D8 存量清理执行：按 1.4 名单逐户改密移交（choice 屏自绑后自行改回）；失联户删号+转账；`UPDATE sub2api_accounts SET password=NULL` —— 实际工作量缩水：平台侧无密码行（名单为空）；sub2api 侧唯一残留 id 45 探针账户已删（200）
- [x] 6.4 遗留部署补 key：现存 keyless serving 部署（aloadtree 场景）通知补粘，或等其下次重部署被 BILLING_KEY_REQUIRED 拦截后引导 —— 2026-10-03 深夜盘点归零：board 上唯一在跑的 serving 部署（演示包 pack-demo-fingpt）已带 key（lawbench 验收重部署 pk_e1505d…，key30 组已放行、20:33 有真实消费），registry descriptor 同步、runner 正常 serving；原 aloadtree keyless 部署已被两轮粘贴部署取代，无存量

## 7. 归档前置

- [x] 7.1 `openspec validate revise-billing-key-acquisition --strict` 过；spec 与实现一致性复核后走 archive 流程（[[paas-dev-env-quirks]]：sync-before-archive 门）—— strict 校验过、delta（2 ADDED + 2 REMOVED）已并入 `openspec/specs/platform-billing/spec.md`（validate --specs 109/109）；按用户 2026-10-03 指示归档（目录已入 archive/，落盘变更待提交）

## 8. 复测补记（2026-10-03 深夜，真实回合闭环）

粘贴 key 的真实回合全链闭环，途中修复四处连接/分发链缺陷（registry auth-server 组→scope 重映射、
平台 caller-group API 形状与 username 取证、staging runner 取钥代码+env+provider ref、sub2api
测试 key 组绑定）。细节与证据（含 sub2api 记账读数、回滚 tag、重建命令）见 DEPLOY.md
「③ 计费链闭环 + A2A invoke 门修复」节与 `docs/registry-fork-patches/`。剩余 6.4（遗留 keyless
部署补粘）未动。
