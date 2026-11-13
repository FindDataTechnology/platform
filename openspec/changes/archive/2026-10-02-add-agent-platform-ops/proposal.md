# Proposal: add-agent-platform-ops

## Why

Agent 平台程序最后一片（切片 ③）：把前两片铺好的能力向公众开放。阻塞项全部实测定性——sub2api 实例 RUN_MODE=standard（余额计费原生生效），users/api_keys 表的 balance、quota、5h/1d/7d 消费窗字段全部在位且已有 39 用户/20 key 在跑；支付 env 未配置（day-one 充值=运营充值码/手工调额）；registry 侧 `IDP_USER_GROUP_FALLBACK_ENABLED_PROVIDERS` 含 logto——**C-lite 凭证加固成立**（admin API 给用户挂组，其既有个人市场凭证即获 invoke 权，零新管线）。承 ADR-0011（计费面）与程序 grill 共识（Q3/Q4/Q7/Q10/Q12）。

## What Changes

- **计费接入（ADR-0011 落地）**: 部署动作联动 sub2api——平台以 admin API 为部署者确保一个 sub2api 用户（身份映射、平台持有服务凭证），铸造**每 agent 一把 key**（额度 + 5h/1d/7d 消费窗），key 存平台库；key 分发走 pack 网关的内部鉴权路由（runner 以服务凭证拉取），descriptor 只带 key 引用不带密钥；runner 组装子进程时按 agent 注入专属 key（替代 runner 级服务配额）。余额只读展示 + 欠费预警横幅（跳转 sub2api 门户充值）。**ops 前置（已完成 2026-10-02）**：管理员凭证（用户提供）→ Admin API Key 已生成并入 platform-secrets；平台池组已建（id=7，上游账号待运营加入后 keys 绑组）。
- **自助准入（Q4 落地）**: 部署门=部署者 sub2api 余额 > 阈值（admin API 只读校验）；发布市场仍 creators 门；私有部署不再需要 creator 身份、只看余额。day-one 充值=运营手工调额（admin API Idempotency-Key；0.2.7 无充值码端点，内置支付未配置——DEPLOY.md 记 runbook）。
- **私有 pack（Q7 落地）**: 草稿/发布增 `visibility: public|private`；私有 pack 市场不列出、安装与部署仅限 owner（+admin）；registry 侧技能/agent 条目同步 private 可见性。
- **ops-console fleet 视图（Q10 落地）**: 面板增 Agent fleet 区——在线 agent（runner health 五态）、每 key 消费（runner meter.jsonl 聚合 + sub2api 用量只读）、上游池隔离状态；沿既有漂移灯/轮询快照机制。
- **凭证加固 C-lite（ADR-0013 债清偿）**: 平台在市场连接/铸凭证时以 admin API 给该用户挂 `paas-agent-callers` 组——其个人市场凭证即获 invoke_agent；委派与 a2a 聊天的网关凭证从部署级服务凭证切换为 **owner 个人凭证**（未连接的用户收到连接指引；单机/机器主部署回落服务凭证并明示）。
- **上游池隔离（ADR-0011 红线）**: 平台 agent 的推理划入 sub2api 独立账号池（运营侧配置），console 展示池健康。

## Capabilities

### New Capabilities

- `platform-billing`: 计费域——部署者 sub2api 账户生命周期（映射/创建/服务凭证托管）、每 agent 铸 key（额度/窗口）、key 引用与分发通道、余额门与欠费预警、充值码 runbook 面。
- `pack-visibility`: 私有 pack 语义——可见性字段、市场不列出、安装/部署门、registry 条目私有同步。

### Modified Capabilities

- `a2a-agent-serving`: 部署动作扩展——铸 key 联动与 descriptor 的 key 引用；registry agent 条目随 pack 可见性设 private。
- `agent-delegation-a2a`: 「Delegated calls carry the deployment's gateway credential」按 C-lite 重写——owner 个人凭证优先，服务凭证仅限无 owner 凭证的部署且明示。
- `ops-console`: 面板增 fleet 区（在线/消费/池健康）。
- `pack-marketplace`: 「Browse, search, and inspect」增私有不列出；「Publishing is identity-gated」保持（私有发布同门）。

## Impact

- **Code**: `lib/sub2api-admin.js`（新，admin API 客户端：用户/组/充值码/key/用量只读）、`gateway/packs.js` 部署联动 + key 内部路由、`lib/agent-serving.js` descriptor keyRef、`agent-runner/`（compose 注入 per-agent key、config 增 sub2api base）、web 部署详情（余额/预警/私有开关/可见性）、ops-console index.js fleet 区、`registry-credentials`/连接流（挂组联动）。
- **Ops**: ①用户恢复 sub2api admin 凭证 + 生成 Admin API Key → 平台 Secret；②sub2api 划平台账号池；③DEPLOY.md 三段 runbook（admin key 接线/充值码/池隔离）。
- **决策依据**: ADR-0011（计费面）、ADR-0013 修订（C-lite 债）、探察事实（run_mode=standard、支付未配、logto fallback、schema 实测）。
- **切片衔接**: ①②已上线——本片全部叠加其上；完成即程序收官、平台可公开。

## Non-goals

- 内置支付接入（充值码先行；支付网关配置是运营决策后置）。
- 驻留租金（容量上限仍是闸门，ADR-0011 延迟项）。
- 发起方付费换钥代理（v2）；计费面重造（余额/用量全读 sub2api）。
- 品牌域名（后置）。
