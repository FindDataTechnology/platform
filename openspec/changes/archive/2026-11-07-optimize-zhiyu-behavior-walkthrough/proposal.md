# optimize-zhiyu-behavior-walkthrough

## Why

智语在 2026-11-06 两轮模块体检（`optimize-yizuo-module-audit` 簇 C / `optimize-paas-module-audit` G10·Hb）中判为 A / A / A-，P1-10 与 P1-11 已由 `align-yizuo-specs-to-reality`（`90acfaf10`）清账，spec 面对账已无增量。剩下的实证缺口集中在 `add-zhiyu-team-memory`（roadmap 线 5a「优化智语与团队/记忆的连通」）自 2026-10-30 归档起留的 5.2 真机走查，但要分两半看：

- **记忆两腿已验、口径已变**：11-05 归档的 `add-member-knowledge-profile` 8.2 真机冒烟（真 fd-memory + 真 paas 缝 HTTP，9/9）覆盖了「物化三成员团队 → 铸令牌 → 回合 capture 分流 → fleetContext 合流注入」。同一 change 把团队记忆从 `u/<owner>/f/<fleetId>` 迁到 own/shared 双分区（`server/fleet-memory.js:10` 明写 legacy `f/` STOPS receiving writes），因此本单对这两腿只做**按新口径的回归**，不是首验。
- **空间桥四腿仍无真机证据**：清史重开后记忆段仍在、`POST /api/zhiyu/rooms/:id/fleet-subscriptions`、报数事件行流入、`POST /api/zhiyu/rooms/:id/fleet-summon` 一键召唤；以及 guest/widget 链、私窗隔离、熔断与计费归属、IM 桥回写四个仅被脚本半覆盖的行为面。房间内核有 13 个 script 套件 + 2 个 e2e（`scripts/test-zhiyu-e2e-chain.mjs` 起真实模块栈），但跨服务链路（fd-memory、网关拉取真实 cell、serving 部署邀请握手）脚本替不掉。智语本域近 60 天 8 个 `fix`/`harden` 提交里，「浏览器眼 / 真机首答」反复抓出脚本套件漏掉的缺陷，是这单方法的直接依据。

按模块优化战役在壹座线收口后，这是「这一版做到能做到的最好」最后一处未验的跨边界链。代码前提已具备：生产镜像 `sha-d5784e8e5-paas` 源提交 `d5784e8e5` 在 HEAD 祖先链，且 `d5784e8e5..HEAD` 对智语链 9 个文件零改动。

## What Changes

- 落一条可复现的真机走查证据链：5.2 七步中记忆两腿按 11-05 新 scope 口径**回归**，空间桥四腿（清史重开 → 空间订阅 → 报数事件行 → 一键召唤）**首验**；每步带判据与代码锚点，证据汇总于本 change 的 `evidence.md`。
- 走查带一次 **browser-eye / 无痕窗口**观察，并顺带复验官网 `site-zhiyu` liveRoom 的滚版回归（无痕窗口一问一答、无登录墙），作为 3.1 的一个 case，**不另立 change**。
- 同一趟真机核对四个仅被脚本半覆盖的跨边界行为面：guest/widget 链、私窗隔离、应答上限/日预算与计费归属、IM 桥回写。结果如实落档，通过或缺陷都记。
- 补记 `docs/registry-maintenance.md` 的 §15 台账条目（承接 `add-zhiyu-team-memory` 5.3）。
- 回写 `add-zhiyu-team-memory` 归档件 tasks.md 的 5.2 / 5.3 勾选状态（只改状态，不重开归档）。
- **不修代码**：走查若发现缺陷，另立 change 处理，本单只出证据与判定。
- `openspec/specs/app-navigation/spec.md:4` 的 Purpose「including the Bots entry」残留本单**只登记不修**——项目规则（`AGENTS.md`）禁止直接改 `openspec/specs/`，且本单无 spec delta 通道，理由见 design.md。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——`skip_specs: true`。本单为验证/文档类，无 spec 级行为变更；不为满足校验而虚构需求。）

## Impact

- 只新增/改动本 change 目录下的工件（含 `evidence.md`）、`docs/registry-maintenance.md` 一条台账、以及 `add-zhiyu-team-memory` 归档件 tasks.md 的两个勾选框。
- 运行时系统以**只读观察为主，辅以授权范围内的受限写**：`gateway/zhiyu/index.js`、`gateway/fleet-room-bridge.js`、`server/fleet-memory.js`、`server/fleet-context.js`、`server/routes/zhiyu-im-bridge.js`、fd-memory 服务、走查所在 cell。
- 不新增依赖、不改 API、不改数据库 schema、不动 `openspec/specs/`、不改 `gateway/` / `web/` 源码。
- 对外影响：**受控**。经用户 2026-11-06 明确授权（自有账号 `aloadtree@gmail.com`），在自有租户下新建**专用走查房间**并做订阅/召唤/至多三回合等受限写；不触碰公开演示房间 `zy_42ce690574b5423bd2`、不改任何产品配置、不动他人数据。凭据只用于本次登录会话，不写进任何文件、不回显、不入 artifact。
