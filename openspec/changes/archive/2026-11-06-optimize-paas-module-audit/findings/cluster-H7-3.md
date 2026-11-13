# 簇 H7-3 健康卡 — matters / mcp / mp / mobile / model / lexicon / offline / ops / paper / permission / persona（15 模块）

审计人：H7-3 体检员 · 日期 2026-11-06 · paas HEAD `7f127d58`（2026-11-06 06:05）
**③ 共同部署事实**：本簇服务端模块全部宿 `fd-infra-deploy/all-services/prod/platform.yaml:57` 镜像 `sha-1275719`（源 paas `94ec620f` 2026-11-06 05:06，`git merge-base --is-ancestor 94ec620f HEAD`=是；HEAD 仅多 1 docs 提交 `7f127d58`——产品代码零滞后）。facet 服务器面同仓异角色 `facet.yaml:66` `sha-7d935ac`（源 `39d95cce`，注记祖先律核过）。miniapp（微信小程序）与 app/（Expo 客户端）为端侧分发，不在 k8s prod yaml（③记 N/A）。ops-console 例外：ConfigMap 内联单文件，无镜像 sha。

---

## 1. matter-threads — A-
① 对齐：内部路由 `gateway/packs.js:3091`（GET internal matters）/`:3105`（单事项）/`:3084`（open，`internalAuth` 门）；主人队列 `gateway/packs.js:3158`（`/api/packs/:id/matters`，admin 全见/部署者过滤 `:3162`）/reply `:3164`/close `:3179`；`mt_` 铸造与校验 `agent-runner/matters.js:149`、`gateway/packs.js:1311`；访客 scope `agent-runner/matters.js:28`（sha256 会话前 32 hex）+`gateway/packs.js:1338-1348`（scope_key 过滤，无界存量兼容）；开串通知 `agent-runner/manager.js:1413-1436`（open 成功 piggyback `matter_opened` 经 `this.notifier.send`，非 facade 无 onMatter）。spec 无 shadow 标记。
② 测试：`agent-runner/test/matters.test.mjs`（10-25）、`scripts/test-facade-matters.mjs`（10-26）、`scripts/verify-live-matter-panel.mjs`（10-25）。
③ 部署：platform.yaml:57 `sha-1275719`（matters 全链在镜像内）。
④ 痛感：matters 三文件+gateway/packs.js since 9/5 共 75 提交、~17 fix 混（含 2 笔 fix(matters)：`ceb7ae73` schema 对齐、`f8511d20` 上线拦截）。
⑤ 陈旧度：spec 2026-10-25 vs 代码 2026-11-06——12 天，不 stale。

## 2. mcp-auth-lanes — B+
① 对齐：能力表+选道 `facet/cli/mcp-auth-capability.js:141`（selectLane）/`:129`（stale 派生）/`:116`（isStale）；接线 `facet/cli/facet.js:862`（选道并打印「选道/理由」——lane choice never silent）；refresh 语义 `facet/cli/facet.js:884-886`（无 refresh_token 如实报「身份侧配置缺陷」）。spec 无 shadow。
② 测试：`scripts/test-facet-mcp-auth.mjs`（10-31）、探针 `scripts/probe-mcp-auth-lanes.mjs`（10-31）。
③ 部署：N/A——CLI 经 npx 分发，非 k8s 面；facet 服务器侧宿 facet.yaml:66 `sha-7d935ac`。
④ 痛感：facet/cli/ since 9/5 共 26 提交 4 fix 混；真机逮出「续期撒谎」缺陷（`07b0442a`/`0a2bcd4b`）后收敛。
⑤ 陈旧度：spec 2026-11-06 vs 代码 2026-10-31——6 天，不 stale。

## 3. mcp-integration — B+
① 对齐：`server.js:121`（MCP_CONFIG_PATH）/`:658-659`（dsh-mcp-client patch 写入）；热换 vs 重启判据 `server.js:901-919`（credentialChanged → runtime child restart，不信任 hot-swap 交付头值变化）；credentialRef 解析 `dsh-profile.js:780`（经 credential-refs.js 按 ref 分派）/`:1060`（不可解析删 server）；requiredGroups 门 `dsh-profile.js:912-913`。
② 测试：`test/dsh-profile-memory.test.mjs`（mcp 邻接）、`scripts/test-dsh-mcp-delivery.mjs`（10-25）、`scripts/test-dsh-profile-links.mjs`（10-11）。
③ 部署：platform.yaml:57 `sha-1275719`。
④ 痛感：全簇最热共享面——dsh-profile.js/server.js/ws.js since 9/5 共 150 提交、48 fix 混（多为邻接模块借用此面，非本 spec 自身缺陷）。
⑤ 陈旧度：spec 2026-10-27 vs 代码 2026-11-05——9 天，不 stale；风险在共享面高频改写挤占，非剪刀差。

