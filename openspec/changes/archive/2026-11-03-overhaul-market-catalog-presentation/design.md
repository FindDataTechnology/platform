# Design — 市场货架从"数据副产品"到"声明式目录"

## Context

谦面市场今天的问题不是"缺样式"，而是**三个结构性错位**，每个错位都在代码里有明确落点：

| 错位 | 落点 | 观测证据（2026-11-02 实测生产） |
|---|---|---|
| 语言是请求参数，不是数据轨道的根 | `packs-api.ts` 的 `localeQuery()` 在读时刻求值；`PackMarketView.tsx:139` 的 `refresh` 只依赖 `[category]`；`PackDetailDialog.tsx:129` 只依赖 `[packId]` | 切到 English 后列表/详情保持原语言，直到手动搜索或重开 |
| 分类是数据的副产品，不是目录 | `PackMarketView.tsx:164` 用 `listPacks({pageSize:100})` 求 `Set(line ?? category)`；`lib/pack-category-lines.js` 为硬编码中文线词 | 分面集合随上架/下架/策展增删；`?locale=en` 的 `line` 与 zh 逐字相同；`company`/`facade` 归 null 后两包从分面消失 |
| 卡片是散文的投影，不是结构的投影 | `PackMarketView.tsx:434` `line-clamp-2` 吃 `description`；manifest 无任何视觉字段 | description 中位 152 / 最长 678 字；70 张卡同形；`agentCount` 在 payload 里但卡片不显示 |

以及一条元问题：**作者端没有多语言入口**（`PackDraftsView` 仅 `i18n.en.mcpServers[].description`），所以"补内容"如果不能同时改"上传格式"，下一个包又回到零点。

## Goals / Non-goals

**Goals**

1. 切语言 → 看到该语言的内容（含分类标签、标签、搜索结果），无需任何手动动作。
2. 分面集合与顺序**不随内容进出而变形**，且永远只有一套语义（线是线，领域是领域）。
3. 卡片在 3 秒内回答四个问题：这是什么 / 谁会供给 / 我会得到什么 / 有什么限制。
4. 上传格式让作者能一次交全"结构性信息 + 多语言"，且老包不写就逐字节不变。
5. 覆盖度的缺口**可见**而不是靠人记。

**Non-goals（明确不做，避免范围失焦）**

- 不翻**内容层**：技能正文、persona、promptTemplate、guide 的 zh 正文仍单语。显示面（name/description/promise/outcomes/examples/skill 描述/角色名）才入多语言轨道。理由：内容层 ×5 语言的成本与"安装后运行时行为必须与展示一致"的既有契约冲突。
- 不做图片上传与封面审核（`identity.mark` 只允许 glyph / emoji / 受控图片引用，P3 不做上传面）。
- 不动 `packs.db.category` 的存储语义（写面/安装/订阅零改）。
- 不引入 react-router 到 facet 壳（`PackMarketView` 是双宿主共用组件）。

---

## D1 — 四个正交轴

今天把"谁供给"和"干什么活"挤进 `category` 一个字段，是"tab 老变"的根。拆成四轴，每个轴只有一个真源、一种展示物：

```
轴1 线 LINE ───── 供给方，5 值固定，声明于 lib/pack-taxonomy.js
   base · lex · wire · facet · constellation
   展示：常驻 chip（恒 5 个，带计数，顺序固定，按 locale 出标签）
   写面：作者不可写（由 category slug 归位 or 策展指定），派生只读

轴2 领域 DOMAIN ─ 干什么活，受控词表（slug + 五语标签），可多值
   investing / sentiment / risk / legal / content / support / ecommerce / data-eng …
   展示：第二行 chip 或"更多"下拉；计数；词表顺序
   写面：作者声明（manifest.domain[]）或策展指定；不在词表内的历史值走迁移

轴3 结构 STRUCTURE ─ 是什么，服务端派生，作者不可写（现状 lib/pack-badge.js）
   blueprint / facade / assistant / toolkit
   展示：徽章 + 可选筛选，不进 chip 行

轴4 来源 SOURCE ─ 官方 / 官方精选(已审校) / 社区（现状 lib/pack-provenance.js + roster）
   展示：徽章 + 一个筛选开关，不进 chip 行
```

不变量：**一个轴只出一种展示物**。轴1/轴2 出 chip（可筛选），轴3/轴4 出徽章（其中轴4 允许一个筛选）。

### D1.1 分面集合来自目录，不来自数据

分面端点返回的是**声明的轴目录 + 每个值的在架计数**，不是"这一页数据里出现过的字符串"：

