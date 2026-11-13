# Design: add-pack-tutorials-and-wizard

## Context

R2 的六包指南是客户端内容模块（`packGuides.ts` 按 packId 键控）；R3 之后市场详情、专家 tab、欢迎页提示卡都已就位。R4 把教法交给创作者（manifest 随包分发）并接顺安装动线。发布校验链：`gateway/packs.js` → `lib/pack-manifest.js validatePackManifest`；编辑器 `PackDraftsView.tsx`；详情 `PackDetailDialog.tsx`；订阅报告 `PackMarketView.tsx`。MP 端 zh 串内联（无 locale 文件），命名同步 5 文件 ~10 处。

## Goals / Non-Goals

**Goals:**

- 创作者能写、发布能校、详情能显（manifest 优先）、装完有人带
- 存量包零迁移、向后兼容
- MP 端命名与产品一致

**Non-Goals:**

- 不做指南的富文本/图片（纯 title+body 文本）
- 不翻译创作者内容（与人格同语言策略）
- 欢迎页提示卡不走 manifest（catalog 条目不携带 guide——改 catalog 合并超范围；欢迎页提示继续走客户端模块）
- MP 端不发版（代码同步，提审另行）

## Decisions

### D1 guide 字段 = 恰好三步，强 shape
`guide.steps` 长度必须 === 3（产品语义"三步走"，不是通用 markdown 容器）；title 1..60、body 1..500 非空字符串。`PACK_LIMITS` 增 `maxGuideStepTitleChars: 60`、`maxGuideStepBodyChars: 500`。校验在 `validatePackManifest`（gateway 发布自然继承；facet CLI 安装侧不校验 guide——安装只取 skills）。字段可选，无 guide 走原路径。

### D2 渲染链 manifest → 模块 → 无
`PackDetailDialog` 的 `guide` 解析改为：`pack.manifest.guide`（规范化为 PackGuide 形状）→ `guideFor(pack.id)` → null。客户端模块继续兜底六首发包（它们的 manifest 尚无 guide）；创作者一旦写了 guide 即以创作者为准。示例提问只来自客户端模块（manifest 不携带 prompts——示例是平台运营内容）。

### D3 编辑器三步区 = 6 个输入 + 现有保存链
`PackDraftsView` 在 description 之下加「使用指南（三步）」折叠区：三组 title/body 输入，绑定 draft manifest 的 guide 字段；前端长度计数提示（复用 personaCost 风格），服务端发布校验兜底。不新增草稿 API 字段——guide 随 manifest JSON 整体存取。

### D4 向导 = 报告面板页脚 + 跳转
`PackMarketView` 的报告浮层底部追加页脚：一句引导 + 「打开对话」按钮（navigate("/chat") + 关闭报告）。报告本体（清单/掩码/关闭）一行不动。

### D5 MP 命名同步 = 纯字符串替换
FileChip（3 处）、HistoryDrawer（1）、resources 页（2）、resources.ts（4）。资源库→成果、存入资源→存入成果、工作区→项目。注释行顺手改的不强求——只动用户可见串。

## Risks / Trade-offs

- [创作者写了低质量 guide 拉低详情页] → shape 上限兜底（3×60/500）；质量靠发布者声誉，平台模块内容仍是六包兜底。
- [welcome 提示与 manifest 脱节] → 明确分层：欢迎页提示=平台运营内容（模块），详情指南=创作者内容；R4+ 若要创作者提示需 catalog 携带，单独立项。
- [MP 提审与镜像发布解耦造成端上命名暂不一致] → MP 新版本提审通过前旧命名可见，可接受（微信节奏既定）。
- [强推快照仓的 workflow 重建已在 R3 落地] → 本期镜像发布直接复用 a3f0289 线的 image-publish.yml（已在镜像仓），无额外动作。

## Migration Plan

单镜像滚动。manifest 加可选字段：旧客户端读新包忽略 guide（不认识的字段天然忽略）；新客户端读旧包走模块兜底。回滚=revert 镜像 tag。

## Open Questions

- 无。
