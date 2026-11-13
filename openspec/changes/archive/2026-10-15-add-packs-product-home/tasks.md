# add-packs-product-home — tasks

> 实施代码落在 registry fork（`~/code/mcp-gateway-registry`，fd 谱系分支）；本 change 仓内只动 paas 侧文件与台账。每步验证口径随任务标注。

## 1. registry 分流与落地页服务

- [x] 1.1 根路径分流：`registry/main.py` `GET /` 按会话 cookie 存在性分流（无→落地页资产，有→既有 `FileResponse(index.html)`），控制台深链与 API 路径不动；验证：pytest 新增三例（匿名 200 无跳转 / 带会话出 SPA / `/login` 与 API 行为不变）
- [x] 1.2 落地页静态单页资产：镜像内置基线（价值主张/三步指引/市场内容区/开发者入口四区 + 测试锚点），同源拉取 `/api/public/summary` 渲染市场内容；验证：本地起服务匿名 `curl /` 200 且含四区锚点
- [x] 1.3 ConfigMap 覆盖通道：部署资产目录约定（基线 + 挂载覆盖），滚动生效（不依赖热更）；验证：改挂载文件→滚动→内容更新且镜像摘要不变（单测层面以目录优先级覆盖逻辑验证）

## 2. 公开摘要端点

- [x] 2.1 `GET /api/public/summary`：入 `public_record_routes.py` 同 router，复用 `is_enabled=True, visibility="public"` 过滤器，响应 `{counts, featured}` 且卡片不含后端地址，挂既有 rate limiting；验证：pytest 覆盖匿名 200 / 非公开条目计数与列表均不出现 / 响应无后端 URL 字段
- [x] 2.2 策展精选复核：精选清单来自部署期策展 JSON，端点逐条按 public+enabled 复核、不满足静默剔除；验证：pytest 两例（策展含 private 条目→剔除且端点正常 / 策展全失效→counts 仍在）

## 3. 品牌统一

- [x] 3.1 i18n 字典品牌串：中文态「壹座·Packs」、英文态「Yizuo Packs」，页头/标签页/登录页走既有 `t()` 通道；验证：`i18n:scan` 0% 缺译 + frontend-test 标题断言更新后全绿
- [x] 3.2 管理面回归：管理面语言与品牌呈现不变；验证：frontend-test 管理面既有断言不改动而通过

## 4. 出片与部署（标准线）

- [x] 4.1 fork 分支 CI 全绿：pytest 两套 + frontend-test + i18n:scan；验证：CI run 链接入台账
- [x] 4.2 fd-1.2.0 标准线出片：GHA → hkccr → relay → ccr（禁节点本地 build）；验证：ccr 可拉镜像 sha-<hash>，登记入 `docs/registry-fork-patches/README.md` fd 发布表
- [x] 4.3 GitOps 滚动：ConfigMap（落地页正文+策展 JSON）先 apply，再滚镜像（cheap-8 ArgoCD）；验证：生产 `/api/version` = fd-1.2.0，`docs/registry-maintenance.md` §9 登记
- [x] 4.4 生产验收（proposal 五条口径）：匿名 `/` 200 无登录跳转 / 带会话进控制台 / `/api/public/summary` 不泄露非公开条目（对照一枚已知 private 条目）/ 客户面标题=壹座·Packs / 出片台账登记齐；验证：验收探针输出留档 tasks 勾销注记

## 5. paas 侧收口

- [x] 5.1 应用中心卡片换链：`web/src/lib/appCatalog.ts` Packs 卡片直达 `mcp.finddatatech.cloud`；验证：web e2e 卡片直达断言绿
- [x] 5.2 台账收尾：`docs/registry-fork-patches/README.md` + `docs/registry-maintenance.md` 双账齐全；验证：两文件 diff 入提交，openspec archive 前置条件满足

---

## 实施注记（2026-10-15 收口）

