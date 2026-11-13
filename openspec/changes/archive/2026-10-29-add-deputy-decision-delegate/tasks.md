## 1. Schema 与策略模型

- [x] 1.1 decision_items 增列：`route`（owner|deputy）、`resolved_by`（owner|deputy|system）、`resolved_by_model`、`ruling_evidence`、`executed_at`、`executed_session_id`（迁移 + 既有行回填 route=owner）
- [x] 1.2 委托策略模型：cell 级默认 + 舰队覆写（enabled / routes 类别映射 / maxSeverity / dailyBudget / model / digest 频率）；`config-change`/人事/花费硬编码不可委托
- [x] 1.3 escalate 入参增可选 `category` 与 `topicKey`（提交方声明的去重主题）；payload 校验扩展
- [x] 1.4 escalate 同步层：按策略计算 route；归并检查（同 member + 近 7 天相似 → 关联既有项，escalations+1，返回既有引用）
- [x] 1.5 策略设置面 API（读/写 cell 默认与舰队覆写，高风险类别拒改）

## 2. 常务岗（决策代理）

- [x] 2.1 常务岗模板（persona 岗位 + 巡逻节奏 + 工具面声明），支持加岗与 opt-in
- [x] 2.2 deputy MCP 工具：`decision_queue.read`（route=deputy + 来源岗位上下文 + 判例）、`decision_queue.resolve`（approve/reject/escalate-to-owner，服务端强制授权校验）、记忆读写
- [x] 2.3 服务端强制授权：类别白名单 / maxSeverity / dailyBudget 逐项校验，越权结构化 403 + 条目转 route=owner
- [x] 2.4 判例读取：主人过往裁决（resolved_by=owner）+ 主人记忆 D7 读缝，作为裁决依据来源；deputy 裁决 SHALL NOT 自身为判例
- [x] 2.5 巡逻回合产出走报数管线（管理面可见其轮次与产出）

## 3. 去重与问题单分流

- [x] 3.1 同步归并实现（相似度或 topicKey 匹配；关联计数；不跨岗位）
- [x] 3.2 常务岗巡逻含存量归并 triage 与问题单跟踪视图（归并后的唯一事项集、最老未决、升级历史）

## 4. 执行追踪与记忆

- [x] 4.1 送达回合完成钩子回填 executed_at / executed_session_id；outcome 从回合报数/会话派生
- [x] 4.2 队列与管理面区分「批了没执行」与「已执行」
- [x] 4.3 裁决镜像扩展到 deputy（resolved_by=deputy 的 reference 镜像）+ 按策略频率的 digest 进主人记忆
- [x] 4.4 角标口径：等你 N 件 = route=owner 的 open 数；发布时一次性 triage 重路由存量

## 5. 前端

- [x] 5.1 拍板管理面双视图（等你 / 常务岗）+ 裁决者身份与依据展示 + 收回动作
- [x] 5.2 设置面：委托策略配置（类别路由/预算/模型/digest）
- [x] 5.3 常务岗在舰队页的岗位呈现（报告与轮次继承既有面）

## 6. 测试与验收

- [x] 6.1 决策车道既有合同回归（首裁定局/过期/送达/分段注入/队列防洪）
- [x] 6.2 新增：策略路由（类别/严重度/预算）、强制授权越权 403、归并（含不误并）、收回、执行回填、判例引用、角标口径
- [x] 6.3 deputy 提示注入防线：拍板项文本不可驱动 deputy 越权（工具白名单 + 输出 schema 校验）
- [x] 6.4 生产 API 级走查（owner cookie）：策略读写/escalate 带 category 落 route=deputy/角标口径 ownerOpen=61+deputyOpen=1 分计/收回/triage 幂等（35 扫描 0 改动=保守正确）；**deputy 真机巡逻回合已补**（2026-10-29 同日）：自建常务岗 preset → `POST /:id/deputy` 新建路径设岗 → 触发巡逻 → 读队列并按授权裁决 → 记忆镜像落页 → 报告管线报数。走查当场揪出并修掉「deputy 三路由不在桥面豁免名单」的生产真缺陷（台账 §15.84，修 `7d88e06e` / 镜像 `sha-783bf24`）。**存量 66→唯一事项集仍留给 owner**：归并的语义级去重=常务岗本体职责，需多轮巡逻自然积累；文本级 triage 在 LLM 改写下按设计保守不动
- [x] 6.5 出片 + GitOps bump + 生产验证
- [x] 6.6 执行事实生产实证（挂账**已清**，2026-10-29 晚）：真机 `decision_items.d_1793228497338_p7knh6`（state=delivered, resolved_by=deputy）`delivered_at=executed_at=1793241645081`（北京 10:40:45）——送达回合完成即同笔回填，链路实证闭环。另一条 `d_1793219379758_eh6yw0` 仍 `approved/d=0/e=0`＝**未送达本就不该有执行事实**（语义正确，非缺陷）。链路单测 `test-fleet-delegation`「执行事实」用例照在
- [x] 6.7 桥面鉴权回归用例（真 `registerAuth` + logto 匿名）：deputy 三路由在 loopback 不得 401、名单外路径仍须 401；突变验证摘任一条该用例即红