# Proposal: unify-operate-states

## Why

地基批给了供给、门面批重做了六面，本单治**全站通病**：2026-11-02 源码审计定罪——状态覆盖残缺（FleetCanvas 零 loading/空/错三态；BotsPage 空态文案在加载期说谎；AgentsPage 载入前整片空白；抽屉 `Suspense fallback={null}` 加载期完全隐形；全仓骨架屏仅 4-5 个文件有）、危险操作裸奔（智语房间踢人/移除**无确认**、Pack 草稿条目删除**无确认无回收**，另有 9 处 `window.confirm` + 1 处裸 `confirm()` 是浏览器原生弹窗、不可主题化不可五语）、反馈通道三套并存（Fleets 内联、Tasks store 内联、Agents 内联块，Toast 单槽 1.6s 无严重度且仅 3 页在用——用户分不清「成了/没成/还在等」）、a11y 塌陷（25 页仅 10 页有任何 aria；键盘加速器全仓只有 Ctrl+O/,/B 三条）、动效真空（路由与面板切换零过渡，`animate-in/out` 全仓 2 处）。这些是 Operate 模式产品的底线性缺陷：每支 feature-change 都在赶功能门，没人补状态的门。

用户已裁决（2026-11-02）：方案形态 = C 混合三批，本单为批③，排在 ①② 之后。

## What Changes

- **三态全覆盖**：其余 ~19 个数据面页与全部懒载抽屉接入批① `StatesKit`——骨架屏须与消费组件同形（治「fallback={null} 隐形加载」）、空态必给下一步（治 Knowledge「暂无数据」式耸肩）、错误态带重试；`window.confirm`/裸 `confirm()` 共 10 处全部换 `ConfirmDialog`（危险操作走 danger 变体、焦点落取消）；**补齐两处缺失确认**（智语房间踢人/移除、Pack 草稿条目删除）。
- **反馈通道单一规则**：异步操作成败一律 toast-v2（severity + 可选 action），页内表单/校验错误走 inline——二通道写进需求，终结三种并存；成功反馈不得缺席（现存多处「静默成功」：保存后无任何回执的页面在走查清单上点名）。
- **a11y 底线**：25/25 页具备 aria 标签与可见焦点环；对话框/抽屉 Esc 与焦点还原由原语统一供给；SettingsDialog 自建的重复 trap 删除、改继承 `ui/dialog.tsx`。
- **克制动效**：抽屉/面板/路由过渡入统一时长档（150-250ms，ease 出），`prefers-reduced-motion` 全降级；灯语义（蓝=正在干活）**不做**装饰动画。
- **键盘加速器最小集**：命令面板/跳转（g 前缀导航或 Cmd-K，二选一由 design 定）替代「只能鼠标过 25 页」的现状；Composer 既有加速不动。
- **lint 终态**：本单收班时 design-lint 棘轮基线中六面之外页面的 `#hex`/`border-l-*`/`window-confirm` 条目应清零，门从「拦增量」升级为对 `pages/**` 的全量阻断（新债无处生）。
- **Non-goals**：不改信息架构、路由、数据层、端点、WS 契约；维持「永不乐观更新」既有纪律（唯一例外 ExternalSourceTab 原样）；Chat 主线程的三态已达标不重做；miniapp/官网不搭车。**非 BREAKING**。

## Capabilities

### New Capabilities

- `web-operate-states`: 跨页通行为契约——任何取数面必须有三态（同形骨架/有出路的空态/带重试的错态）；破坏性操作必须经主题化确认（danger 变体+焦点落取消）；异步成败反馈双通道制（toast-v2 severity 队列 / inline）；25 页 aria 与焦点可达底线；面板过渡时长档与 reduced-motion 降级；design-lint 全量阻断终态。

### Modified Capabilities

（无逐页 delta——各页面的确认替换/三态/反馈义务已由上方 `web-operate-states` 的跨页需求统一承载并全量可测：native-confirm 全量清零在 lint 规则里机器可断言，三态与反馈通道按需求场景逐页走查。涉及面：`zhiyu-room`、`pack-authoring`、`scheduled-tasks-ui`、`document-management-ui`、`fleet-machine-console`、`extension-management-ui`、`settings-surface`、`custom-presets`、`agent-fleet-cockpit` 的实现接线均落在本能力需求之下，不另开 delta。）

## Impact

- **web**：全 `pages/**` 与 `components/fleet|packs|settings|extensions|bots` 的状态接线；`App.tsx` toast 容器与全局键盘层挂点；design-lint 基线清零终态。
- **Server / API / WS**：零改动（确认闸与状态全在展示层；智语踢人、草稿删除沿用既有端点）。
- **桌面**：自动覆盖；键盘加速器在桌面同等生效（parity）。
- **i18n**：确认文案、空态引导句产生五语言增量串，`check:locales` 硬门照跑。
- **排期协调（红线）**：① 批①已合入；② 批②六面收班后开工（`zhiyu-room`/FleetsPage 同文件续段，避免与门面批撞车）；③ 与其余在途 change（如 mcp-annotation-overlay 动 extensions）错峰——本单 diff 大但全为展示层接线，冲突面集中在 pages/，按「台账律+单文件提交」纪律走。
- **验收**：逐页走查清单（25 页 × 三态 × 有无回执 × Esc/焦点）过 Playwright 替班配方九腿法；a11y 用 axe 扫描批①②③页面清零严重项；视觉复评含 Tasks 红绿灯胶囊归词表后的灯纪律抽查；design-lint 全量阻断合入即生效。
