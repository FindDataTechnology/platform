# Tasks: add-agent-platform-ops

## 1. Ops 前置（用户/运营操作 + 记档）

- [x] 1.1 管理员凭证（用户提供）→ Admin API Key 生成（x-api-key 实测 200）→ 入 fd-prod `platform-secrets` 键 `sub2api-admin-key`；步骤记 DEPLOY.md（密码不落盘）
- [x] 1.2 平台池组已建（id=7 paas-platform-pool，composite/active）；**充值码端点 0.2.7 无（实测 404）→ day-one 充值=手工调额**（POST users/:id/balance + Idempotency-Key 路由实测在）；余项=运营向组 7 加入独立上游账号后方可绑 key 隔离（绑前平台 key 走默认池）；runbook 记 DEPLOY.md

## 2. 计费核心

- [x] 2.1 `lib/sub2api-admin.js`：Admin API Key 客户端（ensureUser 映射/幂等、createKey 带额度与三窗、readUser、createRedeemCode、启动自检 ping）；单测以 stub 全覆盖（含 admin key 缺失→降级标志）
- [x] 2.2 packs.db `deployment_keys` 表 + deploy 联动：余额门（402 结构化拒绝）、铸 key 入库、descriptor 带 `billing_key_ref`；单测覆盖门拒绝/铸 key/降级（无 admin key 时旧行为）
- [x] 2.3 key 分发路由 `GET /api/packs/internal/llm-key/:keyRef`（runner 服务凭证鉴权、审计日志）；runner compose 按 ref 拉取注入 child `LLM_API_KEY`（无 ref→runner 级凭证旧行为）；单测+runner 测试覆盖

## 3. 私有 pack 与准入

- [x] 3.1 packs.db visibility + `visibleTo` 统一过滤（列出/详情/安装/部署），私有对外一律 404、owner/admin 可见带徽标；registry 条目随包设 private；单测覆盖四种访问者×公私矩阵
- [x] 3.2 web：草稿/发布可见性开关、部署区余额只读+欠费预警横幅+充值指引（五语）；`npm run typecheck` 绿

## 4. C-lite 凭证

- [x] 4.1 连接流挂组联动（存凭证成功→admin API 挂 `paas-agent-callers`，幂等；username 以 email 匹配 user-groups 列表）；单测覆盖挂组调用与失败不阻塞连接
- [x] 4.2 委派/聊天凭证选择改造（owner 凭证→单机回落服务凭证→托管 cell 无凭证结构化指引）；改造 `server/a2a-client.js` 凭证入参链；单测三态

## 5. Console fleet 视图

- [x] 5.1 平台 `/api/packs/billing/board` 只读聚合（每 key 消费=平台 meter 聚合+sub2api 用量、部署者余额）；ops-console fleet 区（五态行+消费+池隔离健康线，失败行降级可见）；单测聚合逻辑

## 6. 端到端与验收

- [x] 6.1 e2e：`e2e/platform-ops.spec.js` 2/2（私有徽标、余额读出+欠费横幅——网关面 mock，同 packs.spec 模式）；服务端契约在 `test-platform-billing.mjs` 5/5 对真 registerPackRoutes（402 门/铸 key/引用不泄密/内部路由鉴权/私有矩阵/board）；runner 注入在 test-agent-runner 17/17 基础上经 manager 分支覆盖
- [x] 6.2 规格/提案回读：platform-billing 四要求（账户映射/铸 key 计量/分发通道/余额门）+ pack-visibility 三要求 + 四 delta（部署联动/委派凭证 C-lite/console fleet/市场过滤）逐条对照过；`openspec validate` 通过；**真 sub2api 冒烟全通记 DEPLOY.md**（ensure→mint→adjust→read，实测修正 key 路由与 balance body 两处形状）；全量单测通过；runner 真回合记账随部署演练
