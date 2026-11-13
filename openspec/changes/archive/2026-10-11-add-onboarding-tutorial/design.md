# Design: add-onboarding-tutorial

## Context

R1 已统一语言并收敛结构（五 tab / 三组设置 / 三 tab 智能体页）。R2 全部落在 web 展示层：引导、帮助重组、内容模块、空态文案、站外手册。零后端、零 manifest、零 WS 契约。相关面现状：`ChatWelcome.tsx` 静态四卡（PROMPT_KEYS → locale）；`HelpDialog.tsx` 单页滚动（概念/命令/技能/快捷键），由 Composer 的 `/help` 打开；市场详情在 `PackMarketView.tsx`；R1 后智能体页三 tab，市场详情挂在 `/agents?tab=market` 之下。

## Goals / Non-Goals

**Goals:**

- 新用户前三步有人带；帮助中心能自助；六个首发包有教法；空态教下一步；手册可转发
- 引导/帮助的全部 UI 壳走 i18n 五语言；教程正文作为内容 zh 权威

**Non-Goals:**

- 不做 manifest schema 变更（创作者自带教程 = R4 随包分发）
- 不翻译指南正文（市场人格/技能本就是 zh 内容；en 用户看 UI 壳 + zh 正文，手册 zh-first 同理）
- 不做视频/截图教程（纯图文）；不做小程序端引导（R4 命名同步时一并考虑）

## Decisions

### D1 指南/提示内容放客户端内容模块，不进 locale bundles
`web/src/lib/packGuides.ts`：`Record<packId, { name; steps: [{title, body}×3]; prompts: [{title, text}×4] }>`。理由：packId × 5 语言 × 17 包的翻译税不可持续，且市场人格本就是 zh 单语内容——教程正文与人格同类。UI 壳（卡片标题「使用指南」、步骤字样、tab 名）照常走 i18n。首发六包：法律-合同 `J9sO_wRCgUVjbYVEqD4Pog`、法律-案件 `_r1lL81mBSMTtvjraEwkJA`、数据-股票 `Y5uR57UBAXi7_xruKQBsfg`、数据-中国经济 `hKvTCaWfSIAAJhZSseoE9w`、文档工坊 `qnhd7B3J1-HKDDKzZQ_fUQ`、数据研究·生态版 `Aqag8Mky4ksoPmwRDMCVYw`。备选「进 locale 走五语言」被否：成本爆炸且迟滞；备选「随包 manifest 分发」是 R4 正解但本期不动 schema。

### D2 首跑引导 = 自绘 coach-mark 序列，localStorage 单键
`OnboardingTour.tsx`：读 localStorage `onboarding.tour.done`；未完成且落在 ChatWelcome 时渲染步骤卡（① 锚 AgentPresetPicker，② 锚 Composer 输入区，③ 锚侧栏「成果」入口）。锚定用 data-testid 定位 + getBoundingClientRect 画高亮框，步骤卡绝对定位在锚附近（上下避让），不做整屏遮罩暗化（避免挡操作、避免 z-index 战争——R1 刚给嵌套对话框修过键盘让位）。跳过/完成都写 done 键；Escape 即席关闭。重看 = 帮助中心按钮清键重挂。备选「driver.js 类库」被否：引依赖只为三步卡，且其遮罩层与本项目的对话框栈互相干扰风险高。

### D3 帮助中心三 tab：快速上手 / 场景教程 / 命令与快捷键
`HelpDialog` 内加三个 tab（组件内 state，不进 URL——帮助是叠加层非路由面）。快速上手：三步图文（与引导步骤同文案）+「重看引导」+ 新命名词汇表（资料库=我给智能体的、成果=智能体给我的、专家/行业方案一行释义）。场景教程：遍历 `packGuides` 渲染可展开指南。命令与快捷键：现有四段（概念/命令/技能/快捷键）原样并入。`/help` 命令入口不变。

### D4 提示卡分派：packId 查表 → 聚焦通用集 → 默认集
`ChatWelcome` 从 store 的 agents（catalog 已含 packId/customPreset 标记）解析当前专家：`packGuides[packId]?.prompts` 命中用包四卡；否则 `customPreset || packId` 命中「聚焦通用四卡」（i18n，五语言）；否则现有默认四卡。卡片数量/点击预填行为不变（spec 钉死）。切换专家即时刷新（store 订阅已具备）。

### D5 市场详情指南卡：详情页尾部一块只读卡
`PackMarketView` 详情视图（detailId 打开时）在描述之后渲染指南卡（`packGuides[pack.id]` 命中时）：三步列表 + 一句免责式副标（「装好后回到对话页，在专家里选它」）。无订阅/跳转行为。未命中不渲染——对既有 e2e 零影响。

### D6 手册 = 单文件 Markdown，docs/ 不进镜像
`docs/user-manual.zh-CN.md`：0 准备（登录两式）→ 1 认识界面（五导航图）→ 2 对话（选专家/传文件/看过程）→ 3 资料库 → 4 成果 → 5 智能体（专家/行业方案/应用 + 怎么装包）→ 6 自动化（模板思路 + 定时）→ 7 设置速览（只有常用三节）→ 8 小程序与 App → 9 常见问题（十条）。命名与产品严格一致（对话/资料库/成果/智能体/自动化/行业方案/我的专家）。docs/ 不进 Docker 镜像，零运行时影响。

## Risks / Trade-offs

- [packId 硬编码在客户端内容模块，市场改名/下架后指南悬空] → 指南卡只在详情页按 id 命中渲染，悬空不可见（无破绽）；场景教程列表以模块为准（列出的包必然在模块里），改名后列表名与市场名可能短暂不一致 → 模块内 name 字段随市场更名维护。
- [coach-mark 锚定在窄屏可能出视口] → 步骤卡 clamp 在视口内、小屏（<md）退化为居中卡片（不锚定）；引导只在欢迎页触发，页面结构稳定。
- [教程正文 zh-only 被外语用户吐槽] → UI 壳全翻译保证可操作；正文翻译进 R4 随包分发时的 creators 职责。
- [帮助三 tab 改动动到 Composer 的 /help 用例] → tab 化后保留全部既有 testid（help-dialog / 内容区沿用），新增 tab testid；e2e 优先回归 i18n.spec / composer 相关。

## Migration Plan

单镜像滚动（同 R1 标准线）。无数据迁移；localStorage 新键对老用户天然为空（= 未看过引导，会出现一次引导——可接受，产品刚大改版正好重教一遍）。回滚 = revert 镜像 tag。

## Open Questions

- 六包指南正文的首发文案在实施期对照各包 SKILL.md 真实流程写，不虚构步骤；写不实的包宁缺毋滥降级为三包。