```
GET /api/packs/facets?locale=en
{
  "lines":   [{ "slug":"wire", "label":"Wire · Data & Intelligence", "count":25 }, …],   // 恒 5 条，count 可为 0
  "domains": [{ "slug":"investing", "label":"Investing", "count":11 }, …]                // 词表顺序，count 可为 0
}
```

- 计数为 0 的线**仍出现**（恒 5 条）——"这条线还没上货"是有信息量的。
- 计数为 0 的领域**不出现**（词表可以很长，空值只是噪音）；词表本身的完整清单在策展板可见。
- 恒 5 条使"tab 位置"稳定：用户的空间记忆不再失效。

### D1.2 裸 slug 不进分面

弃用"未映射 slug 原样呈现"。未映射（历史/新建）走两条路：

1. **归位**：`lib/pack-taxonomy.js` 的 `slug → line` 表（现 `lib/pack-category-lines.js` 扩为多语言）；`company`/`facade` 归 `null`（由轴3 徽章承担，不进 chip）。
2. **落"未归类"档**：确实无法归位的（新作者写了词表外 slug）落进一个显式的 `unclassified` 档，策展板高亮待办，**不混进 chip 行冒充成一条线**。

## D2 — 卡片五槽位

```
┌──────────────────────────────────────────────────────────────────────────┐
│ [印]  柏讯 · 策略工坊              [助手] [官方]                    v4   │ 1 身份
│ 把权重怎么定、回测怎么读讲清楚——不代下单。                              │ 2 承诺（promise，≤60 宽）
│ 4 项技能 · 1 位岗位 · 3 个工具面                                         │ 3 可得信号（派生）
│ 适合 量化研究 / 策略复盘                                                 │ 4 适用人群（audience）
│ 限模拟盘 · 无真实资金                                                    │ 5 边界（notes 首句 / 缺省省去）
└──────────────────────────────────────────────────────────────────────────┘
```

- **槽2 承诺**的取数链：`promise` → `description` 首句（到第一个 `。`/`.`/`；` 为止）→ `name`。**永不出现"半句被硬切"**：首句超过 60 显示宽时按整词截断并补 `…`，绝不 `line-clamp` 切半行。
- **槽3 可得信号**全部是已有数据：`skills.length` / `agents.length` / `mcpServers.length`。未知（老服务端未投影）= 省略该段，不显示 0。
- **槽5 边界**取 `notes` 的首句；无 `notes` 时省略整行（宁缺勿造）。
- 卡片整体是**单一可点区域**（`role="button"` + Enter），内部不再嵌套第二个点击目标（今天官方画廊里的 fork 链接是嵌套可点，属于键盘可达性缺陷，本次一并修）。

## D3 — 详情七段式

```
① 首屏    印 + 名 + 徽章(结构/来源) + 版本 + 一句话承诺 + 主 CTA
② 你会得到 outcomes[]（2-5 条）  ── 无 outcomes 时降级为"3 个上手要点"（从 guide 提取）
③ 三步上手 guide.steps（现状已有，上移到 ② 之后）
④ 示例指令 examples[]（可点 → 带着 prompt 进对话/复制）
⑤ 角色 / 技能 / 工具（现有 AgentSpecSheet 三桶，保持不变）
⑥ 边界与诚实声明（notes 全文 + 覆盖度标记 + 允许的边界）
⑦ 版本时间线（现有 PackVersionList）+ 常驻安装 CTA
```

"边界与诚实声明"是新的一段：今天这套产品最有辨识度的东西（"不预测价格""paper-only""如实失败"）全埋在技能正文里半小时才能看到；给它一个固定位置。

## D4 — 多语言：读面重取是唯一入口

```
LocaleSwitcher ──changeLanguage──┬─> i18n 语言变更事件
                                 └─> market 数据层订阅该事件 ──> 用新 locale 重取列表
                                     detail 弹窗同样订阅 ──> 重取当前 packId
```

- **服务端仍是唯一 locale 解析点**（`resolveLocale`：显式参数 > Accept-Language > zh）。客户端只把 UI locale 作为参数传下去。
- 重取用**静默刷新**（保留旧列表渲染，不清空成骨架），避免切语言时闪一下白。
- 请求失败保持旧数据 + 一条非阻断提示（"内容仍是旧语言"），不吞错。
- `line` / `domain` / `tags` 的标签由服务端按 locale 投影；客户端**不做**标签的二次映射。

### D4.1 搜索跨轨道

`search` 现在只打 `v.name LIKE`（zh 列）。改为：

