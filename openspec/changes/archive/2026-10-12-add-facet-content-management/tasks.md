# Tasks — add-facet-content-management

## 1. 数据面与 API（gateway/packs.js + facet 服务）

- [x] 1.1 packs 表加 `category`/`featured` 两列（boot ALTER 兼容）；row 映射与 listing/detail/versions 端点带出两字段；listing 支持 `?category=` 与 `author=me`（viewer 邮箱过滤，私有包含作者本人行）。验证：服务端单测（registry 层 category/featured 过滤与作者过滤断言）。
- [x] 1.2 validateManifest 加可选 `category` 形状校验（slug `[a-z0-9-]` ≤32）；publish 落库时带出作者声明。验证：manifest 单测增补用例。
- [x] 1.3 `PUT /api/packs/:id/curation`：featured 仅 admin、category author-or-admin；写后返回新态。验证：单测三例（admin 全可、作者仅 category、陌生人全拒）。
- [x] 1.4 marketplace.json 面带出 category/featured。验证：单测断言 JSON 字段。

## 2. facet 服务代理与壳

- [x] 2.1 facet/index.js 加 `GET /api/ops/pack-usage` 只读代理（admin 会话门；env PLATFORM_INTERNAL_URL+PACK_USAGE_TOKEN；不可达 503）。验证：本地起 facet + stub 上游，断言透传与降级两态。
- [x] 2.2 壳 tab 条条件化：whoami groups → mine/curate tab；未授权 hash 回落 intro；i18n 五语补键。验证：本地 dev 匿名只见三 tab。
- [x] 2.3 MineView（作者面）：作者过滤列表+版本历史+unpublish+visibility 切换+从清单发布（粘贴/上传，校验错误透传）。验证：本地 dev 真 Logto 或 x-facet-token 注入身份走通发布→列表→下架全动作。
- [x] 2.4 市场视图策展呈现：垂类 chips（现存值推导）+ `?category=` 过滤 + featured 置顶 rail。验证：本地 dev 断言过滤与置顶。
- [x] 2.5 CurateView（策展板）：全量列表（admin 视角含 unlisted/private）+ 垂类/精选在线改 + 用量板块（代理可达/降级两态）。验证：本地 dev admin 身份走通改类+精选+读数。

## 3. 哨兵网与回归

- [x] 3.1 facet-shell-server.mjs 扩展（FACET_INTERNAL_TOKEN 设置 + creator/admin 种子包），facet-shell.spec 扩：条件 tab 场景（匿名三 tab）、x-facet-token 注入身份断言 mine/curate 渲染、curation API 真调用（改类→listing 反映）。验证：spec 全绿。
- [x] 3.2 本地回归全组：lint/typecheck/unit/build + fast e2e 全跑。验证：退出 0。

## 4. 上线与验证

- [x] 4.1 提交 main → law-ai-official/platform-images 快照出片 → relay → ccr 实证（skopeo 带凭据）。
- [x] 4.2 fd-infra-deploy：platform.yaml + facet.yaml 滚 tag；facet.yaml 增两 env（PACK_USAGE_TOKEN 经 secret）。验证：ArgoCD hard-refresh + 双 rollout status。
- [x] 4.3 线上验证：#/mine（真创作者登录）列表+动作；#/curate admin 改类/精选后市场反映；用量板块读数或诚实降级；#/packs 垂类过滤+精选 rail；哨兵场景线上抽查。
- [x] 4.4 首轮垂类归类（admin 手工：法律/legal、文档工坊/doc-studio、自助分析+指标工坊/daas、spider-heal/spider-heal、演示包归 misc 或留空）。
- [x] 4.5 docs/facet-wanxing-roadmap.md M1 决策修订注记 + openspec 归档（validate --specs 先行）。
