# hard-fork-registry：注册处独立谱系（最终收敛 1.32.0 后切断上游）

## Why

注册处（`mcp.finddatatech.cloud`，ADR-0015 归屋为谦面组件）卡在谱系分叉上：生产 registry-1 跑上游预构建 1.30.0、不带我们的代码，wgk-key 铸造面无处部署，wire-platform-v1 仅剩的 3.2/4.4 被堵死；而持续追平上游的账单（三个版本 238 个上游提交 vs 我们 16 个）远超我们的实际消费量，且我们的差异化能力（per-user 长命 key、sub2api 额度预检、Logto 集成）上游没有对应物、也不会收。2026-10-05 grill 定案：**功能上永久停止追平上游——最后收敛到 1.32.0 一次付清（继承全部安全修复、3.2 从写代码变配置题），从那里切断，转入独立迭代。**

## What Changes

- **fork 最终收敛**：从 upstream `1.32.0` tag 拉新鲜支线，cherry-pick 14 个自有提交（Logto 线 + wire 双 patch；剔除裁剪提交 `8ad0239f` 与 fork 内部 docs 标记）——完整测试套自动回来，secrets 无需 re-scrub；真冲突集中在 `auth_server/server.py`（wgk 分支 + preflight 钩子缝进 1.32.0 版 `validate_request`/`mcp_proxy`）
- **保守瘦身首迭代**：删 6 个未用 IdP provider（保 logto）、charts/terraform/ECS、metrics-service、docker/keycloak、.github/workflows、docs 大部（**保留 release-notes** 作安全单行道本地参照）
- **版本线**：`fd-1.0.0` 首发（基线 1.32.0 记 ADR-0017，不进版本号）；registry 与 auth-server 双容器都从 fork 构建（`mcp-registry:fd-1.0.0` / `mcp-auth-server:fd-1.0.0`）；控制台横幅打 fd 标；**mcpgw 从 `:latest` 钉住**
- **灰度换镜像**（cheap-1）：auth-server 先行（recipe 已验证）→ registry-1 首次 fork 构建（配壹座市场快照 diff 探针，防 1.31 读面过滤导致目录静默缩水）→ 开铸造面（`PATCH_KEY_AUTH_ENABLED`）→ 配 `SUB2API_CALLER_MAP` 开 `PREFLIGHT_ENABLED` 灰度
- **安全单行道政策**（ADR-0017）：功能永不再追；安全修复一周内评估 cherry-pick + 全量 pytest + 既有换镜像 recipe；台账落 `paas/docs/registry-fork-patches/`
- **上游对冲**：patch ①（per-user 长命 key）PR 上游；PR #1791（logto）继续养
- **跨根收口**：wire-platform-v1（`~/finddata` openspec 根）3.2/4.4 勾选 → 该 change 归档
- 不建常设 CI：「换镜像前必跑全量 pytest」作纪律写进维护文档

### Non-goals

- `/fd-open-data-mcp` 公网路由 405/502（独立故障，另行修）
- 域名迁移与 GitOps 重组（ADR-0015 已划归 v2 单独变更）
- 激进瘦身（skills 生态、ARD、peer federation 保留——安全修复会落在里面）
- 上游 CI 复建或新建流水线

## Capabilities

### New Capabilities

- `registry-lineage`：注册处的独立谱系行为契约——版本身份（fd 线）、上游安全单行道、镜像全钉版、自有能力（wgk 铸造面、额度预检）随谱系携带与灰度

### Modified Capabilities

（无——`facet-platform` 的需求不受影响；壹座市场对注册处的消费契约不变，仅内容需探针核验）

## Impact

- **fork 仓**（gitee `FindDataTechnology/mcp-gateway-registry`）：新 fd-1.0.0 支线取代「裁剪 main」成为权威；upstream remote 降级为只读参照；`logto-support` 分支存档待删
- **生产**（cheap-1 `/opt/mcp-gateway-registry`）：registry-1、auth-server-1、mcpgw-server-1 三容器同窗口换版（1.30.0/1.29+补丁/latest → 统一 fd-1.0.0 系）；回滚 = 既有 tag 互换 recipe
- **消费方**：壹座市场 bridge（快照内容 diff 探针）、pack deploy / agent-runner（契约不变）、萬星门面（契约不变）、wire 门面（wgk 铸造 + 预检 402 就位 → 3.2/4.4 收口）
- **文书**：ADR-0017（supersede ADR-0015 补丁模式条款）、`docs/registry-maintenance.md` 谱系章节改写、`docs/registry-fork-patches/` 台账扩为安全单行道账本
