# Design: add-agent-teams-first-class

## Context

三块现状决定了这个变更的形状：

1. **读面已有，只是位置错**。`GET /api/fleets`（列表，带 memberCount/statusCounts/openDecisions）、
   `GET /api/fleets/overview`（跨团队：counts 六态 + 最近报数流 + 拍板 top3）、
   `GET /api/fleets/owner/board`（跨团队：告警计数 + decisionPolicy + lastActivityAt + spend 投影）
   三者都已在产、都被测试钉住。缺的是把它们**摆成一个屏**，而不是塞进 `FleetsPage` 右侧的
   `OwnerBoardStrip` 窄栏（只有「未选中团队」时才出现）。
2. **写面窄**。`PATCH /api/fleets/:id` 吃 name/state/defaultModel/effort/contextBudget/orchestration；
   `PATCH /api/fleets/:id/members/:mid` 吃成员级全部字段。**没有批量端点**，
   前端批量只能 N 次串行 PATCH，失败一半时 UI 无法如实呈现。
3. **词表连改四词**。`native-lexicon`（2026-10-28 归档）把 集群/阵列/能力包/能力市场 钉死；用户
   2026-10-29 明令集群→「智能体团队」，2026-10-30 又裁定 阵列→「小组」、能力包→「智能体」、
   能力市场→「智能体市场」、品牌「壹座·Packs→壹座·智能体基础设施」。改动面 = 五语言显示值
   （团队 ~21 处 + 小组/智能体/市场 ~360 处），**键一个不动**。技能包（zip）与 dsh 插件包按语义豁免。

## Goals / Non-Goals

**Goals**

- 用户打开 `/fleets` 第一眼看到「我所有的团队现在怎么样」——不是「请选一个团队」。
- 团队列表行能直接改掉 80% 的日常操作（改名、换默认模型、启停），不用点进去。
- 批量启停/归档，且**逐条如实回执**（成功几条、失败几条、为什么）。
- 词表在五个语言里一致、且 `check:locales` 绿。

**Non-Goals**

- **不合并驾驶舱**。驾驶舱回答「这一支团队怎么运转」（画布/编队/在途/检查器），
  综合看板回答「我所有团队怎么样」。合并会让两块都变差。
- **不在综合看板放写动作**。它是纯读面（与 `agent-fleet-cockpit` 同一纪律）。写动作只在管理面与驾驶舱。
- **不做团队级成员批量编辑**（跨团队批量改岗位节奏之类）——那是运维脚本的活，不是日常产品面。
- **不改 `/api/fleets` 既有字段语义**，只增。
- **不改任何 `fleet` 代码键 / API 路径 / 事件名 / spec 目录名**。

## Decisions

### D1 · 三面共存于同一导航项，用 query 参数分面

`/fleets`（综合看板，默认）、`/fleets?view=manage`（管理）、`/fleets/:fleetId`（驾驶舱，既有深链不变）。
理由：`slug` 是公开 API（`surfaces.ts` 的 R1 承诺），新增导航项会动 factory preset 与用户既有布局；
query 分面零布局影响，且深链兼容（老书签照旧进驾驶舱）。

替代方案（否决）：新增「团队总览」导航项 —— 会让「团队」在导航里出现两次，违背一等公民心智。

### D2 · 综合看板复用三个既有读端点，不新造聚合端点

`TeamsOverviewBoard` 并发拉 `/api/fleets` + `/api/fleets/overview` + `/api/fleets/owner/board`，
各自独立降级（一路失败只让那一路显灰，不把整屏判死——沿用 `OwnerBoardStrip` 的既有姿态）。
理由：三个端点都已被测试钉住且各有语义侧重；再造一个 `/api/fleets/dashboard` 会造成
第四份「团队状态」计算，与「契约同源重算、不另造状态机」的既有纪律冲突。

替代方案（否决）：新聚合端点 —— 省一次往返，但引入第二个真源。

### D3 · 批量端点服务端逐条执行、逐条回执

