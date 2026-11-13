# Design: add-fleet-architect-pack

> explore 底稿:`docs/fleet-orchestration-scale-explore.md` §八(NL 面);Q5/Q6/Q12 决议已入 §十二。本 change 是原型:只编 schedule 模式的结构面。

## D1 · 工具面挂点:mcp.json 新条目 + thin MCP 子进程

`mcp.json` 注册 `fleet-architect` → `server/fleet-architect-mcp.js`(stdio MCP Server,delegation-mcp 同款):五工具只做 schema 声明与参数透传,业务全在桥。工具描述里写明角色纪律(「舰队编制工具——先 fleet_draft 呈 diff,经用户批准再 fleet_apply」),让工具自述成为纪律的第二载体。

## D2 · 桥:loopback-only,身份 = cell owner

`server/fleet-architect.js` 挂 `/api/fleet-architect/*`;`server/auth.js` 加 loopback 豁免(与 `/api/delegation/` 同款:`isLoopback(remoteAddress)`)。身份:壹座是单用户 cell,架构师是用户的代理——`req.user = { email: ctx.cellUserEmail, internal: true }`,作用域与舰队 owner 门天然一致。桥内部直接调 fleet 服务件(db、`resolveTarget`、`reconcileFleet`),**不做 HTTP 自环**。

## D3 · 草稿形状与校验组合(纯函数,不碰 routes/fleets.js)

```
draft = {
  mode: "create" | "edit",
  fleetId?: string,             // edit 必填
  fleet: { name, defaultModel? },
  members: [
    { op: "add" | "update" | "pause" | "resume" | "remove",
      ref?: string,             // update/pause/resume/remove 必填(岗位 id)
      title?, parentId?, targetKind?, targetId?,
      cadence?: { cron, tz, promptTemplate, enabled } | null,
      model?, fallbackModel? }
  ]
}
```

校验(`validateFleetDraft(db, draft, {resolver})`,纯组合、可注入):
- 形状:op×必填字段矩阵;cron 经 `cronParser`(复用 `fleet-reconcile` 的解析先例)、tz 合法 IANA;
- 目标存在:`resolver(member).alive`(注入,生产 `resolveTarget`);
- 唯一岗:`findPostByTarget`(add/update 换目标时);
- 树:edit 后全量父链无环;span(单父下级数)> 8 → **警告**;
- 周期:估算周期 < 15 分钟 → **警告**(地板值 env `FLEET_ARCHITECT_MIN_PERIOD_MIN`,非法回落默认);
- 错误(阻断 apply)与警告(进 diff)分开返回。

## D4 · diff 与预估器

- diff:服务端产**结构化 ops 列表**(每岗一行:op、字段级变更键值对、警告标),persona 负责渲染成人话——结构在服务端,措辞在模型侧。
- 预估(`estimateFleetCost(draft)` 纯函数):每新节奏岗 `turns/day = ⌈1440 / periodMin⌉`;舰队 `tokens/month ∈ [N·t·lo, N·t·hi]`(N=新节奏岗数,t=合计 turns/day);`lo/hi` 来自 env `FLEET_ARCHITECT_TOKEN_RANGE` 默认 `3000,8000`。**触发条件**(Q6):`新增岗 > 5 || 任一新 cron`。只估 token 量纲,不估钱(无价格源,如实)。

## D5 · apply:重校验 → 逐 op 写 → 一次 reconcile

- apply 先对草稿**原样重跑** `validateFleetDraft`(漂移如实报错拒绝——spec 场景);
- create 模式:与 `from-template` 同惯例——舰队**生而 paused 全队 + 待启动**,用户在驾驶舱确认启动(安全默认,和模板舰队一致);
- edit 模式:逐 op 执行(db 写,复用 `createMember`/`updateMember`/`deleteMember`),全部成功后一次 `reconcileFleet` 物化;任一 op 失败即停,已执行 op 保留(reconcile 幂等,下一轮收敛),错误如实返回。

## D6 · 种子:官方架构师 pack

`docs/fleet-architect.seed.json`(pack 清单形状,agents 1 枚,无 fleet 段):persona 提示钉死纪律——①写前必呈完整 diff+预估;②用户明确批准后才 apply;③未知范式以现行结构逼近并画图确认,不拒绝、不自由发挥;④管编制不管作战(不做运行时指挥)。守恒测试用 `lib/pack-manifest.js` 校验钉住(种子腐烂即红)。铸造上架随列车(与舰队种子同配方,台账补记)。

## D7 · 已知边界(如实记,不静默)

dsh 无 per-preset 工具白名单(`server/bots.js` v1 posture 注释同款事实):架构师工具随 mcp.json 对全部 persona 可见。缓解:工具描述自述角色纪律 + 写面 owner 作用域 + O1 事件全留痕(谁写的可查)。若将来 dsh 长出 per-prompt 工具开关,收紧为架构师 persona 专属是零迁移的一步。

## D8 · 测试策略

`scripts/test-fleet-architect.mjs`,纯核注入式(fleet-report-lane 配方):校验矩阵(过/每类拒/双警告)、预估器区间与触发条件、draft 不落库、apply 重校验挡漂移、create 生而暂停、edit 逐 op + reconcile 幂等、桥 owner 身份(loopback 外拒)。回归:既有舰队七套零新增红。

## D9 · 明确不做

结构化批准工具(对话级批准 + apply 重校验兜底);钱币计价;supervisor/pipeline/代数(O3/O4 change);实时指挥动词;驾驶舱改动;不改 `routes/fleets.js` 既有处理器。
