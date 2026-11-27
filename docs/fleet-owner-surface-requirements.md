# 集群主人经营面（Owner Surface）· paas 侧需求书

> 交付对象：paas 实施者。本文承接 2026-10-27 产品线方向会话的用户裁决——
> 「集群」产品形态挂壹座（base）线、客户要能组建/管理/迭代/分享自己的集群。
> 与 《集群平台供给开放需求书》（`fleet-platform-supply-open-requirements.md`）是姊妹单：
> 那一份开路（供给能来），这一份开门（主人能经营自己的集群）。
> 本单尚无对应 OpenSpec change，paas 会话启动时自行 promote 立项；spec delta 以立项稿为准。

---

## 1. 问题

平台里 all the machinery 都在：Agent Cluster Platform（pack-as-cluster、ClusterComposerModal、集群调度，见 `AGENT_CLUSTER_README.md`）、
舰队模板契约（岗位骨架、trigger/handoff/escalate、KPI 槽位）、L1 共用包、市场分发、
萬星 runtime（驻留/门面/计费，多机运行已是既有事实）。

但这些都是**机器能看**，不是**主人能经营**：
- 集群主人没有一个面，能看见自己（或自己组织）的集群**正在跑什么、报了多少数、哪里要拍板、花了多少钱**；
- 迭代回路（「集群跑得怎样→改蓝图/改配置→发新版→升级跟新」）目前只有内部 harness 在跑，客户面无入口；
- 对外叙事的北极星已经改判（10-27 叙面层 change `reposition-fleet-platform-narrative`，finddata 根）——
  「壹座=集群平台，萬星=上线运行」要变成界面事实，不能只是口径句。

**结论**：缺的不是底层能力，是一层主人视角的「经营坞」。本单明确其最小完整面。

## 2. 范围

| 编号 | 交付物 | 优先级 | 说明 |
|---|---|---|---|
| A | **集群总览坞**：我组织的集群清单+状态（在跑/暂停/异常）、异常与告警入口、跨机运行占位显示 | P0 | 基于既有 clusters routes + packs 台账；不做新的运行时能力，只做主人视角的投影 |
| B | **经营读数**：每集群的 KPI 槽位报数、日报/周报订阅入口、escalate（拍板）排队与处理动作 | P0 | 复用 L1 `fleet-brief-report` 的槽位键契约；拍板动作走既有动作闸语义 |
| C | **花销视图**：每集群调用量与结算视图（调用量计费既有），市场订阅/分成行按供给开放单落地后并列 | P0（调用量）P1（市场行） | 读 sub2api/台账既有账，不新增计账轨道 |
| D | **迭代回路入口**：集群配置/蓝图修改提议→审批闸→再铸造→市场发新版（vN+1）→订阅者跟新提示 | P1 | 「市场是唯一分发更新通道」纪律延伸到主人面；走提案+拍板，不直改在册模板 |
| E | **模板装作路径**：客户从市场一键装模板集群→默认参数向导→首跑点燃 | P0 | 与 ClusterComposerModal 同一组件族，装完即入 A 的总览坞 |

## 3. 不在范围

- L3 垂直构造器（NL→蓝图的「构造师」本体）产品化——blueprint studio 属独立需求书；本单的 D 只做**已有集群**的迭代回路入口，不做零起蓝图编辑。
- 多机运行引擎改造——用户已明确多机是既有事实，本单只要求**主人可见**（A 的占位显示）。
- 任何运行时契约变动（pack 形状、`registryName`、四闸、计费轨道、market 分组语义）。
- 供给端准入（供应商身份/供方闸）——属《集群平台供给开放需求书》。

## 4. 验收口径

一个**普通客户账号**（含 trial 档）仅凭前端界面完成以下全真旅程，每步无死链、每步有如实失败路径：

1. 从市场选定一台集群模板（E），按向导完成默认参数并点燃首跑；
2. 在总览坞看见该集群转为「在跑」（A）；
3. 次日报数后能在经营读数页看到该集群的 KPI 槽位行（B）；
4. 人为触发一次 escalate，排队页可见并完成「拍板」动作，动作有审计记录（B）；
5. 花销页能看到该集群以调用量计的账目（C）；
6. 对该集群提出一次配置改动提议，经审批后发 vN+1 版，市场层出现新版记录，订阅者得到跟新提示（D）。

失败类（配额过闸/权限拒/市场重复名 409 等）按既有四闸模型如实分类回报，不静默放行或静默吞错。

## 5. 对外口径提示

主人面与相关文案遵守叙事层 change 的诚实口径：不说「接管人类所有工作」，说「职责变了」——
人退到集群主人与迭代者的位置。组件命名与文案**不新增绝对化承诺词**。

## 6. 与既有资产的锚（实施者免重复找）

- 集群载体：`AGENT_CLUSTER_README.md`（pack-as-cluster、clusters.js/clusters-db.js、ClusterComposerModal.tsx）。
- 舰队模板与编导契约：finddata 根 `fleet-packs/README.md` + spec `fleet-shared-packs`、`lex-line-fleets`、`ops-line-fleets`（KPI 槽位键雏形在 L1 包）。
- 市场分发通道与版本纪律：`fleet-packs/README.md` 铸造配方（市场=唯一分发更新通道）。
- 计费/账目：sub2api 借用契约（见 fd-wanxing CONTEXT 主人池/caller-pays）。
- 叙事契约：finddata 根 change `reposition-fleet-platform-narrative`（spec `fleet-platform-positioning` 为北极星定位 facts source）。