`POST /api/fleets/batch { action: "pause"|"resume"|"archive", ids: [...] }` →
`{ results: [{ id, ok, error? }], summary: { ok, failed } }`。服务端逐团队串行执行既有单团队语义
（复用 `updateFleet` + `runReconcile`），**任何一条失败不中断其余**，且 HTTP 状态恒 200
（部分失败是业务结果，不是请求错误）。理由：前端串行 N 次 PATCH 无法区分「网络断在第 3 个」
与「第 3 个状态非法」；服务端批量能给出确定的逐条结论。

`ids` 上限（默认 50）与「只允许自己的团队」校验沿用既有 `requireOwnedFleet` 语义。

### D4 · 行内编辑只开放三个字段

改名（`name`）、默认模型（`defaultModel`）、状态（`state`）——这三个是日常高频且无副作用的。
`orchestration` 与 `effort/contextBudget` 不上行内（前者需要 diff 确认，后者一次改全体成员影响面大）。
理由：行内编辑的价值是「快」，一旦需要确认框就不再快；有确认需求的走驾驶舱。

### D5 · 词表改动只碰值，不碰键；每词按语义分类，不做盲目替换

按 `native-lexicon` v4 执行：键全部不动，值按 2026-10-30 裁定改写四词。机械替换之外必须手工裁定的
三类：①桌面机群/部署语义（`fleet.*`、`onboarding.tour.stepFleet.*`=desktopOnly 步骤、
`board.tab.fleet-summary`=万星部署看板）保留机群词，不叫「智能体团队」；②技能包 zip 产物与
dsh 插件包不随「能力包→智能体」改名；③双词同句（"agents and packs"类）手工重写避免
「agents and Agents」式病句。

### D6 · 驾驶舱入口保留且直达

团队管理行的「进驾驶舱」→ `/fleets/:fleetId`（既有深链）。综合看板的团队卡片点击也进驾驶舱。
即：**任何看到某支团队的地方，一点就进它的驾驶舱**。

## Risks

- **词表机械替换风险**：`fleet` 一词在中文里有三个不同所指——团队（agent team）、机群（desktop runner
  fleet，`nav.fleet` 桌面专属）、部署集合（`local_fleet_deployments`）。T1 必须先逐条分类再改，
  否则会把桌面机群也叫成「智能体团队」。
- **批量归档不可逆**：`archived` 是终态（`PATCH` 已拒绝从 archived 出来）。
  批量归档必须二次确认，且回执里逐条列出归档了哪些。
- **i18n 门连锁**：五语言键 parity 由 `scripts/check-locales.js` 强制；值改动不影响 parity，
  但同批新增的 `agent-teams-*` 键必须在五语言同批出现，否则门红。

## Migration

无数据迁移。纯显示层 + 两个新端点（一个批量、列表字段只增）。


## Implementation Notes (apply 2026-10-30)

- **D1 修正为「hub 三面 + 驾驶舱」**：实施时发现综合看板成为默认视图会把经营坞
  （OwnerBoardStrip 的花销/订阅/市场行/迭代提议）埋掉——hub 视图切换扩为三面
  （综合看板 | 管理 | 经营坞），OwnerBoardStrip 原样挂在 `?view=owner`。spec 的
  「三路读面独立降级」语义不变；owner 面是既有能力，不另立 spec。
- **auto-follow 移除**：`/fleets` 冷载自动选中首队的旧行为删除——它会把综合看板推回
  「一次一支团队」的旧世界。remembered selection（localStorage `fleets.lastSelectedId`）
  仍写入但不再驱动初始选中；深链 `/fleets/:id` 仍直达驾驶舱。
- **既有 e2e 随契约更新**：`fleets.spec` 四处 `goto("/fleets")` 后断言驾驶舱内容的用例
  改为深链 `/fleets/:id`——这是本 change 契约变更的既有面随行，不是测试放宽。
- **坑**：i18next 插值是双花括号 `{{count}}`，新键首版写成单括号被 e2e 逮住（汇总条
  渲染原始 `{count}`）——已修五语言。playwright webServer 可能复用陈旧 dist，
  e2e 前显式 `npm run web:build`。
