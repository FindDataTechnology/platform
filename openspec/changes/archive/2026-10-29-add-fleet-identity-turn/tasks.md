# Tasks: add-fleet-identity-turn

## 1. 身份行补回合段

- [x] 1.1 `server/fleet-reports.js`：`renderFleetIdentity` 增可选 `turn` 参数（缺省不输出该段，非成员路径与既有调用零变化）；验证：`node --test scripts/test-fleet-report-lane.mjs` 身份行既有用例全绿
- [x] 1.2 `server/cron-runner.js` 身份行装配处（runPersonaTurn 内，`childSessionId` 已在作用域）：把该轮实际落地标识作为 `turn` 传入并进行——cron 节奏与 delegation 两条唤醒路径同批覆盖；验证：`node --test` cron-runner 相关用例，身份行含 `turn=<childSessionId>`
- [x] 1.3 手动派发回合（manual task）同样带回合标识（其会话 id）；验证：单测构造 manual 任务断言 turn= 会话 id

## 2. spec 与断言对齐

- [x] 2.1 `scripts/test-fleet-report-lane.mjs`：身份行断言补第五回合字段（fleet/post/title/target/turn 五字段齐全）；验证：单测绿
- [x] 2.2 回合标识轮换用例：同一岗位两轮 turn 值互异且等于各轮子会话 id；验证：单测绿

## 3. 归档与出片

- [x] 3.1 `openspec validate --change add-fleet-identity-turn` 绿；archive 后主 spec `agent-fleet-report-lane` 需求文本与在产格式逐字对齐（含 `target=` key 名与示例校正）
- [x] 3.2 出片走查：server/ 改动随镜像上车，真机起一个成员回合，身份行五字段眼见（台账：回合身份五段）
