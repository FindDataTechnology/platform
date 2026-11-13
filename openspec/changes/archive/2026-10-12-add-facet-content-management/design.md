# Design — add-facet-content-management

## Context

见 proposal.md。地基事实：pack registry 归屋 facet（ADR-0015），publish/unpublish/listing/detail API 在 facet 服务端已全量服务（gateway/packs.js 同一模块）；缺的是谦面域的 UI（作者面/策展板）与策展数据面（两列一路由）。壹座网关已有 /api/ops/pack-usage 聚合（PACK_USAGE_TOKEN 门，gateway/index.js:615）。

## Goals / Non-Goals

- Goals：谦面域内闭环「我发布的怎么管（作者面）/ 架上怎么组织（策展）/ 供给决策依据在哪读（用量）」；与 fix-facet-packs-crash 建立的哨兵网同轨扩覆盖。
- Non-Goals：不搬装机面与 cell 草稿面（D8；/api/mypacks 在谦面维持 501 软拒）；不建分类学表/标签体系（垂类=自由 slug，由现存值推导 chips）；不动遥测采集侧（cells→网关的聚合链原样，facet 只读代理）；不做计费/分成面（M3 已另有归属）。

## Decisions

1. **「我的」= 作者面，不借壹座 MyPacksView。**
   壹座 MyPacksView 是装机面（/api/mypacks = cell 本地态），借到谦面语义就是错的。MineView 新写（薄）：作者过滤列表（listing 加 `author=me` 参数，服务端过滤而非客户端筛——私有包也要出现在作者自己的列表里，客户端筛拿不到被 listing 排除的私有行）+ 版本历史（既有 versions 端点）+ unpublish/visibility 动作（既有端点）+ 从清单发布（既有 POST /api/packs，manifest JSON 粘贴框 + 文件上传二选一）。

2. **策展数据面：packs 表加两列，不上独立表。**
   `category TEXT NOT NULL DEFAULT ''`、`featured INTEGER NOT NULL DEFAULT 0`，boot 时 ALTER 兼容存量（仓库既有模式：try/catch ALTER）。category 可由 manifest 可选字段 `category` 声明（validateManifest 加一条：string ≤32、slug 形状 `[a-z0-9-]`），作者可改自己包的 category（复用 curation 端点放宽到 author-or-admin），featured 仅 admin。
   - 备选否决（独立 curation 表 + 关联）：19 个包的规模下纯增 JOIN 复杂度；两列直读直写即可。
   - listing 排序：featured 不改默认排序，由前端呈现为置顶 rail（数据层加 `featured` 字段，市场视图先渲染 featured 集）。保持 listing API 的排序契约不变（newest-first），策展是呈现层职责——这让 marketplace.json 消费者（Claude 插件面）自行决定是否用 featured。

3. **curation 端点：`PUT /api/packs/:id/curation`，body `{category?, featured?}`。**
   权限：featured 变更仅 admin；category 变更 author-or-admin（作者自发归类的自由度，符合「作者声明+管理员纠偏」的产品语义）。unlisted/private 包 admin 可在策展板看到（策展板列表用 admin 视角的 listing——既有 viewer.admin 通道已支持看到全部）。

4. **用量代理：facet → platform 网关，集群内 service 直连。**
   facet/index.js 加只读代理路由 `GET /api/ops/pack-usage`（admin 会话门），后端转发 `http://platform:3000`（同 namespace service 名）+ `Authorization: Bearer $PACK_USAGE_TOKEN`（新 env，与网关侧同值）。不可达/未配置 → 503 + 板上降级条。不缓存（板是低频管理面）。
   - 备选否决（facet 直扫 cells 库）：跨进程数据面耦合，重且脆；网关聚合已是唯一真源。

5. **壳 tab 条条件化，身份来源 /api/whoami（已有）。**
   whoami 返回 groups；creators 组（PACK_CREATOR_GROUPS env，facet 侧已有）→ mine tab；ADMIN_GROUPS → curate tab。未授权直开 #/mine、#/curate → 回落 intro（视图函数把未授权 hash 当 unknown 处理；数据端点本就有门，双保险）。tab 文案 i18n 五语补齐。

6. **哨兵网扩展沿用 fix 的 launcher 模式。**
   facet-shell-server.mjs 扩：seed creator/admin 身份形状不可行（匿名面起服务）——改为 e2e 用 route-mock 拦截 /api/whoami 与 /api/packs*（playwright route 层注入身份与数据），断言条件 tab 出现、mine/curate 视图渲染。真回合的作者面动作（发布/下架/策展）另以服务端 API 直测（curl 形状断言进 spec 的 request 阶段——facet 服务真起、真库、真实身份经 x-facet-token 转发头注入：launcher 设 FACET_INTERNAL_TOKEN，e2e 带头调用即得具名身份，比 route-mock 更真）。

## Risks / Trade-offs

- [manifest 加 category 字段过校验器的存量实现（facet-pack-builder、壹座编辑器）不认识它] → 字段可选、缺省空，旧客户端零感知；validateManifest 只加形状校验不强制。
- [策展板与市场视图并发改 category 的可见性时差] → 单用户管理面，写后即读；不设乐观锁。
- [用量代理依赖 platform service 在线] → 降级条已定（spec 场景）；策展功能不依赖它。
- [#/mine、#/curate 的身份判定基于 whoami 缓存（页面加载时一次）] → 登录/登出是整页跳转（/auth/login→回跳），whoami 重取，无陈旧窗口。

## Migration Plan

与 fix-facet-packs-crash 同一条镜像线滚动（law-ai-official/platform-images）。DB 变更 = boot 时两列 ALTER（幂等）。facet deployment 增两个 env（PLATFORM_INTERNAL_URL、PACK_USAGE_TOKEN——后者值与网关侧现有 PACK_USAGE_TOKEN 同源，经 GitOps secret 或 inline，按 fd-infra-deploy 现有 facet.yaml 的 secret 形状落）。回滚 = manifest revert；两新列留库无害（DEFAULT 兼容旧代码读写）。

## Open Questions

（无——垂类初始值取现存活跃四垂类的 slug（legal/doc-studio/daas/spider-heal），由 admin 首轮手工归类，不写自动归类规则。）
