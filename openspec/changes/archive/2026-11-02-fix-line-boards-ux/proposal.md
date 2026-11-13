## Why

柏讯/谦面两块线看板被用户走查判为「过于简单、违反交互设计范式、无法回退到应用市场」（问题④⑤）。代码取证坐实四类缺陷：

1. **回退陷阱**：标签切换以 `window.location.hash = tab` 驱动，每次点标签向浏览器历史压入一条记录——回退键先要逐条退完标签才轮得到 `/apps`；页面自身也没有任何「返回应用中心」控件（`/boards/*` 不在侧边导航内，无高亮可点）。
2. **两页签恒空**：块-标签过滤用 `block.id.includes(currentTab)`，而谦面页签名用连字符（`my-packs`/`publish-history`）、块 id 用下划线（`my_packs`/`publish_history`），永不匹配——三页签中两个只渲染一张「最近事件」空卡。
3. **假数据 + 裸键**：`FacetBoardAdapter` 是硬编码占位（`{ weeklyActivePacks: 0, totalInstalls: 0 }`，TODO 未接 facet-market API），且指标块把数据键原文当标签渲染——页面上直接出现英文裸键。这违反 line-boards 既有条文「MUST NOT 渲染空看板或伪造数据」。
4. **范式外之面**：BoardsPage 是唯一未迁入批②设计系统（PageShell/StatusPill/EmptyState）的主要面，页头、空态、状态呈现均自成一派。

## What Changes

- 标签切换不再污染历史：以 `history.replaceState`（或 router state）同步当前页签；浏览器回退键一步回到进入看板前的页面。
- 看板页头新增「返回应用中心」面包屑/返回控件（testid 钉死），与「打开原站」并排。
- 块-标签显式契约：适配器为每个块声明所属页签（`tab` 字段），渲染器按字段匹配，不再以 id 子串猜测；修掉谦面两页签恒空。
- 指标标签本地化：指标块数据携带标签（或标签键），渲染器 MUST NOT 把数据键原文当标签；谦面 `weeklyActivePacks`/`totalInstalls` 裸键消失。
- 谦面数据诚实化：接入 facet-market 真实读面（周活跃包数 / 总安装数 / 我的包 / 发布记录）；上游或凭据未就绪的块如实降级为「建设中」，MUST NOT 以硬编码零充数。
- BoardsPage 迁 PageShell/StatusPill/EmptyState，页头标题为第一读点，与批②五面对齐。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `line-boards`: 「看板由声明式块组成」增补块-页签显式契约与指标标签本地化；新增「看板页签不污染回退路径且提供返回应用中心入口」；新增「谦面看板直读市场数据或如实标注建设中」（对齐柏讯已有的数据诚实条文）。

## Impact

- `web/src/pages/BoardsPage.tsx`（标签机制、返回控件、设计系统迁移、指标渲染）
- `lib/board-adapters.js`（块 `tab` 字段；FacetBoardAdapter 真数据/诚实降级）
- `server/routes/boards.js`（块契约透传，如需）
- `web/src/locales/{en,es,fr,ja,zh-CN}/common.json`（`board.*` 新键五语）
- `facet-market` 读面调用（凭据复用 `facet-market-credentials`，与柏讯线凭据纪律同形）
- `web/e2e/`（看板回退一步到位、谦面三页签非空或如实降级、裸键哨兵）
