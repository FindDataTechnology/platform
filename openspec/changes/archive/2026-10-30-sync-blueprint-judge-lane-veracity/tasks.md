## 1. Spec 同步（实现已在产，本 change 只补账面）

- [x] 1.1 三态判据需求：加「车道故障可区分」约束 + 两条场景（laneError 在场 / 真判不足不带 laneError）
- [x] 1.2 来源判定需求：judgeSource 三分语义 + 「名册空走部署路由归 deployment」场景
- [x] 1.3 证据组装需求：补「证据含集群身份」约束与场景
- [x] 1.4 成本闸需求：补缓存（只存 pass/fail）与每 owner 日配额两条约束
- [x] 1.5 新增「部署默认判据车道可探测」需求（judge-default 端点）
- [x] 1.6 `openspec validate --specs --strict` 失败数不得增加，然后归档并同步主 spec

## 2. 验证

- [x] 2.1 `node --test scripts/test-blueprint-judge.mjs scripts/test-blueprint-trial.mjs scripts/test-blueprints.mjs` 全绿（28/10/21）
- [x] 2.2 主 spec 既有场景差集为空（MODIFIED 不得丢场景）
