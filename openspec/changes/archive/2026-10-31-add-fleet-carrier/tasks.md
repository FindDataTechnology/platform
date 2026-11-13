## 1. 配置面

- [x] 1.1 fleet_members 加 carrier 列（additive ALTER）+ createMember/updateMember 收 carrier + memberView 透出。验证：单测写读回环 + 非法值拒绝
- [x] 1.2 fleet-orchestration 校验 constraints.carrier 值域（auto/cell/worker/runner）+ constraintsOf 带出。验证：单测合法/非法
- [x] 1.3 materializedSpec 带 carrier（member.carrier）+ specDrift 原位改写（task id/会话不动）+ task-engine task.carrier 进持久白名单、addJob/updateJob 透传。验证：单测 drift 只改承载位

## 2. 路由与闸

- [x] 2.1 cron-runner：resolveTaskCarrier 三层解析（导出可注）+ runner 路由（目录 a2a entry 匹配→a2aExecutor）+ fail-open 两源（runner-no-entry / worker-pool-inactive）warn+detail.carrierFallback。验证：单测解析顺序/路由/fail-open
- [x] 2.2 worker-slots：dispatcher 按 task.carrier 认领门（cell/runner 不认领）+ FLEET_MAX_INFLIGHT 每舰队在途闸（currentFleet 记账，达上限留队 FIFO）。验证：单测认领门/达上限留队/释放后 FIFO
- [x] 2.3 回归：既有 fleet/park/worker/cluster 面零红 + lint。验证：node --test 相关集

## 3. 真机验收

- [x] 3.1 真机：一次 cell→worker 承载改写（reconcile 原位、task id 不变）+ fail-open 一发（runner 声明无部署）+ 台账实际载体列与配置一致性。验证：证据附 change report