## 4. miniprogram-auth — B
① 对齐：单进程形 `server/routes/mp.js:26`（bindcode）/`:119`（login-bindcode）；网关形 `gateway/index.js:329`/`:363`，共享核 `gateway/mp-auth.js:12-14`（5 分钟单次绑定码设计）；客户端 `miniapp/src/lib/auth.ts` + `pages/login`。spec 声称「one shared implementation behind both」——仓库实况为**两套路由文件并存**（gateway/index.js 与 server/routes/mp.js 各写一遍 bindcode/login 端点），共享的只有 mp-auth.js 核；是否算「one shared implementation」**未证实**，合同与代码形状有出入。spec 无 shadow。
② 测试：`scripts/test-mp-auth.mjs`（10-11）、`scripts/test-mp-single-auth.mjs`（10-11）。
③ 部署：platform.yaml:57 `sha-1275719`（单进程 mp-auth 配置点 platform.yaml:449）。
④ 痛感：mp 路径 since 9/5 共 22 提交 7 fix 混；`244174ed` mpAuth.verifyToken 凭据绑定过宽致标准部署 WS upgrade 永远 401（真产品缺陷，已修）。
⑤ 陈旧度：spec 2026-09-29 vs 代码 2026-11-06——**38 天剪刀差，stale**。

## 5. miniprogram-client — B
① 对齐：`miniapp/src/pages/chat/index.tsx`（782 行，WS 回合/流式/降级 markdown 主链）；页面族 bind-guide/chat/command/cron/login/resources/share 与 spec 范围对齐。
② 测试：`scripts/test-mp-command-summary.mjs`（10-13）、`scripts/test-mp-demo.mjs`（10-14）；**chat 页面本体无专属单测**（test-mp-demo 做的是端到端冒烟），渲染/重连细节靠 `0b2bda20` 修后回归。
③ 部署：N/A——微信端 weapp 包，不经 k8s；后端契约面宿 platform.yaml:57。
④ 痛感：miniapp/ since 9/5 共 22 提交 7 fix 混（`0b2bda20` 假「已中断」根修、`c9982e9d` 折叠组吞卡片均 prod 冒烟逮出）。
⑤ 陈旧度：spec 2026-10-03 vs 代码 2026-10-13——10 天，不 stale。

## 6. mission-control-bridge — B-
① 对齐：env 门 `server/mc-bridge.js:28`（MC_BRIDGE=1+MC_URL+MC_API_KEY 才活）；幂等注册 `:87-100`（registered 短路）、心跳 `:104`、220 行单文件与 spec 五需求逐条对应。
② 测试：`e2e/mc-bridge.spec.js`（10-15）。
③ 部署：**prod 未启用**——`grep MC_BRIDGE fd-infra-deploy/all-services/prod/agent-runner-*.yaml platform.yaml` 零命中，桥处于 spec 合法的 inert 态，但无任何生产在役旁证。
④ 痛感：since 9/5 共 5 提交 3 fix 混（`5af86d50` 对齐 live MC 实测 API——上线实录入册）。
⑤ 陈旧度：spec 2026-10-01 vs 代码 2026-11-06——**36 天剪刀差，stale**。

## 7. mobile-app — A-
① 对齐：设备身份 `app/src/lib/device-identity.ts:22`（Ed25519 种子）/`:75`（公钥导出）；配对 `app/src/lib/pairing.ts:7`（capabilities.devicePairing 探针=升级提示路径）+`app/dist/pair.html`；验收 `app/.maestro/pairing.yaml`。
② 测试：`app/test/` 7 件（pairing/device-identity/session 10-11，chart-shell 10-28、markdown-fences 10-27、no-cjk 10-28）。
③ 部署：N/A——EAS 客户端分发（app/eas.json），非 k8s 面。
④ 痛感：app/src since 9/5 共 18 提交 **11 fix 混（61%，全簇最高）**——图表 WebView 三连根修（`228e12f5`/`ab90a287`/`9cbb8d1c`）+空气泡两处（`e7e90cc7`/`8a9d9219`）；年轻客户端验收驱动的正常打磨，但密度需盯。
⑤ 陈旧度：spec 2026-10-29 vs 代码 2026-10-29——0 天。

