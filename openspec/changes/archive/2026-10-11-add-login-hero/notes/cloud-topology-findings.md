# 云端登录面拓扑发现（add-login-hero 6.1 实施实录，2026-10-08）

## 两个推翻假设的架构事实

1. **云端的 /login 从不渲染自家 LoginPage。** gateway 的 catch-all（gateway/index.js app.use）对未认证请求：非 API → 302 /auth/login → Logto 托管 sign-in。自家登录页（split hero 所在）只在**自部署 / 桌面 / forward_auth** 拓扑可达；寻数云端的实际登录面 = **Logto 托管页**（Playwright 截图实锤：Logto 卡片 + "注册"链接）。
2. **Logto 托管页有"注册"入口——云端自助注册是开放的**（探索期"邀请制"假设作废；官网 CTA 可直接指登录页）。

## 连带既有 bug（非本 change 引入）

gateway 401 了**一切**匿名 /api 请求 → `/api/config` 的"匿名可达"spec 语义（deployment-branding）在网关拓扑下从未成立：线上登录页/未登录前端从没拿到过 branding（companyName/loginFooterText 等一直没生效）。

## 已落地的处置

- **6.1 env 侧完成**：`fd-infra-deploy` gitee 269198a（LOGIN_HERO zh-CN+en 双语 JSON）→ ArgoCD hard refresh → live platform-config CM 已含 → platform deployment 已 rollout restart。
- **/api/config 入口桥（临时）**：cheap-1 Caddyfile platform 站点加 `handle /api/config`（反引号 JSON 静态应答：生产真值 FD/packMarketplace:true + 完整 loginHero）。`https://platform.finddatatech.cloud/api/config` 公网 200 实证。**网关代码版修好后删除此桥。**

## 待账单恢复后的正式修法（paas 仓代码变更）

1. gateway 加匿名 `GET /api/config`（env 兜底层语义，同 cell 的 brandingField env 分支）→ 删 Caddy 桥。
2. （决策项）gateway 放行 SPA `/login` + `/assets/*` 到静态 fallback，让自家 LoginPage 成为云端登录首屏（SSO 按钮原生跳 /auth/login）——split hero 由此在云端生效；或接受 Logto 托管页为云端登录面、仅做 Logto 品牌化（logo/主色，放不下 hero）。倾向 2 的前者：自家页是产品面。
3. 官网 CTA 从"联系开通"改为直接指 `https://platform.finddatatech.cloud/login`（注册已开放，② 页面的 hero CTA 文案随之更新）。

## 复现/验证配方

- Playwright 无头：`page.goto("https://platform.finddatatech.cloud/login")` → 落在 Logto 卡片即复现。
- 公网 config：`curl -s https://platform.finddatatech.cloud/api/config | jq .loginHero`。
- k3s server = cheap-6（103.236.97.114:26859，tailnet 100.64.0.13，`KUBECONFIG=/etc/rancher/k3s/k3s.yaml`）；ArgoCD app = `all-services-prod`（ns argocd）；hard refresh = `kubectl -n argocd annotate applications.argoproj.io all-services-prod argocd.argoproj.io/refresh=hard --overwrite`。
