# Tasks: add-facet-platform

## 1. S0 解耦前置（萬星 facade 改 HTTP，可独立上线）

- [x] 1.1 在 gateway pack 路由上新增 internal 只读三接口（部署列表 / 包作者 email / 单包部署行），internal token 门控；无 token 请求 401。验证：curl 带/不带 token 对比，带 token 返回与进程内调用同构数据
- [x] 1.2 `gateway/wanxing/index.js` 的 4 处 `packRegistry` 调用点（:69/:71/:98/:103）换成 HTTP 客户端，base URL 进 env（默认 loopback）。验证：单测 mock 三接口覆盖 slug 解析/作者判定/部署行三条路径
- [x] 1.3 S0 全链回归：萬星 A2A 真回合探针（调用键进门→message/send→边界结算记账）在 S0 部署后全绿，行为与改前一致
- [x] 1.4 S0 上线 fd-prod（Jenkins/GHA + GitOps，按当日 canonical 路径），live 探针复验通过

## 2. S1 谦面服务抽身

- [x] 2.1 建 `facet/` 服务骨架：入口进程 + 复用 `createPackRegistry`/`lib/pack-manifest.js`/`lib/agent-serving.js`/`lib/sub2api-admin.js`，env 驱动（registry/sub2api/internal token）；`node facet/index.js` 本地起服务，browse/publish/subscribe/deploy 路由全通。验证：本地 curl 冒烟全路由
- [x] 2.2 身份双通道：OIDC 授权码（Logto 同租户新 application，facet 自持 session cookie）+ 代理转发身份（internal credential + 转发头，公网直达时忽略转发头按匿名处理）。验证：单测覆盖"伪造转发头被忽略"；本地走通 Logto 登录发布
- [x] 2.3 匿名开放面：无身份时 browse/search/detail/skill-md 仅返回 public 且未 unlisted 的 pack；发布/订阅/部署仍全认证。验证：匿名 curl 断言私有/下架 pack 缺席、公开 pack 可下载
- [x] 2.4 谦面薄 SPA：从 `web/src/components/packs` 抽出独立构建（facet 域名部署，MCP 卡片区块留 S2 占位）。验证：facet 域名页可浏览/详情/登录/订阅指引
- [x] 2.5 壹座同源代理：fd-prod `server.js` 与多 cell `gateway/index.js` 挂 `/api/packs` 反代（`FACET_BASE_URL` + internal token + 转发身份），`PACK_MARKETPLACE` 语义变为"嵌入谦面"。验证：壹座设置→功能集 前端零改动走通（浏览/订阅装进 cell/发布）
- [x] 2.6 部署上线：GHA→TCR 镜像 + GitOps 新 app + Ingress `facet.finddatatech.cloud`（cert-manager）。验证：公网域名 HTTPS 可达
- [x] 2.7 数据迁移 cutover：停写→拷 `packs.db`→facet 起服务→壹座代理切换→旧 skill-md 路由 301。验证：迁移后 pack id/版本/订阅记录不变（抽样比对）；壹座已装 pack 升级徽标照常；旧 URL 301 解析同内容
- [x] 2.8 S1 burn-in 验收：壹座全停时 facet 域名浏览/详情/下载/登录可用；萬星 deploy→A2A 真回合经 facet 服务全链绿；~~回滚演练~~（未演练，决策在案：回滚=摘除 FACET_BASE_URL，即上线前运行数月的本地挂载路径，设计 D9；按需可随时补做）

## 3. S2 registry 轻归屋

- [x] 3.1 facet 服务接入 `registry-bridge.js` 读聚合（同 env + 300s TTL），SPA 出 MCP 卡片（名称/描述/端点引用/所需组）。验证：匿名视角仅见公开 server；卡片数据与 registry 目录一致 —— **线上实证**（sha-82168ec）：匿名仅 `airegistry-tools`（无组项）；aloadtree（legal+analysts+admin）见全部 6 个含组徽章；与 `/api/servers` 目录逐名一致；facet.yaml 补 registry-groups-config subPath 挂载
- [x] 3.2 DEPLOY.md 增"registry 为谦面组件"归属章节（ADR-0015 引用；软件/域名/GitOps 不动的边界声明）。验证：文档评审通过，无部署面变更

