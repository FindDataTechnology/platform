# add-login-hero

## Why

登录页是未登录用户唯一可见的页面，现状是一张功能性卡片：盾图标 + "此部署使用组织单点登录。请登录以继续使用 {{company}}" + 单个 SSO 按钮 + 语言切换器，无任何产品气质。同时 `LoginPage.tsx` 属于开源代码，自部署 fork 也在用它——寻数的营销内容不能硬编码。2026-10-07 拷问定案：槽位化 split-screen hero，寻数云端（platform.finddatatech.cloud）配置完整叙事，未配置时降级为现有中性单列卡，开源默认形态不变。

## What Changes

- split-screen 布局：左侧 hero（品牌渐变背景 + 标题 / 副题 / 要点 2-4 条 + 可选图片槽——槽位留而不用，纯排版起步），右侧登录卡（SSO 入口、locale 选择器、auth_error 展示逻辑零变化）
- 品牌槽位扩展：`loginHero` 槽位组（标题、副题、要点列表、图片 URL、链接行 label+url 对）进入现有 branding 面——`GET /api/config` 暴露、admin 经设置页 BrandingSection 编辑、env 兜底，字段类型/长度校验沿现有 branding 纪律
- locale 覆盖 + 回落：槽位值支持按 locale（`zh-CN` / `en`）配置，未覆盖语言回落 en；登录页现有 5 语言切换器保留
- 降级语义：hero 槽位全空 → 渲染现状中性单列卡；部分配置按字段级回落，不出现半残布局
- 寻数云端文案 zh-CN + en 双写（es/fr/ja 走回落）；底部链接行 = 官网 · 文档，下载入口留在官网不进登录页
- 明确不做：产品截图素材管线、Logto 托管登录页（输密码那页）的品牌化、注册流程、移动端专属形态（响应式适配即可）

## Capabilities

### Modified Capabilities

- `deployment-branding`: branding 面从 4 字段（companyName / assistantName / brandIconUrl / loginFooterText）扩展 `loginHero` 槽位组——locale 覆盖与字段级回落语义、长度界限、admin 编辑面；登录页消费语义升级为 split-screen + 未配置降级单列

（`auth` capability 不动——SSO 流、rd 校验、ui_locales 传递、回调行为零变化，纯呈现层。）

## Impact

- **web**：`LoginPage.tsx` 重构为双栏 + 降级分支；`useAppConfig` / `useBranding` 类型扩展；5 语言 common.json 增 `login.hero.*` 键
- **server**：branding 路由（`GET /api/config`、`PUT /api/config/branding`）扩展槽位字段与校验；env 兜底键
- **设置页**：BrandingSection 增 hero 编辑面（admin 可见可改）
- **寻数云端部署**：上线时以 env/GitOps 配置 zh-CN + en 槽位值（部署动作，非本仓代码）
- **测试**：单测（槽位解析 / locale 回落 / 校验界限）+ e2e（未配置 = 现状形态不回归、配置后双栏渲染、locale 切换、auth_error 展示不回归）
