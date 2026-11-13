# add-login-hero — Tasks

## 1. Server 面（branding 槽位扩展）

- [x] 1.1 `server/routes/misc.js`：loginHero 结构化分支——GET 并入 `companyName` 等四字段的响应；PUT 增结构校验（locale 键闭集 en/zh-CN/es/fr/ja、points ≤4、links ≤4 且 url 绝对 http(s)、字符串字段类型与长度上限），失败 4xx 命名到 locale+字段、整写不入库。验证：单测（合法全形/逐类非法形/四字段与 loginHero 混写部分失败整拒）。
- [x] 1.2 env 兜底 `LOGIN_HERO`：JSON parse + 同构校验，失败 WARN 并按 unset 处理（启动与其余 branding 不受影响）；桌面 settings.json 同机制生效不另写代码。验证：单测（合法 JSON 生效/非法 JSON 降级 WARN/STORED 优先）。

## 2. Web 解析层

- [x] 2.1 `web/src/hooks/useAppConfig.ts`：AppConfig 增 `loginHero` 类型（locale map 结构）；新增 `resolveLoginHero(loginHero, locale)` helper——当前 locale → `en` → null；links 与 hero 内容分离返回。验证：单测锁解析链（zh-CN 直配/ja 回落 en/仅 links/空 map）。

## 3. LoginPage 布局

- [x] 3.1 `LoginPage.tsx` split 布局：md+ 双栏（hero 面板左 = 品牌渐变 + 标题/副题/要点/可选图；登录卡右）、移动端堆叠；hero 面板 `data-testid="login-hero"`，降级时元素不存在。验证：单测/组件测试三态（全配/仅 links/未配置）。
- [x] 3.2 降级与回归纪律：未配置时与改动前形态一致；既有 testid（`sso-login`/`login-locale-select`/`login-continue-anonymous`/`login-footer`）与 auth_error 展示零改动。验证：e2e 既有登录用例全绿不改编。

## 4. Settings 编辑面

- [x] 4.1 `BrandingSection.tsx` hero 编辑块：locale 下拉（闭集）+ title/subtitle/imageUrl 单行 + points 每行一条 + links `label | url` 每行一对；行解析错误就地提示、提交走 PUT 整体校验。验证：手测 + PUT 失败路径（4xx 回显）。

## 5. e2e 与语言

- [x] 5.1 e2e 新用例：配置态双栏渲染、locale 切换 hero 跟随回落（en 配置 + ja 切换）、仅 links 形态；未配置态 = 现有用例回归。验证：e2e fast lane 绿（CI 因 Actions 账单暂未跑，本地单 spec 11/11 过：8 既有回归 + 3 hero 新用例；账单修复后重触发 CI 复核）。
- [x] 5.2 五语言冒烟：登录页在 en/es/fr/ja/zh-CN 下渲染无缺键（降级形态用既有键，无新增键——D5）。验证：e2e 或组件快照。

## 6. 寻数云端上线配置（部署侧，非本仓代码）

- [x] 6.1 fd-prod k8s env `LOGIN_HERO`（zh-CN + en 双写终稿）随 GitOps 滚动。验证三证齐（2026-10-11 复核）：prod `curl /api/config` loginHero 双语终稿在位 ✓；登录页双栏 = 6.3 Playwright 实锤（hero 面板/SSO/locale 全渲染）✓；降级路径 live 实证 = platform-demo（无 LOGIN_HERO env）`/api/config` 返回 `loginHero:null` → 旧单栏形态 ✓。
- [x] 6.2 云端生效收尾（notes/cloud-topology-findings.md）：env 已同步+pod 已滚 ✓、/api/config 入口桥已上 ✓；剩网关代码两件（匿名 GET /api/config、放行 SPA /login）待 GitHub 账单恢复后随镜像变更上线——云端 /login 现落在 Logto 托管页（拓扑事实，split hero 云端无显示面，自部署/桌面不受影响）。

- [x] 6.3 网关代码版上线并撤临时桥（2026-10-08）：be083e4 三块（匿名 /api/config+/api/auth/me 带 next() 落 cell、SPA 静态壳）→ 公开仓 image.yml 构建 sha-9f41c5a（2m48s，GHA 缓存热）→ relay 同步 ccr → platform/platform-demo manifest bump（fd-infra-deploy e3fa7cb）→ ArgoCD hard refresh 滚动 → 公网三路由验证 + Playwright 实锤（hero 面板/SSO/locale 全渲染，Logto 卡片消失）→ cheap-1 Caddy 桥已删。测试纪律记录：cell 冷启动依赖首个带身份请求——匿名路由必须 next() 放行带身份流量（test-cell-gateway 抓获的真 bug）；测试断言随身份边界更新（匿名读公开、伪造头买不到身份）。全量 898/898。
