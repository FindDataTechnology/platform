# Tasks: add-agent-config-dims

- [x] 1.1 迁移:`fleet_members` + `fleets` 各增 `effort`(TEXT) 与 `context_budget`(INTEGER) 两列(可空,守卫式 ALTER);`bots` 同增两列;验证:冷启+存量库两路迁移成功、老行读 null、既有单测零新增红
- [x] 1.2 `fleet-model.js` 增纯函数 `resolveAgentEffort({agentEffort, fleetEffort, cellEffort, model})` → `{effort, notices}`:首个「非空且被模型支持」的值生效,全不可用则 effort=null+notices;验证:单测 声明生效/继承/不支持回落/零声明空 notices
- [x] 1.3 `fleet-events.js` 回合整形增 `context_budget` 判定(usage 可用且超限 → failed + errorKind=context_budget + 摘要含实际/上限;usage 缺失不判);`ERROR_KINDS` 增枚举;验证:单测 超限失败/未声明不限/无用量不判
- [x] 1.4 `cron-runner.js` 回合起点按生效 effort 调 `dshBridge.setModel({effort})`(值变化才调,失败 degrade-open 记 warn 不失败回合);验证:单测 同值跳过/变化调用一次/调用抛错回合继续
- [x] 1.5 写面校验:`PATCH /api/fleets/:id/members/:mid` 与 `PATCH /api/fleets/:id` 接受并校验两列(非法 400 列可选档位);bots 写面同;验证:路由测试 非法档位/非法预算拒绝、合法落库、可清除
- [x] 1.6 前端:检查器配置页签增 effort 下拉(仅当生效模型支持时渲染)与 context 数字输入(空=不限);BotsPage 同;i18n 五语言;验证:typecheck/biome 绿,e2e 断言控件出现/保存 payload
- [x] 1.7 全量回归(舰队八套+e2e)+出片随下班车+真机眼见(给 CEO 岗设 high 跑一轮,回合记录可见档位)
