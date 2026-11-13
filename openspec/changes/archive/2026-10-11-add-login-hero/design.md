# add-login-hero — Design

## Context

现状通路：branding 走 `server/routes/misc.js` 的 brandingField（store → env → null）+ `GET/PUT /api/config(/branding)`，web 侧 `useAppConfig` 消费、`BrandingSection` 编辑、`LoginPage.tsx` 渲染中性单列卡。约束：LoginPage 属开源代码，自部署 fork 同源使用——寻数营销内容只能走配置；登录页已有 5 语言切换器与既有 e2e（`login-locale-select`/`sso-login`/auth_error 展示）不可回归。

## Goals / Non-Goals

**Goals:**
- 配置驱动的 split-screen hero：寻数云端配全，任何未配置部署渲染现状中性单列卡
- locale 覆盖 + 回落（zh-CN/en 双写，其余语言回落 en）
- 槽位进现有 branding 面（GET /api/config / PUT admin / env 兜底 / BrandingSection 编辑），机制与 4 字段同纪律

**Non-Goals:**
- Logto 托管登录页（输密码页）品牌化
- 产品截图素材管线（图槽留而不用）
- 注册流程、价格展示、桌面客户端下载入口（官网的事）
- hero 内容的多语言自动翻译

## Decisions

**D1 — loginHero = 结构化 locale map 单字段，非平铺键。**
平铺键（`LOGIN_HERO_TITLE_ZH`…）随 locale×字段数爆炸；定为单 store 字段 + 单 env `LOGIN_HERO`（JSON 全量同形）。`misc.js` 的 brandingField 是字符串专用，loginHero 走并列的结构化分支（parse + 结构校验 + WARN 降级），不塞进既有函数。

**D2 — locale 键闭集 + 两级解析链。**
键闭集 = i18n 支持语言（en/zh-CN/es/fr/ja），写时拒绝未知 locale（防静默永不匹配）。web 侧单一 helper `resolveLoginHero(loginHero, locale)`：当前 locale → `en` → 无 hero；单测锁链。服务端不解析 locale（只校验结构），解析只在一处。

**D3 — 降级分两层：hero 面板与 links 行独立。**
hero 面板渲染条件 = title/subtitle/points/image **经解析后至少一项存在**；links 独立渲染为卡下细行（只配 links 的部署也能用）。完全未配置 → 无 hero 元素，与改动前形态一致。字段级缺省（有标题无副题）就地塌缩不留空壳。

**D4 — 布局与回归纪律。**
md+ 断点双栏（hero 左、登录卡右），移动端堆叠（hero 上、卡下）。右侧登录卡的 DOM 顺序、既有 testid（`sso-login`/`login-locale-select`/`login-continue-anonymous`/`login-footer`）零改动；hero 面板挂 `login-hero` testid，降级时该元素不存在——既有 e2e 无感通过。

**D5 — 内容零 i18n 键（对 proposal 的小修正）。**
hero 文案全部来自配置，无"缺省营销文案"可言——common.json **不新增** `login.hero.*` 键（proposal 原写"增键"，按此修正；降级形态继续用既有 `login.*` 键）。少一套键就少一次 5 语言同步负担。

**D6 — BrandingSection 编辑面 = locale 下拉 + 行文本解析，不做 JSON 编辑器。**
locale 下拉（闭集 5 项）+ 字段：title/subtitle 单行、points 每行一条（≤4）、links 每行 `label | url`（≤4）、imageUrl 单行。行解析错误就地提示、整块不入库；存库仍为 D1 结构化 JSON。admin 门禁沿 branding 现状。

**D7 — 寻数云端上线 = 部署侧 env，代码仓只交付机制。**
fd-prod 以 k8s env `LOGIN_HERO`（zh-CN + en 双写）配置，随 GitOps 滚动生效；文案终稿实施时交付，不进仓。

## Risks / Trade-offs

- [`LOGIN_HERO` env 手写 JSON 出错] → parse/校验失败按 unset 处理 + WARN 日志（spec 场景已定），不炸启动、不炸其他 branding。
- [自部署 fork 被迫看寻数营销] → 默认 null；"unconfigured hero keeps the neutral card" 场景锁死像素等价。
- [既有登录 e2e 回归] → 降级形态等价 + testid 不动（D4）；新增用例只测配置态。
- [桌面 settings.json 注入] → branding env 机制先例已覆盖（desktop settings.json 即 env 来源），无需桌面侧代码。

## Migration Plan

无数据迁移：branding store 新字段可选，未写即 null。回滚 = revert 提交（未配置部署行为与改动前一致）。寻数云端 env 配置独立于代码发布，可先行可后撤。

## Open Questions

- 寻数云端 hero 文案终稿（zh-CN + en，实施时交付；不阻塞机制）。
- 图槽是否首发即配图（默认不配，纯排版渐变）。
