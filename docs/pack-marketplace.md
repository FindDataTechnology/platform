# 功能集市场（Pack Marketplace）运维手册

功能集（pack）= 内联技能内容 + registry MCP 引用 + persona 角色的版本化清单，发布到 **谦面（facet）服务**的注册处（自有 SQLite `packs.db`），其他用户在「设置 → 功能集」浏览、检查、一键订阅。设计决策：OpenSpec change `add-pack-marketplace`（D1–D15，已归档）+ `add-facet-platform`（S0–S4，市场归属迁至谦面；ADR-0015）。

## 1. 架构速览（facet 拓扑，2026-10-03 cutover 后）

```
壹座（gateway / fd-prod server.js）          谦面 facet（独立 Deployment，facet.finddatatech.cloud）
  浏览器 ──> /api/packs… 全前缀代理 ──────> facet 服务（PACK_MARKETPLACE 面：browse/publish/
             （FACET_BASE_URL 设时；                subscribe/deploy/skill-md；store = FACET_DATA_ROOT/packs.db）
              转发身份 x-facet-user/token）          ├─ 直连（facet 域名）：Logto OIDC 自持 session
             └─> cell /api/mypacks…（本地：               ├─ /api/mcp-catalog 只读聚合 registry（registry-bridge）
                 草稿 + 已装 + 物化）                    └─ 匿名开放面：public 且未 unlisted 的 browse/详情/skill-md 下载
```

- **归属**：市场数据面（注册处 = registry 软件 + packs 库）归谦面；壹座只嵌 UI（同源代理，前端零改动）。k8s envFrom 破折号键陷阱与数据迁移全表 diff 纪律见内部部署手册（本文档已内联结论）。
- **身份双通道**：壹座走代理转发身份（`FACET_INTERNAL_TOKEN` + 转发头）；facet 域名直连走 Logto OIDC（同租户 SSO，静默过）。伪造转发头被忽略（无 internal credential 即匿名）。
- **发布门控**：平台 groups 含 `creators`（Logto 组织）。两通道同构（`PACK_CREATOR_GROUPS` ∩ groups）。
- **版本不可变**：发布即追加 vN+1；下架 = unlisted（浏览隐藏，已装快照不受影响）。
- **订阅** = 安装当前版本快照 + 订阅记录（记录在 facet）；新版仅显示更新徽标，手动升级。cell 的已装状态是物化真相，facet 订阅记录是账目面。
- **安装取包在服务端**（`pack-install-server-side-manifest`）：浏览器只送 `{packId, version}`，cell 以调用者身份（`x-facet-user`/`x-facet-token`，与 `/api/packs` 代理同一套请求构造）从 facet 取回该版本 manifest 再物化——manifest 正文合法内嵌 SQL/Python 片段，经浏览器直送会被边缘 WAF（雷池内容规则）重置/403。滚动期带 manifest 的请求体照旧受理（同一校验管线）。
- **安全边界（v1）**：MCP 条目只能引用 registry 已注册 server；角色条目 persona-only；skill 内容内联；无公开上传（creators 白名单）。

## 2. 开通步骤

### 2.1 facet 服务（`all-services/prod/facet.yaml`）

- 镜像：同平台镜像第二入口 `node facet/index.js`（`PORT=3200`，hostNetwork，专用生产节点）。
- 环境：`envFrom` platform-config + platform-secrets + facet-secrets，另显式 `LOGTO_APP_ID/PORT/PAAS_BASE_URL/FACET_DATA_ROOT/FACET_WEB_DIST`；**`SUB2API_ADMIN_KEY` 必须 inline `valueFrom.secretKeyRef`**（envFrom 会静默跳过带 `-` 的键 —— 缺它会让部署路由 "billing not linked"：粘贴键被忽略、重复部署静默抹掉 `billingKeyRef`；回归断言见 `scripts/test-platform-billing.mjs` "cutover regression"）。
- 域：`facet.finddatatech.cloud`（边缘 Caddy → autossh 隧道 3001→3200 → WAF 三 SAN 证书）。
- store：`FACET_DATA_ROOT=/data/facet` ← hostPath `/opt/platform/facet`（与平台同节点）。

### 2.2 壹座侧（platform-config ConfigMap）

```yaml
PACK_MARKETPLACE: "1"                  # 总开关：显示功能集 UI
FACET_BASE_URL: "http://127.0.0.1:3200"  # /api/packs 全前缀代理到 facet（摘除即回滚，见 §5）
PACKS_INTERNAL_BASE_URL: "http://127.0.0.1:3200"  # 萬星 facade internal 三接口指向
PACK_CREATOR_GROUPS: "creators"        # 可选；默认 creators，可加组织 ID
PACK_BASELINE_MCP: "websearch"         # 可选；聚焦模式仍加载的基线 MCP
```

`FACET_INTERNAL_TOKEN` 在 platform-secrets（代理转发身份的共享 secret，两进程同名同值）。改 ConfigMap 后 rollout 生效；ArgoCD ~3min 轮询滞后，先 annotate refresh 再等 rollout（运维手册）。**本地/dev 部署不加 `PACK_MARKETPLACE`**——入口整体隐藏。

