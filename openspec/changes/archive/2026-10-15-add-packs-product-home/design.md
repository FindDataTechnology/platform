# add-packs-product-home — design

## Context

- registry 为独立谱系 fork（ADR-0017，fd-x.y.z），生产在 cheap-8 k8s（ArgoCD GitOps、Caddy 前置），域名 `mcp.finddatatech.cloud`。
- 现状根路由：`GET /` 直接 `FileResponse(FRONTEND_BUILD_PATH/index.html)`（`registry/main.py:1590`），匿名访客由客户端跳 `/login`——门面缺失的根源。
- 公开面现状：`registry/api/public_record_routes.py` 只有单条端点（`/api/public/servers/{path}/server.json` 等），过滤器形状 = `is_enabled=True, visibility="public"`，非命中 404 不泄露存在性；**无列表端点**（实测 `/api/public/servers` 404）。
- 客户面先例：fd-1.1.0 控制台中英双语（管理面按设计保持英文）、fd-1.1.1 `ui_title` 收敛到 `t()` 单通道；frontend-test workflow + `i18n:scan` 覆盖门禁在产。
- 上游留有 `landing/template.html`（英文通用营销页），fork 未接线。
- 出片标准线：GHA → hkccr → cheap-3 relay → ccr；版本惯例 minor = 客户可感知功能新增。

## Goals / Non-Goals

**Goals:**

- 匿名 `/` 即产品门面：秒开、中文、无需登录即可理解产品并按三步指引行动。
- 市场活数据进入门面，但不扩大公开攻击面（不新增全量枚举能力）。
- 文案迭代与镜像发布解耦。
- 品牌统一落在既有 i18n 通道上，测试门禁照常生效。

**Non-Goals:**

- 不做英文全量对译落地页（首期中文为主）。
- 不做独立静态站 deployment（方案 B 已被 ConfigMap 载体吸收）。
- 不动管理面语言/品牌设计；不动控制台登录后的信息架构。
- 不做公开全量列表/搜索端点（摘要+精选即止）。

## Decisions

### D1 分流判定 = 会话 cookie 存在性（服务端）

`GET /` 服务端检查会话 cookie 是否存在：无 → 服务落地页；有 → 沿用 `FileResponse(index.html)`。只查存在性、不做会话校验。

- 为什么服务端而不是客户端分流：匿名访客不应先下载 SPA 再被弹走；门面要秒开。
- 为什么存在性而不是校验：根路径是最热路由，每发请求加会话存储往返不值；携过期 cookie 的用户拿到控制台壳后弹登录，与今天过期会话的行为完全一致（语义不变）。
- 备选否决：Caddy 边缘按路径分流——边缘看不到认证态，`/` 必须同时服务两类人群；独立子域——破坏"产品 URL 即官网"的叙事。

### D2 落地页 = registry 进程服务的静态资产，ConfigMap 覆盖

落地页为纯静态单页（无前端框架依赖），由 registry 进程直接服务。镜像内置基线资产目录；部署时 ConfigMap 挂载覆盖同目录。改文案 = 改 ConfigMap + 滚动重启，镜像不动（满足 spec"滚动或热更"的滚动路径）。页面同源拉取 `/api/public/summary` 渲染市场内容区。

- 已知坑入账：ConfigMap subPath 挂载不热更（在册教训），本设计明确走"滚动生效"，不依赖热更。
- 备选否决：独立静态站+自有网关——多养一个 deployment，且方案 A 的迭代优势已由此吸收。

### D3 摘要端点 = public 路由族内新增，只吐计数+策展精选

在 `public_record_routes.py` 同一 router 内新增 `GET /api/public/summary`，复用同文件已审计的过滤器形状（`is_enabled=True, visibility="public"`）。

- 响应 = `{counts:{servers,agents,skills}, featured:[卡片]}`；卡片只含 name/displayName/description/tags/记录路径，**不含后端地址**（与非 admin 的 URL 抹除策略一致）。
- 精选清单来自部署期策展资产（与落地页同族的 ConfigMap JSON）；端点逐条按 public+enabled 复核，不满足者静默剔除（fail-closed，spec 场景钉死）。
- 无凭据可访问，但挂既有 rate limiting 中间件。
- 备选否决：公开全量列表——枚举面大、门面用不上；由 paas 桥接快照代理——引入跨域与部署耦合，同源直取最简。

### D4 品牌 = i18n 字典换串，走既有 `t()` 通道

「AI 网关与注册处」→ 中文态「壹座·Packs」、英文态「Yizuo Packs」。fd-1.1.1 已把页头/标签页/登录页品牌串收敛到单通道，改动 = 字典层。`i18n:scan` 门禁必须保持 0% 缺译；frontend-test 的标题断言随串更新。

### D5 发布 = 单次 fd minor（fd-1.2.0），标准线 + 双台账

路由补丁、资产、端点、品牌串一次发布携带；`docs/registry-fork-patches/README.md` fd 发布表登记镜像 sha 与验收口径，`docs/registry-maintenance.md` §9 发布记录同步。paas 侧 `appCatalog.ts` 卡片换链骑 paas web 自己的滚动，不与 registry 出片耦合。

## Risks / Trade-offs

- [无凭据端点成为爬取/枚举入口] → 只吐聚合计数+策展精选（非全量）、挂速率限制、复用已审计过滤器；泄露语义有 spec 场景与验收探针双保险。
- [携过期 cookie 的访客仍看到登录弹跳] → 与现状行为一致，不为门面引入根路径会话校验开销；接受。
- [ConfigMap 生效依赖滚动，误以为热更] → 设计明文"滚动生效"；运维手册口径统一。
- [品牌串改动牵连 e2e 断言] → frontend-test + i18n:scan 两门禁绿是出片前置；断言更新纳入任务清单。
- [上游 landing 模板被误复用] → 明确否决（英文、上游品牌）；仅作布局参考。

## Migration Plan

1. fork 分支实现四件（分流/资产/端点/品牌串）+ 单测；CI 两套 pytest + frontend-test + i18n:scan 全绿。
2. 标准线出片 fd-1.2.0，登记 sha。
3. GitOps：ConfigMap（落地页正文+策展清单）先 apply，再滚镜像。
4. 生产验收（proposal 五条口径：匿名 200 无跳转 / 带会话进控制台 / 摘要不泄露 / 标题=壹座·Packs / 出片登记）。
5. paas web `appCatalog.ts` 卡片换链滚动。
6. 回滚：镜像回上一 fd tag；ConfigMap 留存（无消费者则惰性无害）。

## Open Questions

- 英文品牌串最终拼写（暂定「Yizuo Packs」，不阻塞）。
- 精选策展初始清单条目（运营内容，不阻塞架构）。
- 落地页访问统计是否复用既有 RUM 钩子（`RUM_SNIPPET_B64` 机制已在产，可后挂）。
