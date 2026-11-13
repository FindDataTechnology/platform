# add-agent-teams-first-class

## Why

平台的定位是「AI Agents Teams 执行平台」，但今天用户看到的是**一个团队一次只能进一个**：
`/fleets` 左侧一列团队卡片 + 右侧单团队驾驶舱，跨团队的聚合读面（`/api/fleets/overview`、
`/api/fleets/owner/board`）虽有数据却只以「未选中时的经营坞」形态塞在右侧窄栏；团队**改不了名
以外的任何东西**（`PATCH /api/fleets/:id` 只吃 name/state/defaultModel/effort/contextBudget，
成员只能进团队逐个改），批量启停不存在。也就是：**「团队」是数据上的一等公民，却是交互上的二等公民。**

同时这次路线把常驻组织的中文用户可见名从「集群」改为「**智能体团队**」（用户 2026-10-29 明令）——
只改显示层，`fleet` 代码键/API/事件/spec 目录名一律不动（native-lexicon 的既有纪律）。

## What Changes

- **词表 v4 改四个词**（用户 2026-10-30 裁定，覆盖 10-28 的三词）：常驻组织「智能体团队 / Agent Team」、
  临时编组「小组 / Group」、安装单位「智能体 / Agent」、商店「智能体市场 / Agent Market」，
  品牌串「壹座·Packs → 壹座·智能体基础设施」。全部只动显示层，i18n 五语言同批，键零动。
- **团队面三分**：同一条导航项（slug 仍为 `fleets`）下三面——
  **综合看板**（跨团队：在跑什么、谁失联/待补岗、等你 N 件拍板、近 24h 花销、健康）、
  **团队管理**（团队清单 + 行内快速编辑 + 批量动作）、**驾驶舱**（既有单团队深钻面，不动）。
- **行内快速编辑**：团队列表行可直接改名、换默认模型、启停、进驾驶舱；成员级编辑仍走驾驶舱检查器
  （不搬，避免两处状态机）。
- **批量动作**：按勾选对多支团队做 暂停 / 恢复 / 归档，逐团队如实回执（部分失败逐条呈现，不假绿）。
- **不改**：驾驶舱的面板与写路径、团队/成员的数据模型、`/api/fleets*` 既有路由的契约语义
  （只**新增**批量端点与一个聚合读端点字段）。

## Capabilities

### New Capabilities

- `agent-teams-overview`: 跨团队综合看板——聚合读面（在跑/失联/待补岗/待拍板/花销/健康）与呈现规则。
- `agent-teams-management`: 团队清单管理面——行内快速编辑、批量动作、部分失败的如实回执。

### Modified Capabilities

- `native-lexicon`: 常驻组织的中文/英文用户可见名由「集群/Cluster」改为「智能体团队/Agent Team」；
  技能包（zip 产物）与 dsh 插件包是不同单位，不随本次改名；`fleet` 代码键永不翻译的纪律继续有效。
- `agent-fleet-core`: 新增「团队可批量变更状态（暂停/恢复/归档）」与「团队列表行可改名/换默认模型」的
  写面要求；单团队 PATCH 语义不变。
- `agent-fleet-cockpit`: 明确驾驶舱**保持**为单团队深钻面，不与综合看板合并；驾驶舱入口从团队管理行直达。

## Impact

- **web**：`web/src/pages/FleetsPage.tsx`（三分面切换 + 管理行内编辑 + 批量选择）；
  新组件 `web/src/components/fleet/TeamsOverviewBoard.tsx`、`TeamRowEditor.tsx`；
  `packages/core/src/lib/surfaces.ts` 无需新增导航项（slug 不变），
  但若用 query 参数分面须在此登记子面语义；
  i18n 五语言 `web/src/locales/*/common.json`（`nav.fleets`、`trace.fleetBadge`、`fleets.*`、
  `packs.wizard.*`、`onboarding.tour.stepFleet.*`、`board.tab.fleet-summary`、`fleet.*` 共 22 处 zh）。
- **server**：`server/routes/fleets.js` 新增 `POST /api/fleets/batch`（pause/resume/archive，逐条回执）；
  `GET /api/fleets` 行内补 `defaultModel`/`effort`/`spend` 摘要字段（只增不改）。
- **测试**：新增 `scripts/test-fleet-batch.mjs`（批量部分失败矩阵）、
  `scripts/test-fleet-list-fields.mjs`（列表字段契约）；既有 `test-fleet-core.mjs` 等四套零扰动。
- **i18n 门**：`npm run check:locales` 必须绿（五语言键 parity，值全改）。
- **不影响**：驾驶舱写路径、团队/成员存储、`fleet`/`pack`/`cluster` 键名、智语 / 记忆任何面。