### 2.3 Logto 组织 `creators`

Logto 管理台（auth-admin.finddatatech.cloud）→ Organizations → `creators` → 把可发布用户加入。平台 groups 带组织 ID；`PACK_CREATOR_GROUPS` 可同时列可读名与组织 ID。facet 侧复用同一租户（自有 application，见 facet.yaml `LOGTO_APP_ID`）。

### 2.4 发布种子内容（四个 vertical packs）

内容源：`docs/vertical-packs/skills/` + `docs/vertical-packs.md` §1 组装表。两条路径：

- **从自建预设一键流**（有对应 preset 时，推荐）：设置→自建预设 → 行内「发布并部署」→ 确认名/描述 → 发布 →（带服务契约时）同流程部署。
- **手工组装**：设置 → 功能集 → 我的创作 → 新建功能集 → 技能贴 SKILL.md 正文 / MCP 从选取器勾选（`law-bench` 等）/ 角色 persona → 发布 → 记下 pack id。发新版本 = 编辑同一草稿再发布。

## 3. 验证清单

- facet 域名匿名浏览：无痕窗口打开 `https://facet.finddatatech.cloud` → 只见 public 且未 unlisted 的 pack；详情/skill-md 下载可达。
- creators 成员：设置里出现「功能集」；能新建草稿并发布（v1）；一键流（自建预设 →「发布并部署」）全通。
- 非 creators 登录用户：能浏览/订阅；发布报 403 且一键流在「发布」步停步点名。
- 订阅后：技能进 设置→技能；MCP 进 设置→MCP（registry 凭据未连接时报告标注）；角色进对话 agent 选择器。
- 部署（serving 契约）：功能集详情 → 部署为服务 → 描述符含 `billing_key_ref`（有计费绑定）+ `secret_refs`；runner ≤5min 拉起；`scripts/probe-wanxing-live.mjs` 或 A2A 直呼真回合。
- CLI：`npx @finddatatechnology/facet install <packId>`（或仓内 `node facet/cli/facet.js`）落盘技能、打印 MCP 凭据提示。
- 作者发新版：订阅者「我的功能集」出更新徽标；退订：技能/角色消失，MCP 配置保留。

### 3.1 部署后 A2A 转不动的两个已知坑（2026-10-03 一键流实测）

- **405 "agent route refused the turn"**：registry 对健康探测未通过的 agent **不生成 nginx 代理块**，请求落到前端兜底路由。注册/启用时的探测会与 runner 绑定监听端口竞态——新部署首探常被判 unhealthy，且不会自动复探。修复：带 `MARKET_REGISTRY_TOKEN` 调 `POST /api/agents/{path}/health` 重探（HEAD 收到 401 也算可达→healthy），下一次 nginx 重载后即通。
- **503 "No available accounts"**：child 跑在部署键上，该键的**分组**必须有可用上游账户；面板新建键默认落 `default` 组（无上游）。部署前在面板把键的分组切到有上游的工程组。

## 4. 升级与数据

- 镜像升级走当日 canonical 路径（GHA → TCR → relay → GitOps bump → ArgoCD rollout），涉及 facet 的清单：`all-services/prod/{platform,platform-demo,facet}.yaml` 三处镜像同步。
- **数据迁移/校验纪律：停写 + 全表 diff**（实锤：cutover 曾拷错 packs.db 孪生文件，丢了私有包与 `deployment_keys` 全表）。规程：拷前 7 表计数比对（packs / pack_versions / subscriptions / pack_deployments / deployment_keys / deployment_secrets / sub2api_accounts），迁移后跑包含性检查（每行按主键必在目标库；`sub2api_accounts` 允许少——懒重建）。
- facet 侧只读聚合 registry（`/api/mcp-catalog`），不写注册处状态；registry 自身运维照旧（mcp.finddatatech.cloud）。

## 5. 回滚（对齐 add-facet-platform 设计 D8/D9）

- **回滚 = 摘除 `FACET_BASE_URL`**：壹座 `/api/packs` 回到进程内挂载的本地冻结库（cutover 前的运行路径，上线前已运行数月）。代价：cutover 后 facet 侧的新写入在冻结库不可见（设计 D9 已接受；数据不删，恢复 env 即回到 facet）。
- 数据面回滚：facet store（hostPath `/opt/platform/facet`）不删即可逆；冻结库保持原样。
- UI 层面：去掉 `PACK_MARKETPLACE` 即隐藏全部入口（无数据迁移）。
- cell 侧表（`pack_drafts` / `installed_packs` / `custom_skills` 新列）均为增量，留置无害。

## 6. 已知边界（v1）

- 作者不能自带 MCP 端点（v2 议题：registry 注册权开放给 creators）。
- 更新无推送：徽标在打开「我的功能集」时拉取比较（design D13）。
- 滥用举报/下架工具未建：作者可自行 unpublish；admin 可直连 facet store 处理（备份后操作）。
- CLI 不写 MCP 配置、不创建订阅（快照语义）；registry SSO token 自动写入留 v2。