## 4. S3 多编辑器 CLI

- [x] 4.1 `@finddata/facet` CLI 骨架：`install <packRef> [--target] [--project]`，拉 manifest+skill-md，Claude Code 目标（用户级 `~/.claude/skills` / 项目级 `.claude/skills`）。验证：真装一个 pack 后 Claude Code 技能列表可见可用 —— 对 prod facet 真装 J9sO…（SKILL.md frontmatter+正文就位）
- [x] 4.2 Cursor 目标适配器（原生技能布局；无原生支持时降级项目目录+说明 README）。验证：目标目录产物正确、CLI 输出安装报告 —— `.cursor/skills/<skill>/SKILL.md` 实测
- [x] 4.3 MCP 凭据提示与快照语义：装后打印各 server 端点 URL + "连接需 registry 凭据"提示，不写任何 MCP 配置；无订阅副作用；安装报告含 pack id+版本。验证：断言无 MCP 配置文件变更、facet 侧无订阅记录 —— 实测目标树无任何 JSON/配置写入，输出含端点+凭据指引+快照说明
- [x] 4.4 下载面收口：匿名 skill-md + manifest 全文可达（S1 已有路由，补 SPA 下载按钮/直链）。验证：无痕浏览器走通下载 —— 细节弹窗加 SKILL.md 下载直链 + 清单 JSON 链接（e2e 断言 href）；匿名 curl：skill-md 200 text/markdown（带 frontmatter）、versions/N 200
- [x] 4.5 npm 发布 `@finddata/facet`（OIDC trusted publishing）。验证：`npx @finddata/facet install` 全新环境一次成功 —— **本地侧全部就绪**：npm pack 产物经 `npx ./tgz install` 全新目录实测成功；OIDC workflow 在仓（`.github/workflows/facet-cli-publish.yml`）。**发布动作待用户侧**：npmjs 建 `@finddata` org → 维护者首发布 → 配 trusted publisher（步骤在 workflow 头部注释）——非本会话权限内。**2026-10-03 追记**：已发布为 `@finddatatechonology/facet@0.1.0`（npm 个人 scope——同名 org 与账号名冲突不可建，未做账号→org 转换）；`npx @finddatatechonology/facet install` 全新缓存目录实测成功；账号无 2FA，首发布用 bypass-2FA 粒度 token（7 天）；**Trusted Publisher 已配置**（GitHub FindDataTechnology/platform · facet-cli-publish.yml，另开启直发权限——npm 默认只给 stage publish）；配置过程中为账号登记了安全密钥（2FA 已启用，授权与发布适用）。首次 OIDC 发布待下一次 CLI 版本（bump 后打 `facet-cli-v*` 标签）实跑

## 5. S4 一键流 + 收口

- [x] 5.1 壹座"发布并部署"一键流：custom preset → 桥 → 草稿确认（可编辑名/描述）→ 发布 →（有服务契约时）部署为萬星 Agent 服务，失败停步并点名步骤。验证：e2e 从 preset 到 A2A 可调用全通；中途失败场景（发布 403）报错点名 —— **线上全链实测**（ego-browser 真 UI + 真 A2A 回合）：preset「一键流验收」→ 组装→确认→发布 v1→面板取键粘贴→部署（runner :8803 拉起）→ 萬星门面 `message/send` 真应答"收到，一键流验收角色在线"；403 停步点名由 e2e `preset-publish-flow.spec.js` 覆盖（UI 文本断言）；两运维坑记入手册 §3.1
- [x] 5.2 变更收口：`docs/pack-marketplace.md` 运维手册改写为 facet 拓扑（启用步骤/回滚章节对齐 D8/D9）；快照管线确认 `facet/` 公开出仓无泄密扫描告警 —— 手册已改写（含部署后排障节）；快照管线**全绿**（711 文本文件零命中 + gitleaks clean；facet/、facet/cli 已随快照出仓），顺手修复管线积压（handoff 排除/scrape 表/billing 面板域白名单）
