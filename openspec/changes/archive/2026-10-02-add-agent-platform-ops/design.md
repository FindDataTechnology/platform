# Design: add-agent-platform-ops

## Context

sub2api 实例实测（2026-10-02）：RUN_MODE=standard（余额计费原生）；users/api_keys schema 全字段在位（balance/frozen/total_recharged；quota/5h/1d/7d 窗），39 用户/20 key 在跑；支付 env 未配（充值=运营充值码/手工调额）；ADMIN_PASSWORD 运行时为空（**用户前置：恢复/重置 + 生成 Admin API Key**）。registry 侧：`IDP_USER_GROUP_FALLBACK_ENABLED_PROVIDERS` 含 logto——用户级组分配（`POST /api/iam/user-groups`，provider=manual 已验证可行）对 Logto 用户生效；`paas-agent-callers` scope 已留置。①②已上线（meter.jsonl 计量点、descriptor、runner compose 就绪）。承 ADR-0011/0013。

## Goals / Non-Goals

Goals: sub2api 计费全链（账户映射/铸 key/分发/余额门/预警）、私有 pack、自助准入、console fleet 视图、C-lite 凭证。

Non-Goals: 支付网关、租金、换钥代理、品牌（proposal Non-goals）。

## Decisions

**D1 — sub2api admin 客户端与凭证**: `lib/sub2api-admin.js`：`x-api-key` Admin API Key（env `SUB2API_ADMIN_KEY` + base `SUB2API_BASE_URL`=集群内 NodePort），只封装四类操作——ensureUser（映射自平台身份：username=`paas-<slug(email)>`，密码平台生成存库）、createKey（quota=`AGENT_KEY_QUOTA_USD` 默认 $5、rate_limit_5h/1d/7d=`$1/$3/$10`）、readUser（余额）、adjustBalance（手工充值，Idempotency-Key——0.2.7 无充值码端点，实测 404）。**上游隔离**：平台池组已建（id=7 paas-platform-pool，2026-10-02）；上游账号由运营加入组后 key 才绑组——绑组前平台 key 走默认池（共享池），组内无账号即绑组=断推理，故绑定推迟到上游账号就位。

**D2 — key 分发通道**: descriptor 增 `billing_key_ref`（sub2api key id）；平台库存 key 值（packs.db 新表 deployment_keys：agent_path、key_id、key_value、deployer）。runner 拉取路由：pack 网关 `GET /api/packs/internal/llm-key/:keyRef`——鉴权=`AGENT_SERVING_REGISTRY_TOKEN`（runner 已有服务凭证，双端零新配置）；runner compose 时按 descriptor 取一次并注入 child env（`LLM_API_KEY` per child）。拉取失败→child 用 runner 级凭证但 health 标 degraded？**不**——失败即部署不完整（deploy 端点在响应里说明 key 已就绪，runner 拉取属部署后首组装）。

**D3 — 余额门与预警**: deploy 端点先 `readUser`：balance ≤ `DEPLOY_BALANCE_FLOOR`（默认 $0.5）→ 402 结构化拒绝（带余额与充值指引文案）。web 部署区只读显示余额（经网关代理的 `/api/packs/billing/me`——网关以服务凭证查映射用户），低于阈值横幅。充值文案 day-one 指向运营充值码。

**D4 — 私有 pack**: packs.db pack 行增 visibility（发布时冻结）；列出/详情/安装/部署统一走 `visibleTo(pack, user)`（owner 或 admin）；私有部署的 registry 技能/agent 条目 `visibility: private`（上游字段已验证存在）。探测无差别：私有包对外一律 404。

**D5 — C-lite 凭证联动**: 连接流（registry-credential 存储成功后）触发挂组：平台以 `MARKET_REGISTRY_TOKEN` 调 `POST /api/iam/user-groups`（username=registry 侧用户名——从 mint 响应/`GET /api/iam/user-groups` 查询匹配 email）挂 `paas-agent-callers`；幂等。委派/聊天凭证选择：owner 凭证（registry-credentials by owner）→ 无则本地单机回落服务凭证（`CLOUD_MODE` 为假时）→ 托管 cell 无凭证→结构化连接指引错误。

**D6 — console fleet 区**: ops-console 增两轮询源：runner `/health`（既有）+ 平台 `/api/packs/billing/board`（新只读聚合：每 key 消费=平台侧 meter 聚合与 sub2api 用量读并陈）。沿既有快照/漂移灯模式渲染。

## Risks / Trade-offs

- [Admin API Key 依赖用户前置操作] → 无 key 时计费联动降级为「无余额门+无 per-agent key」并明示（部署仍走 runner 服务配额，旧行为），不阻塞私有 pack/console。
- [sub2api admin API 形状随版本漂移] → 客户端集中一个模块+启动自检（ping admin/me），漂移即 console 报警。
- [key 拉取路由暴露面] → 鉴权=runner 服务凭证（非公开）；路由注册在网关内部谓词之外；审计日志记录拉取。
- [充值摩擦] → 充值码 day-one 已是既定（Q12+实测），公开节奏由运营控制发码速度。

## Migration Plan

全部叠加式：无 key 配置时行为=②现状（计费联动自检失败→降级）。ops 前置序列（DEPLOY.md）：①恢复 sub2api admin（用户）→②Admin API Key 入 platform-secrets→③sub2api 建平台池组→④部署。回滚=旧镜像+（可选）撤 key。

## Open Questions

- registry 用户名与平台 email 的精确对应（mint 响应是否带用户名/以何键匹配 user-groups）——实现期用 admin 列表匹配 email 定。
- sub2api group→上游账号池映射的运营配置形状——实现期随池组建而定，不影响代码结构。