## 8. model-selection — B+
① 对齐：`server/ws.js:703`（list_models → ctx.getAvailableModels，返回含 live 标志）/`:804`（set_model → ctx.switchModelTo，孤儿错误 toast 语义）；roster/当前广播 `server/ws.js:221`/`:297`。
② 测试：`e2e/model-selection.spec.js`（10-21）、`e2e/llm-model-sync.spec.js`/`llm-models.spec.js`（10-11）、`scripts/test-llm-model-discovery.mjs`（10-11）。
③ 部署：platform.yaml:57 `sha-1275719`；agent-runner 镜像注记含模型会话边界热切（sha-1c17030，模型脱离 identity drain）。
④ 痛感：ws.js/dsh-bridge since 9/5 共 24 提交 7 fix 混。
⑤ 陈旧度：spec 2026-10-21 vs 代码 2026-10-31——10 天，不 stale。

## 9. model-surface-budget — A
① 对齐：预算引擎 `server/model-budget.js:42-45`（MODEL_BUDGET_ENABLED 默认 off）/`:89`（budget_exhausted_log 表）/`:138`（超限入账）/`:156`（consumeBudget）/`:202`（审计读面）；server.js 接线 ctx.modelBudget + 日/月翻页定时器（`bf4b7920` 全量描述）。
② 测试：`scripts/test-model-budget-gate.mjs`（**11-06 02:41，与最新代码同日**，16KB）。
③ 部署：platform.yaml:57 `sha-1275719`；agent-runner-c.yaml:42 注记「model-surface 预算门同拍」。prod 是否置 MODEL_BUDGET_ENABLED=1 **未证实**（默认 off=opt-in）。
④ 痛感：since 9/5 共 3 提交 2 fix 混（新模块，含 11-06 测试补强）。
⑤ 陈旧度：spec 2026-11-06 vs 代码 2026-11-05——同日级，不 stale。

## 10. native-lexicon — B+
① 对齐：v5 落地 `web/src/locales/zh-CN/common.json:71`/`:99`（nav=智能体团队）、`:855`/`:1132`（智能体素材广场）、`:1710`/`:1748`（品牌串）；键名 fleet* 不改（`nav.fleets` 原样）与 spec「code keys 不翻译」一致。
② 测试：`scripts/check-locales.js`（10-31）+locale 门；无 lexicon 专属用例文件（用例化程度低，靠门禁脚本）。
③ 部署：platform.yaml:57 `sha-1275719`（web 静态面随镜像）。
④ 痛感：web/src/locales+check-locales since 9/5 共 196 提交 37 fix 混——词汇裁决 v3→v4→v5 三连改，churn 全簇最高（改词不属缺陷，但证明该 spec 高频返工）。
⑤ 陈旧度：spec 2026-11-04 vs 代码 2026-11-03——不 stale。

## 11. offline-pack-supply — A
① 对齐：容器/校验 `server/offline-bundle.js:25`（.yizpack）/`:39-40`（sha256）/`:163`（逐文件摘要+字节数验真，任一失配整体拒）；导入走既有管线 `server/routes/packs.js:321`（/api/mypacks/import-bundle）/`:155`（草稿形 import-bundle）。
② 测试：`scripts/test-offline-bundle.mjs`（10-28）、`scripts/test-pack-import-bundle.mjs`（10-28）、`e2e/pack-offline-authoring.spec.js`（10-29）。
③ 部署：主消费方为桌面本地集群（气隙），无独立 prod yaml；路由随 platform.yaml:57 镜像可达。
④ 痛感：offline-bundle+packs 路由 since 9/5 共 11 提交 1 fix 混。
⑤ 陈旧度：spec 2026-10-28 vs 代码 2026-10-28——0 天。

## 12. ops-console — A-
① 对齐：单文件 `services/ops-console/index.js`（883 行，源码头注释自证 openspec: ops-console）；drift 粒度细化 `74007605`（argocdStatusFor 每 deployment 取自身 resource status + app 级 OutOfSync 恰计一次 warning）与 spec 第二 Requirement 逐条对上。
② 测试：`scripts/test-ops-console-board.mjs`（10-11）、`e2e/platform-ops.spec.js`（10-15）。
③ 部署：`ops-console.yaml:137`（/app/index.js）+`:172`（ConfigMap 挂载）+`:197`（内联源），基底 node:25-bookworm-slim——**无镜像 sha 可核对**；ConfigMap 含 argocdStatusFor/overallStatus/storeLastOk 标记（1/3/3 命中）说明修复已随行，但精确同步到哪个 commit **未证实**。
④ 痛感：services/ops-console since 9/5 共 16 提交 6 fix 混（38%；`1a78a43c` 板面报警三重失真同修为最大一笔）。
⑤ 陈旧度：spec 2026-10-06 vs 代码 2026-10-22——16 天，不 stale。

