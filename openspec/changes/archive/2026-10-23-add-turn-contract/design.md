# Design: add-turn-contract

> explore 底稿 §五/O2 修订版。纯重构,行为零变化。

## D1 · 派生函数是唯一新增的「机制」

`buildTurnRequest(job)` 纯函数,输入任务引擎记录,输出契约。不构造、不执行、不落库——构造路径(O3 的 dispatch、O4 的边点火)是后续 change 的事,它们到时候**先构造 turnRequest、再由它反向物化任务**;本 change 只把「读」的方向立住。O1 已证明读方向覆盖全部路径(三源判定在生产语义里就是 source 派生)。

## D2 · 字段映射(全部来自既有事实,零发明)

| 契约字段 | 派生自 | 备注 |
|---|---|---|
| source | `sourceTag?.fleetId → cron`;`origin?.fleet → manual`;`initiator → delegation`;否则 manual | 与 O1 三源判定同规则,此后只有这一份 |
| targetRef | `{kind: targetType, id: preset}` | targetType 即 persona/cluster/a2a 既有三值 |
| brief | `prompt` | |
| evidence | `{sourceTag?, origin?, initiator?}` 原样透传 | 「可解析的触发依据」 |
| resultSink | `initiator ? caller : report` | delegation 聚合回投是既有事实,不是新能力 |
| depth | `targetType === "a2a" ? 1 : 0` | 对齐 a2a-client 既有深度头语义 |
| budget | `executionPolicy?.timeoutMinutes ?? null` | 分钟,可空 |

## D3 · 取值受界:常量真源 + 保留位拒绝

`SOURCES = ["cron","manual","delegation"]` + `RESERVED_SOURCES = ["peer","event"]`;`RESULT_SINKS = ["report","caller"]` + `RESERVED_RESULT_SINKS = ["blackboard"]`;`DEPTH_BOUND = 1`。`assertTurnRequest(request)` 校验并结构化拒绝保留位/超深度,错误文案指明保留去向(O3/O4/O5)。`buildTurnRequest` 只产合法值,校验器服务未来的构造路径与测试。

## D4 · 单一定源:fleet-events 改为消费派生

`recordTurnEvent` 内部先 `buildTurnRequest(job)`,source/归属从 request 取;`turnSourceFor` 保留为薄别名(测试引用不破)。O1 事件字段、三源判定、零扰动语义**逐字节不变**——变化只在「规则住哪」,不在「规则是什么」。cron-runner 零改动(O1 收口已就位)。

## D5 · 测试:派生矩阵 + 拒绝面 + 等价 harness

- `scripts/test-turn-request.mjs`:六路径派生矩阵(cron 舰队/execute-now/delegation/a2a/非舰队 cron/非舰队 manual)、保留源与超深度拒绝、budget/evidence 透传;
- 等价 harness = 既有八套舰队套件全绿(turn-events 的三源判定用例是 source 同源的直接断言);
- 不新增任何执行路径断言之外的运行时行为。

## D6 · 明确不做

不实现 peer/event 构造与派发(O3);不做 mode/边/代数(O4);不加 skill 目标类型(T1);不做黑板(O5);不改任务引擎;不动 cron-runner 归位/注入/报数代码。