- **1.1/1.2**：分流=会话 cookie 存在性（`registry/main.py` serve_root）；落地页 `registry/static_landing/index.html` 四区锚点（landing-hero/steps/market/dev）。测试 `tests/unit/test_root_path_split.py` 6/6。
- **2.1/2.2**：`/api/public/summary`（public_record_routes.py）；测试 `tests/unit/api/test_public_summary.py` 7/7——mock 模拟 DB 侧过滤（防过滤器漂移假绿）+ handler 二重复核（纵深防御）。
- **3.1/3.2**：品牌串三处默认（t.ts/useUiTitle.ts/config.py effective_ui_title）+ zh 字典；i18n:scan 1301/1301 PASS；I18nContext 4 绿、deployment_mode 49 绿。frontend 三套 13 红=预存（stash 基线实证，本仓在册"本机树坏"项）。
- **4.1**：FindDataTechnology 私有池额度尽（2011/2000）→ 判红两分法定性 → testaction005/build-pool 快照线。fd-build-snapshot 分支坑（默认 clone main，须 --ref）+ 先推后设变量竞态坑，均在册。
- **4.2**：sha-689ec5e（真 sha f8ccd531，BUILD_VERSION=fd-1.4.0）relay OK + ccr skopeo digest 7784b015。
- **4.3**：GitOps 0f6a9f1（换 tag + landing-config ConfigMap 挂 /app/public-featured）；**双宿主收口**：Caddy 三处上游 100.64.0.11:18080（cheap-1 compose 旧栈）→ 100.64.0.15:18080（cheap-8 k8s）——onboard-registry-argocd 双轨观察期就此完结；Secret `mcp-registry-env` 过时 BUILD_VERSION=fd-1.3.0 覆盖镜像 ENV → patch fd-1.4.0。
- **4.4 五条口径生产探针**：①匿名 / 200 渲染 landing-hero 零跳转 ✓ ②携 mcp_gateway_session cookie 200 出 SPA 壳无 landing 锚点 ✓ ③/api/public/summary 匿名 200 {servers:12,agents:10,skills:128} featured=[]，未知条目 404 ✓ ④/api/version=fd-1.4.0 + ui_title=壹座·Packs ✓ ⑤出片双台账登记（fork README §二 + 本仓 registry-maintenance §9.4）✓。
- **5.1**：agents.json yizuo-packs url → https://mcp.finddatatech.cloud（paas fd42437）；app-center e2e 4/4 绿（fast project）。
- **验收记录**：docs/registry-maintenance.md §9.4 为准。

### 补丁一：登出闭环 + 根路径缓存契约（2026-10-15，生产 sha-115fea3）

用户报两症状，均为真缺陷，已修并上产：

1. **登出后停「已成功退出」页（5 秒跳 /login）而非首页** → 确认屏自动跳转改 `/`（匿名态即落地页），主按钮「返回首页」+次级「重新登录」；`/logout` 保留为 IdP 已注册回调（改 redirect_uri 需 Logto 侧登记，不划算）。
2. **再进首页直接进登录页** → `/` 按 cookie 分叉未声明 `Vary: Cookie`，浏览器复用登录态缓存的控制台壳 → SPA 401 → 跳 /login。两变体均补 `Vary: Cookie` + `Cache-Control: no-cache`。

**测试**：root-split 10 绿（新增 4 条缓存契约）、Logout 页 5 绿（含 4999ms 边界）、i18n:scan 1302/1302、真浏览器全链探针 8/8（`scripts/probe-login-logout.mjs` 可复跑）。
**探针教训**：`/logout` 是 IdP 回调确认屏，不结束会话；真登出=`POST/GET /api/auth/logout`。第一版探针走错路径造出假失败。

### 补丁二：Logto 登出闭环（2026-10-15，双镜像 sha-8b376ae）

真点 Sign out 验证（`scripts/verify-logout-return.mjs`）揪出补丁一没覆盖到的最后一环：登出停在 Logto 自己的成功页，不回我们域名。两根因均修：
1. auth-server `oauth2_logout` 加 Logto 分支（标准 OIDC RP-initiated：`post_logout_redirect_uri`+`id_token_hint`）——此前落 Cognito 形状 else 分支，`logout_uri` 被 Logto 静默忽略；
2. registry 端 `redirect_uri` 改指裸 origin `/`——Logto 客户端白名单登记的就是 `/`（管理 API 实证），登出时会话已清、根路径即落地页。

测试 22 绿（logto_logout 5 + logout_handler 17）；用户视角验证 5/5：登录→控制台→点 Sign out→**最终落产品首页**→cookie 清除→再进 `/` 落地页。GitOps force-push 竞态一坑在册（rebase 重放处置）。
