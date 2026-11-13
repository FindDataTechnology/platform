# Design: add-fleet-architect-edges

> NL 面对第一波代数的表达力补齐;校验零新规则(复用 `validateOrchestration`/`expandedEdges`)。

## D1 · 虚拟终态上图校验

`validateFleetDraft` 在成员校验后:若 `draft.fleet.orchestration` 存在,取 `virtualApply(existing, members)` 终态(含 add 的草稿岗——虚拟岗 id 用稳定记号 `@draft-<title>` 已有),将其映射为 `{id, ...}` 传入 `validateOrchestration`。**add 岗在终态里 id 尚未铸出**,边的 from/to 引用怎么办:虚拟应用时给 add 岗分配确定性 id `draft-<n>`(按 members 数组序),校验通过后 **apply 阸转换**——orchestration 落库前把边里的 `draft-<n>` 替换为实铸 memberId。这是本 change 唯一的桥接逻辑,集中在 apply 一处。

## D2 · diff 呈现

orchestration 段作为 diff 的独立区块逐行:mode 行(含 supervisor 隐式许可提示)、constraints 行、每条边一行(`[handoff] 抓取→撰稿` / `[dispatch] 主管→执行(许可)`);工具岗 hop 的 args 摘要首 60 字。错误/警告按既有分流进 diff 顶部。

## D3 · apply 双模式透传

- create:`createFleet({..., orchestration: 换真 id 后的段})`——orchestration 列既有透传,零存储改动;
- edit:成员操作完成后 `updateFleet(fleetId, { orchestration: 换真 id 后的段 })`(draft 带段才写,未带不动——**不隐式清边**;清边=显式空 edges 或删岗,由成员删除的连带清边既有逻辑兜住);
- 重校验:既有 `applyFleetDraft` 开头的 `validateFleetDraft` 自然覆盖(漂移含边引用岗消失→未知引用错误,如实指名)。

## D4 · 种子 v1.1 续版

persona 提示补边词汇段:主管式(supervisor——全舰可互相派活,主管岗配 brief 派发)/流水线(handoff 链,上游完成自动接棒,工具岗边带 args)/派发许可(单边授权);纪律补两条:删带边岗位连带清边须单独确认;mode 与显式边可并用(隐式许可只提示不落库)。`packId NoBBXkvxZnJNHlCrAwWp-w` 续 v1.1(§15.15 续版配方:POST 带 packId 即追加版本)。

## D5 · 测试

`test-fleet-architect.mjs` 补:create 带边全链(draft 过→apply→orchestration 落库、draft-N→真 id 换准)、同草稿建岗+引用、环拒、edit 加边与边漂移拒、未带段不动既有段、supervisor diff 提示。十三套回归零新增红。

## D6 · 不做

不编第二波边(event/fanout/rounds);不做结构化批准工具;不改驾驶舱(orchestration 视图 cockpit 已有);不做边级 UI 编辑器(对话面)。
