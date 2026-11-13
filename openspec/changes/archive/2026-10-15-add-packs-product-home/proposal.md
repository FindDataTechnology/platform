# add-packs-product-home

## Why

`mcp.finddatatech.cloud` 是壹座·Packs 的产品本体，但匿名访客落在 `/` 只会被客户端重定向到英文登录墙（现标题「AI 网关与注册处」）——没有产品介绍、没有使用指引、没有市场内容预览。F3 漏斗（五跳生产实证、分成已跑通）的下一步是把人从"听说过"推进到"用上第一个 pack"，而现在的门面做不到这件事；roadmap 已把呈现层缺口列为已知欠账（`docs/yizuo-platform-roadmap.md`），介绍内容的归宿就是各线自己的官网/intro 页。

## What Changes

- **匿名根路径分流**：`/` 无会话 cookie 时渲染壹座·Packs 落地页；有会话照旧进控制台（客户端路由不动）。
- **落地页内容**（中文为主）：一句话价值主张 + 三步上手（逛市场选 pack → 订阅 → 装进环境：壹座 cell 一键装 / MCP 客户端直连）+ 精选目录活数据 + 开发者发布次级入口。正文放 ConfigMap/静态资产，改文案不需要重新出镜像。
- **公开摘要端点**：新增 `/api/public/summary` 形态（计数 + 精选包卡片），只吐 public+enabled 记录，沿 `public_record_routes` 的不泄露语义（非公开/停用条目不暴露存在性）。现有 public 路由只有单条端点、无列表（实测 404）。
- **品牌统一**：控制台客户可达面的标题从「AI 网关与注册处」换为「壹座·Packs」（pack 作为统一消费单位叙事：服务/代理/技能皆为 pack 的组成部分或可直接订阅的能力；管理面不动）。
- **应用中心卡片换链**：壹座·Packs 卡片直达 `mcp.finddatatech.cloud`（`appCatalog.ts` 数据层改动）。
- **出一次 fd minor**：按谱系惯例登记镜像 sha 与验收口径（minor = 客户可感知的功能新增）。

## Capabilities

### New Capabilities

- `registry-product-home`: registry 客户门面——匿名根路径分流行为、落地页内容契约（含内容资产与镜像解耦）、公开摘要端点的不泄露语义、客户可达面品牌串。

### Modified Capabilities

（无——`app-center` 卡片条目与 `registry-console-i18n` 品牌串均为既有契约内的数据/内容层改动，不构成需求变更；fd 发布流程遵循 `registry-lineage` 既有约定。）

## Impact

- **registry fork（`~/code/mcp-gateway-registry`，fd 谱系）**：`registry/main.py` 根路由分流；landing 静态资产接线（上游 `landing/template.html` 仅作参考，不复用其英文内容）；`registry/api/public_record_routes.py` 增列表摘要端点；frontend i18n 品牌串。frontend-test / i18n:scan 门禁照跑。
- **部署（cheap-8 k8s，ArgoCD GitOps）**：ConfigMap 承载落地页正文；滚动换镜像（标准线 GHA → hkccr → relay → ccr）。
- **paas 仓**：`web/src/lib/appCatalog.ts` 卡片链接（数据层）；`docs/registry-fork-patches/README.md` 补丁台账与 `docs/registry-maintenance.md` §9 发布记录登记。
- **验收口径（草案）**：匿名 `/` 200 渲染落地页且无登录跳转；带会话 `/` 进控制台；`/api/public/summary` 只含 public+enabled、非公开条目不泄露；控制台标题=壹座·Packs；出片走标准线并登记 sha。