```
WHERE ( v.name LIKE ? OR v.description LIKE ?                      -- zh 主轨
     OR json_extract(v.manifest,'$.i18n.<locale>.name')        LIKE ?
     OR json_extract(v.manifest,'$.i18n.<locale>.description') LIKE ? )
```

- locale=zh 时退化为今天的单轨道查询（逐字节等价的语义、同样的索引行为）。
- 词表标签（线/领域）的搜索走 `domain`/`line` 参数，不走 free-text。

## D5 — manifest 显示格式 v2

全部字段可选；不写 = 今天的渲染。校验都在 `lib/pack-manifest.js`，与发布面/安装面共用同一校验器（既有纪律）。

| 字段 | 形状 | 上限 | 缺省降级 |
|---|---|---|---|
| `identity.mark` | `{kind:"glyph"\|"emoji"\|"image", value:string}` | glyph/emoji 1-2 字符；image 为受控引用（P3 前只接受 `facet:` 前缀内置集） | 服务端按"线 + 结构"生成印章 |
| `identity.accent` | 线 slug（`base/lex/wire/facet/constellation`） | 必须命中词表 | 取该包归位的线色 |
| `promise` | string | ≤60 显示宽（CJK 计 2） | description 首句 |
| `audience[]` | string[]（受控词表 slug） | 1-3 项 | 省略（卡片无此槽） |
| `outcomes[]` | `{title, detail?}[]` | 2-5 项；title ≤40 宽，detail ≤160 宽 | 从 guide.steps 的 title 提取 3 条 |
| `examples[]` | `{title, prompt}[]` | 2-4 项；title ≤40 宽，prompt ≤400 宽 | 省略 |
| `domain[]` | string[]（受控词表 slug） | 1-3 项 | 由 `category` 归位推导 |

**兼容不变量（本次的硬约束）**：一份不含任何 v2 字段的 manifest，其市场投影、详情投影、安装面 manifest 与今天**逐字节相同**（除新增的派生只读字段）。

**`i18n` 覆盖同步**：`LOCALE_OVERLAY_KEYS` 增 `promise` / `audience` / `outcomes` / `examples` / `domain` / `tags` / `identity.mark.value`。`identity.accent` 与 `identity.mark.kind` 是结构字段，**永不进叠加块**（它们是语义，不是文案）。

## D6 — 视觉身份：默认生成，作者可覆盖

不做图片上传（要存储、审核、尺寸规范、版权四件事，与本轮节奏不匹配）。默认生成：

```
[印]  = SiteMark 印章语言（沿用 facet 既有资产，零新图形）
  字    = 线色对应的单字（壹/律/柏/谦/万），由 identity.accent 或归位线决定
  底    = 该线的主色（受控令牌，非自由色值）
  叠加  = 结构徽章角标（蓝图/分身/助手/工具），避免"同线同字"难区分
```

`identity.mark` 存在时用作者提供的 glyph/emoji 覆盖中心字，底座与角标不变。这样 70 张卡立刻有"一眼分辨"的指纹，且**零审核面**。

## D7 — 覆盖度：可见 + 官方硬门

两个不同的东西，不要混：

1. **社区条目**：不设门。详情页 ⑥ 段显示诚实标记——"本条目 en 覆盖 5/9 组织面（缺 outcomes、2 条技能描述）"，并把缺项列出来。**不阻挡任何动作**。
2. **官方条目**：硬门。`official-locale-coverage` 从"在仓 4 个 json"扩到"在架官方条目"——一个审计脚本按生产 API 拉全量官方条目，逐条算覆盖，缺项即红。今天 23/75 漏中文，官方 71 条其中相当部分覆盖不全，这道门会立刻抓到。

覆盖率的分母是**组织面**（name / description / promise / outcomes / examples / 每条 skill 描述 / 每个 agent 名 / 每个 bot 名 / guide 整组），不是字符数。

## D8 — 作者端翻译工作台

`PackDraftsView` 增加一个"翻译"抽屉：

