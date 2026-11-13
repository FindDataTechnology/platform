# Tasks: add-fleet-architect-pack

## 1. 校验与预估核心(纯函数)

- [x] 1.1 新模块 `server/fleet-architect.js`:草稿形状与 op×必填矩阵校验、cron/tz 解析、目标存在(注入 resolver)、唯一岗(`findPostByTarget`)、树无环、span>8 与周期<15min 双警告;错误/警告分流返回;验证:矩阵单测覆盖每类拒绝与双警告
- [x] 1.2 `estimateFleetCost` 纯函数:每新节奏岗 turns/day、舰队 tokens/month 区间(env 区间假设默认 3000,8000),触发条件=新增岗>5 或任一新 cron;验证:区间端点、触发/不触发两例
- [x] 1.3 diff 产出口:归一化结构化 ops 列表(op、字段级变更、警告标);验证:create 与 edit 各一例形状断言

## 2. 桥与工具面

- [x] 2.1 `/api/fleet-architect/*` 路由(draft dry-run 不落库 / apply 重校验→逐 op 写→一次 reconcile;create 生而 paused 全队)+ `server/auth.js` loopback 豁免 + `server.js` wiring(身份=cell owner);验证:桥测试 owner 作用域、非 loopback 拒
- [x] 2.2 `mcp.json` 注册 `fleet-architect` + `server/fleet-architect-mcp.js` thin 子进程(五工具 schema 与透传,描述自述纪律);验证:工具清单与参数 schema 走查

## 3. 种子与守恒

- [x] 3.1 `docs/fleet-architect.seed.json`(1 agent,persona 钉纪律:diff 必呈/批准才写/未知范式逼近/管编制不管作战);守恒测试钉住通过 pack 清单校验;验证:改坏种子即红

## 4. 测试与回归

- [x] 4.1 `scripts/test-fleet-architect.mjs` 全绿(1.x/2.x 用例 + draft 不落库 + apply 漂移拒 + create 生而暂停 + edit 幂等)
- [x] 4.2 既有舰队七套(含 turn-events)回归零新增红;`openspec validate add-fleet-architect-pack` 通过
- [x] 4.3 出片与真机验收(与 add-fleet-turn-events、post-model 归档终验**同列车**,用户已定攒车):装 pack→对话建一支三岗舰队→驾驶舱确认启动全链;台账补记
