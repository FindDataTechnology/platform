# Tasks: add-tool-posts

## 1. 目标类型与执行器

- [x] 1.1 写面:targetKind=tool 校验(server 可路由/tool 非空/promptTemplate 合法 JSON/model 明拒)、唯一岗扫描豁免、resolveTarget tool 分支(注册表在场判定)、materializedSpec targetType=tool 映射;验证:建岗/换防/多岗/非法参数四态用例
- [x] 1.2 `runToolTurn`(cron-runner 新分支):JSON 参数→路由→一次 MCP callTool→结果落会话;三态失败分类(runtime_not_ready/other);O1 收口照常 model=null;验证:注入 fake 客户端三态用例
- [x] 1.3 manual 车道:`createManualTask` 增 tool 参数(targetType=tool);dispatch 桥与 handoff 触发器对 tool 岗放行(cluster 拒位保持);execute-now manual 分支同款;验证:dispatch/handoff 到 tool 岗两用例

## 2. 预估与架构师

- [x] 2.1 estimateFleetCost 分流:tool 岗 turns/day 计、tokens=0;fleet-architect validateFleetDraft 增 tool 目标解析与 model 拒;验证:预估断言 + draft 矩阵补 tool 行

## 3. 测试与回归

- [x] 3.1 新增 `scripts/test-tool-posts.mjs` 全绿(1.x/2.x 用例)
- [x] 3.2 十二套回归零新增红(既有三 targetKind 逐字节等价);`openspec validate add-tool-posts` 与在途 `add-fleet-orchestration` 双绿
- [x] 3.3 出片随攒车列车 + 真机验收(工具岗 cron 回合 + supervisor 派发到工具岗)+ 台账补记