```
┌ 翻译：English ────────────────────────────────────────────────┐
│ 覆盖 6 / 11 组织面                                    [查看缺项] │
│ ┌ zh 主轨 ────────────────┐ ┌ en 副轨 ──────────────────────┐ │
│ │ 名称：柏讯 · 策略工坊    │ │ [Wire · Strategy Lab        ] │ │
│ │ 承诺：（无）             │ │ [                          ] │ │
│ │ 技能 1 描述：…           │ │ [                          ] │ │
│ └─────────────────────────┘ └──────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- 保存走既有 `entries.i18n` 通道（通道已在，只接了 `mcpServers`）。
- 领域与适用人群是**选择器**（受控词表），不是自由输入——这是"tab 老变"在作者侧的根本堵口。
- 发布前若官方作者身份且覆盖率 < 100%，给出阻断性提示（与服务端硬门一致）。

## D9 — 投影与外部客户端

`facet/marketplace-repo.js` 的 `marketplace.json` / `plugin.json` 是 CodeBuddy 客户端的硬格式（`name`/`description`/`version` 必须一致，客户端会 reject 不一致者），所以：

- **不改** marketplace.json 的结构；
- v2 字段写进插件目录的 `facet.json` sidecar（纯透传，客户端不读也不受伤）；
- README 渲染仍用 `name + description`，但**优先用 promise 作首行**（人读面改善，零兼容风险）。

## D10 — 迁移

1. **category 零迁移**：存储不动。新增 `lib/pack-taxonomy.js` 承载 `slug → line` 与领域词表（多语言标签），`lib/pack-category-lines.js` 成为薄兼容层（保留导出，内部转调新表）以免既有调用点同时改。
2. **领域的存储真值 = 新增 `packs.domains` 列**（JSON 数组，nullable）：发布时由 manifest `domain[]` 写入，策展端点可改写；读面不再在运行时从 `category` 推导。**回填**：对 75 条在架包按 `category` 归位结果一次性写入该列，写入前 dry-run 打印将变更的清单，人工过一遍。`category` 列本身零迁移。
3. **23 条 zh 泄漏**：逐条补 en（技能 61 条、agent 8 个、guide 62 条在总量中按包计）。
4. **标签归一**：`柏讯`/`wire` 这类同义双写合并为受控 slug；自由标签保留但要求单语。

## D11 — 已拍的四个决定（记录理由，防止后期反复）

| # | 决定 | 被否方案 | 理由 |
|---|---|---|---|
| 1 | **两行分轴**：线常驻 5 chip + 领域第二行 | 单行混排 / 完全去类目 | 单行混排是现状病根；完全去类目让 75 条内容失去可浏览骨架，只剩搜索 |
| 2 | **服务端生成印章**，作者可覆盖 | 作者上传图标/封面 | 上传引入存储/审核/尺寸/版权四件事；生成式立刻让 70 张卡有指纹且零审核 |
| 3 | **停在显示面**，不翻技能正文/persona | 内容层也翻 | 内容层 ×5 语言 ×202 技能，成本爆炸，且与"安装后行为与展示一致"打架 |
| 4 | **官方做硬门**，社区只做可见覆盖度 | 全部硬门 / 全部不设门 | 官方是门面（`official-locale-coverage` 既有立场）；社区硬门会把生态挡在门外 |

## D12 — 分期与门

```
P0 修断点      ──> 门：切语言后列表/详情/搜索/chip 全部随语言变；e2e 钉住
P1 分类骨架    ──> 门：/api/packs/facets 恒 5 线、词表顺序、计数；裸 slug 零出现
P2 卡片与详情  ──> 门：五槽位/七段式 e2e；DESIGN.md 六条 lint 规则不回退
P3 格式 v2     ──> 门：老 manifest 投影逐字节不变；v2 校验矩阵；作者端翻译抽屉
P4 内容与门    ──> 门：官方在架覆盖审计 100%；23 条 zh 泄漏清零；覆盖度看板
```

**P0 与 P2 可并行**（互不阻塞，收益最大）；P1 独立；P3 依赖 P1 的词表；P4 跟随 P3。每期独立出片，不要求一次滚完。

## Risks

| 风险 | 缓解 |
|---|---|
| 重取数据在弱网下闪烁 | 静默刷新（保留旧列表）+ 失败保留旧数据 + 非阻断提示 |
| 词表早期过于粗糙，逼作者往错桶里塞 | `unclassified` 显式档 + 策展板待办高亮；词表可部署侧 env 覆盖（沿用 `PACK_CATEGORY_LINES` 的先例） |
| v2 字段引发"作者写不出好 promise" | 缺省降级链（description 首句）保证不写也好看；编辑器给示例占位 |
| 恒 5 chip 在早期显得空 | 计数为 0 的线仍显示但灰化，点击给"该线暂无上架内容"的引导 |
| 官方发布门卡住发布流程 | 门只对**名册官方作者**生效且逐项指名缺项（翻译工作台一屏可补）；P4 先把在架 71 条补满、门再开启，在途发布不被突然卡住；社区作者永不受此门 |
| 双宿主组件被改坏 facet 壳 | P2 起 e2e 必须在 facet 壳（无 Router）上下文跑一遍 `#/packs` |