## 13. paper-trading-credentials — A-
① 对齐：凭据模块 `paper-trading-credentials.js:25`（PAPER_TRADING_CREDENTIAL_REF，单槽/写面投影）+解析分派 `credential-refs.js:61-63`/`:152`/`:169`/`:189`；API `server/routes/paper-trading.js:28`（owner 鉴权）/`:88-93`（凭据变化 fire-and-forget reapplyProfile）；prod operator baseline 行 `platform.yaml:582-584`（"paper-trading" 带 credentialRef）。
② 测试：`scripts/test-paper-trading-credentials.mjs`（10-15，29KB 单件大套）。
③ 部署：platform.yaml:57 `sha-1275719`；上游服务容器 `fd-paper-trading.yaml` sha-587089c（独立仓，非 paas 代码）。
④ 痛感：since 9/5 共 1 提交 0 fix（特性本身，10-15 上产后零返修）。
⑤ 陈旧度：spec 2026-10-15 vs 代码 2026-10-15——0 天。

## 14. permission-mode-selection — B-
① 对齐：`server/ws.js:849`（list_permissions）/`:859-871`（set_permission → ctx.switchPermissionTo，流中拒绝/未知名孤儿错误）；活会话热切桥 `dsh-profile-template/platform-permission-bridge.js:1-21`（permissions/set 经 bridge 免重启）；roster 广播 `server/ws.js:221`/`:297`。客户端 Full access 确认对话流未逐行核（web/src 未展开）——**未证实**。
② 测试：`e2e/agent-permission.spec.js`（10-22）、`scripts/test-permission-switch.mjs`（10-14）。
③ 部署：platform.yaml:57 `sha-1275719`。
④ 痛感：ws.js 侧 since 9/5 共 24 提交 7 fix 混（多为邻接）；本模块桥文件 9-13 后零改动。
⑤ 陈旧度：spec 2026-09-21 vs 代码（ws.js）2026-10-31——**40 天剪刀差，全簇最长，stale**。

## 15. persona-self-evolution — B+
① 对齐：提议工具 `server/persona-evolution-mcp.js:42`（纪律文本：候选永不直接生效）/`:46-47`（persona_amend 合同，≤8000 字符、证据三件套）/`:85-87`（落候选即答，无执行语义）；评审面 `server/persona-evolution-routes.js`（205 行）。
② 测试：`scripts/test-persona-evolution.mjs`（11-03）；桥鉴权 `scripts/test-evolution-bridge-auth.mjs`（4/4）。
③ 部署：platform.yaml:57 `sha-1275719`；platform.yaml:319 注记「persona_amend 401 根修（sha-779f832 起）」——上产即事故已收口。
④ 痛感：since 9/5 共 4 提交 1 fix（`535ee55a` 生产 401 根修：交付漏注册 auth 中间件桥+裸 startsWith 可伪造 loopback 章——真机走查逮出的上线缺陷）。
⑤ 陈旧度：spec 2026-11-05 vs 代码 2026-11-06——不 stale。

---

## 簇摘要

**三件最严重的事：**
1. **permission-mode-selection spec 40 天剪刀差（全簇最长）**：spec 2026-09-21 vs ws.js 2026-10-31（`openspec/specs/permission-mode-selection/spec.md` vs `server/ws.js:859`）——危险确认对话流这类用户可见行为合同冻结 40 天而代码持续演进，一旦行为漂移无 spec 可判。
2. **mission-control-bridge 悬置态**：spec 五需求齐全（2026-10-01）但 prod 零启用（`fd-infra-deploy/all-services/prod/agent-runner-*.yaml` 无 MC_BRIDGE env，grep 零命中）+spec 36 天剪刀差——spec 有、生产无，维护价值待拍板。
3. **miniprogram-auth 合同与代码形状出入**：spec 声称双部署形「one shared implementation behind both」，实况是 `gateway/index.js:329` 与 `server/routes/mp.js:26` 两套 bindcode/login 路由并存、仅 `gateway/mp-auth.js` 验签核共享；且 spec 38 天 stale、上产后即出 `244174ed` WS 401 真缺陷。

**评级分布**：A×2（model-surface-budget、offline-pack-supply）· A-×4（matter-threads、mobile-app、ops-console、paper-trading-credentials）· B+×5（mcp-auth-lanes、mcp-integration、model-selection、native-lexicon、persona-self-evolution）· B×2（miniprogram-auth、miniprogram-client）· B-×2（mission-control-bridge、permission-mode-selection）——无 C/D，簇整体健康；三笔 stale 全部是「代码活着、spec 冻结」型。
