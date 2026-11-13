## Why

用户令（2026-11-02）：「壹座·packs」更名为「壹座·智能体素材广场」。native-lexicon v4（2026-10-30）把品牌串裁定为「壹座·智能体基础设施」，但该串在当前树零渲染点；市场面现名「智能体市场」。素材广场官网（add-agent-materials-plaza）将以此名为品牌锚，词汇须先收口——改名是官网班的前置件。

## What Changes

- 词汇 v5 裁定（MODIFIED native-lexicon 首需求）：
  - 产品品牌：「壹座·Packs」→ **「壹座·智能体素材广场」** / "Yizuo Agent Materials Plaza"（v4 的「壹座·智能体基础设施」裁定被取代；该串零渲染点，无存量迁移）。
  - 市场/店铺面：「智能体市场」/ "Agent Market" → **「智能体素材广场」** / "Agent Materials Plaza"（glossary、facet footer、app-center tagline、市场 gallery、onboarding 提及）。
  - 单位词「智能体」/ "Agent" 不变；「素材（Material）」入册为属词——广场上一件可被人与 AI 理解、获取、运行的供给物；功能集/生态技能/MCP 服务/AI 分身/官方数据锚是种词，全部沿用。
- 显示层改名落地（零 API 改，先例：舰队词汇两段决议——新 UI 沿用终词，键/API 零改）：
  - 壹座 web zh 6 处 + 四语平行键：`packs.tabs.market`、footer `entries.packs`、app-center tagline、onboarding/starter 提及、savedAs 提及。
  - facet shell：`facetIntro.title/subtitle`、`facetFooter.entries.packs`。
  - `CONTEXT.md` 新增「素材广场（Materials Plaza）」与「素材（Material）」词条（Avoid：插件市场、应用商店、资源广场）。

## Capabilities

### New Capabilities

（无——纯词汇与显示层改名，不引入新行为面。）

### Modified Capabilities

- `native-lexicon`: v5 修正 v4 首需求——品牌 bullet 与 store 终词改为素材广场口径；MODIFIED 携带全场景超集（含新增品牌串场景与五语一致性更新）。

## Impact

- 代码：`web/src/locales/{zh-CN,en,es,fr,ja}/common.json`（显示值改、键零改）；`facet/web` 复用同源 locale 文件，无独立改点。
- 门：`check-locales` 五语 parity 门（改后必绿）；无 API/schema/DB 变更。
- 文档：`CONTEXT.md` 词条；`docs/plaza-explore.md` 底稿已记裁定。
- 依赖关系：本 change 是 `add-agent-materials-plaza` 的前置——官网品牌串、页脚入口、AI 面实体写全纪律均引用「壹座·智能体素材广场」终词。
- 外部记挂（不在本仓 change 内）：www 官网 products/facet 页加指向广场链接；registry 仓 landing 品牌串同口径（v4 已有先例注记，沿用）。
