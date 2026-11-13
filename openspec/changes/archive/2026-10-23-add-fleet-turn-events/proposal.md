# Proposal: add-fleet-turn-events

## Why

舰队成员回合失败目前只留在会话文本与任务对象里(`{ok:false,error}`),驾驶舱岗位卡只做**在场判定**(on_duty/missing/vacant/passive,`deriveMemberStatus`),没有任何成败维度——岗哨连续失败三天,驾驶舱仍然一片绿。任何后续编排模式(派发、流水线、事件驱动,见 `docs/fleet-orchestration-scale-explore.md` O1)都要回答「失败告诉谁」,而当前连定时模式都没回答。这是编排代数路线的第一刀,独立价值,先行落地。

## What Changes

- **回合结果事件流**:每次舰队成员回合结束(cron 节奏 / 拍板 execute-now / delegation 唤醒三条路径)追加一条只增事件,落在 fleet DB 新表 `member_turn_events`,至少含 `fleetId`、`memberId`、`source`(cron|manual|delegation)、`status`(ok|failed|interrupted)、`errorKind`、`error`、`model`、`startedAt/endedAt`、`sessionId`;归属解析复用既有 `resolveAttribution`,不新增第二套身份判定。
- **errorKind 分类**:写时从错误文本/形状归类为有限枚举——`model_upstream`(模型/上游)、`tool_permission`(工具/权限)、`runtime_not_ready`(运行时未就绪)、`timeout`(超时)、`business_refused`(业务拒绝)、`other`;纯函数,可测。
- **驾驶舱失败可见**:岗位卡呈现最近回合结果(状态 + errorKind + 失败原因),连续失败次数可读;连续 ≥3 次失败呈现「连续失败」标记;health rollup 增加失败维度计数。在场判定语义不变(不合并两个维度)。
- **事件读面**:成员级时间线 `GET /api/fleets/:id/members/:mid/turns`(分页,同报数时间线形态)+ 舰队级 `GET /api/fleets/:id/turns`(status 过滤)——为后续架构师 pack「读态」动词与 O3 派发双方事件预留同一数据源。
- **有界保留**:事件按成员限量保留(滚动裁剪,初值 200 条/岗),防长寿命舰队无界增长。

不做的:不改调度语义、不引入重试/自动降级(失败先可见)、不动报数通道语义(events 是系统记录,reports 是 agent 撰写内容,两条道不合并)、不做 O2 turnRequest 统一(后续 change)。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-fleet-core`: ADDED——回合结果事件:每次成员回合产出可查询事件(三条触发路径全覆盖、字段集、errorKind 分类、只增不改、有界保留)。
- `agent-fleet-cockpit`: ADDED——失败可见:岗位卡最近回合结果与原因、连续失败计数与「连续失败」标记、health rollup 失败维度;在场判定语义不变。

## Impact

- **代码**:`server/routes/fleets-db.js`(新表 + 读写 + 裁剪)、新模块 `server/fleet-events.js`(classifyErrorKind 纯函数 + 记录入口)、`server/cron-runner.js`(回合完成挂点:persona/a2a/cluster 三执行器统一收口处)、`server/routes/fleets.js`(两个读端点 + memberView 增失败面)、前端驾驶舱岗位卡(状态角标 + 失败原因 + 连续失败标记)。
- **spec**:两份 ADDED delta(agent-fleet-core / agent-fleet-cockpit);与在途 `add-fleet-post-model`(同为 ADDED)无 MODIFIED 交叠,共存安全。
- **测试**:新增 `scripts/test-fleet-turn-events.mjs`(纯核注入式,同 fleet-reports 测试配方):分类函数表驱动、三路径事件写入、连续失败聚合、裁剪、驾驶舱 rollup;`scripts/test-fleet-report-lane.mjs` 回归(身份注入不受扰)。
- **出片**:server/ 有改动,需镜像出片。
- **兼容性**:纯增量——无既有行为改变;驾驶舱响应 JSON 只增字段不删改;非舰队回合(cron 普通任务、非舰队 persona)不产事件,零扰动。
