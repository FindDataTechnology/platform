## Why

产品线门面（`/boards/:line`）今天是**一条腿站着**的，而且断在最重要的一层——呈现层：

- 识律（lex）的适配器、spec 三条 Requirement、线上走查全 PASS（`add-lex-line-board` 7/7），但前端 `web/src/pages/BoardsPage.tsx:74` 的页签表只声明了 `facet / wanxing / wire`。结果 `/boards/lex` 的四块（概览 / 我的凭据 / 套件 / 账单）**竖着全堆在一屏**、没有页签（`:268` 的 `if (!currentTab) return true` 兜底救场）。同一件事，别家三条线是分页的，识律是一整面墙。
- 萬星（wanxing）的三块**全部**是 `under_construction`（`lib/board-adapters.js:283,290,297`），但页面照旧渲染三个页签，每个页签里一行「建设中」。用户要点三次，读三遍同一句话。
- 五条产品线里有四条接了看板，**壹座（base）没有**，而现状既不说明也不解释——看板上方的线清单只是少了一条，没人知道是"没做"还是"不该做"。

这三处都不是新能力，是把已有能力**摆平**：一条线该有页签就有页签，一条线什么都没有就一次说清，宿主线明确不做。

## What Changes

- **识律补页签**：`BoardsPage` 的页签表加 `lex: [overview, credentials, suites, billing]`，与适配器声明的四个 `tab` 值逐字对齐。
- **全建设中收成一次**：当一条线的**所有块**都是 `under_construction`（萬星现状），页面渲染一个整线状态卡（线标题 + 建设中说明 + 原站深链），不再渲染页签条与逐块重复行。
- **base 显式不做**：line-boards 能力明文记录「看板是宿主对**外部**产品线的原生视图；壹座是宿主自身，不设看板」，并把未知/未接入 line 的降级文案与「本线由宿主自身承载」区分开。
- **页签表与适配器声明对齐成为契约**：新增一致性断言——前端页签表里出现的 line，其页签集合必须等于该线适配器块声明的 `tab` 去重集合（双向），少一个/多一个都红。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `line-boards`: 增加「页签集合由适配器声明派生且前端不得落后」与「整线未接入上游时一次说清」两条需求；在「每条已接入产品线有一块线看板」里明确 base 为宿主自身、不设看板。

## Impact

- `web/src/pages/BoardsPage.tsx`（页签表、整线建设中分支、降级文案分流）
- `lib/board-adapters.js`（导出每条线的页签声明，供前端与契约断言共用；适配器块形状不变）
- `web/src/locales/*/common.json`（整线建设中/宿主自身两句，五语齐）
- `e2e/line-boards-ux.spec.js`（新增 lex 页签与 wanxing 整线状态断言）
- `openspec/specs/line-boards/spec.md`（经本 change 归档更新）
- **不动**：各线适配器的取数逻辑与凭据链、动作闸、看板块渲染形状、`/boards/:line` 路由
