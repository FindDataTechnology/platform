# 最小启用方案 · 让第一个 cell 真正用起来

> 2026-11-10。依据：fd-prod 全量只读实测（16 个 cell 库，委托策略 0、enabled 0、
> 审计官 0；拍板记录 305 条，已裁决 4 条，expired 231 条）。
>
> 这份文档是**方案**，不是操作记录。里面的命令都由你决定什么时候执行。

## 一、先说清两件不同的事

很多人会把它们混成一件，但机制完全不同，风险也不同：

| | 方案 A · 消化拍板队列 | 方案 B · 个人事务域 |
| --- | --- | --- |
| 用什么 | **既有 deputy**（`delegationPolicy.enabled`） | **新能力**（委托状 + 事项接入） |
| 解决什么 | 248 条里 192 条**堆到过期** | 让代理接住跨线阻塞/供应商口径/人事排期 |
| 前提 | 该舰队有一个 persona 岗位当常务岗 | 岗位 prompt 里要真的带 `source` |
| 风险 | 低（服务端三道硬闸，见 §五） | 中（真开始替你判断个人事务） |

**建议只做 A，B 等 A 跑一周再说。** 理由在 §六。

## 二、现状（实测，不是估计）

| 指标 | 数值 |
| --- | --- |
| cell 库 | 16 |
| 有委托策略 / enabled / 有审计官 | **0 / 0 / 0** |
| 拍板记录 | 305 |
| 其中已裁决 | **4**（2 owner + 2 deputy，都在 `1da519d4c1c0bf89`） |
| 其中 expired | **231（76%）** |
| 仍 open | 54 |

最需要处理的 cell 是 `1da519d4c1c0bf89`：59 个舰队、248 条拍板、192 条已过期。

**这说明的不是「代理不好用」，而是「队列从来没人消化」。** 这正是 deputy 被设计
出来解决的那件事，而它一次都没被启用过。

## 三、方案 A：启用常务岗消化队列

### 3.1 前提：目标舰队里要有一个 persona 岗位

deputy 只能是**该舰队内的 persona 岗位**（`deputyGuard` 按回合归属校验）。
选一个已经在跑的、节奏不快不慢的岗位（例如每天一班的汇总岗）。

查一下它有哪些 persona 岗位：

```bash
kubectl --context cheap-ts -n fd-prod exec <platform-pod> -c platform -- \
  node -e 'const D=require("/app/node_modules/better-sqlite3");
    const db=new D("/data/cells/<cell>/data/data/fleets.db",{readonly:true});
    for (const r of db.prepare("SELECT fleet_id,id,title,target_kind FROM fleet_members WHERE target_kind IN (?,?)").all("persona","auditor"))
      console.log(r.fleet_id, r.id, r.title, r.target_kind);'
```

### 3.2 必须先修的那个前提（2026-11-10 实测）

**启用 deputy 不等于开关一拨就灵。** 实测 `1da519d4c1c0bf89` 的 100 条拍板里：

```
categories: [{"c":null,"n":98},{"c":"routine-ops","n":2}]
```

**98 条的 `category` 是 NULL。** 而 `routeForItem` 拿不到类别就落 `routes.default`
→ `owner`。也就是说即使 `enabled: true`，这 98 条**一条都不会被 deputy 接走**，
会继续堆到过期。

根因刚查清并已修：`category` 在服务端校验里认、在 DB 里存、路由依赖它，
但 **MCP 的 `escalate` 工具从来不发送这个字段**。同一个形态当天出现了两次
（另一个是 `source`）。

所以真实顺序是：

| 步 | 动作 | 判据 |
| --- | --- | --- |
| 1 | 岗位 prompt 加一句：escalate 时带 `category`（`routine-ops` / `infra-ticket` / …） | —— |
| 2 | 观察 1–2 天，看新条目的 `category` 非空比例 | **≥ 90%** 才继续 |
| 3 | 再开 `enabled: true` | 此时 deputy 才真的看得见队列 |
| 4 | 存量 94 条 expired **不动** | 终态重放没有意义 |

**这一节是方案里最重要的一节。** 原以为「一次 PUT 就消化队列」是错的。

### 3.3 配置（一次 PUT）

```bash
curl -s -X PUT http://<cell>/api/fleets/delegation-policy \
  -H 'content-type: application/json' \
  -d '{"scope":"fleet","fleetId":"<fleetId>","policy":{
        "enabled":true,
        "deputyMemberId":"<persona 岗位 id>",
        "maxSeverity":"normal",
        "dailyBudget":5,
        "digest":"daily"
      }}'
```

要点：

- **`dailyBudget: 5`**：默认 20 太松。第一周先 5，看清它裁得对不对再放。
- **`maxSeverity: normal`**：high 仍然全部回到你手里。
- 三类硬闸不受这个配置影响：`config-change` / `人事` / `花费` **永远**路由 owner
  （`normalizeRoutes` 里写死，写进策略也会被归一化覆盖）。

### 3.4 它会做什么、不会做什么

| 会 | 不会 |
| --- | --- |
| 把 `routine-ops` 类拍板项裁决掉（批准/驳回并附依据） | 碰 `config-change` / 人事 / 花费 |
| 把 `infra-ticket` 类归并、跟踪、一次性上报 | 裁决 high severity |
| 每天给你一份裁决摘要（进记忆 reference 层） | 超过当天 5 条 |
| 判不了时转回你，并附它的分析 | 改你的策略或动别的岗位 |

### 3.5 一键收回

```bash
curl -s -X PUT http://<cell>/api/fleets/delegation-policy \
  -H 'content-type: application/json' \
  -d '{"scope":"fleet","fleetId":"<fleetId>","policy":{"enabled":false}}'
```

`enabled:false` 后新条目全部路由 owner，**已裁决的不追溯**（这是设计里的明确取舍：
追溯改写会让「谁在什么时候决定的」变成一笔糊涂账）。

### 3.6 观察指标（第一周每天看一次）

```bash
# 1) 队列是否在消化：expired 增速应显著下降，open 应在下降
# 2) deputy 裁了多少、依据是否引用判例
kubectl ... node -e '…SELECT resolved_by, COUNT(*) FROM decision_items GROUP BY resolved_by…'
# 3) 成本：deputy 的回合数 × 单价
```

判据写死三条，别凭感觉：

1. **expired 日增量** < 启用前的一半；
2. **deputy 裁决里带 evidence 的比例** = 100%（服务端强制，若不是 100% 说明有 bug）；
3. **你推翻（amend / reopen）的比例** < 20%。高于 20% 说明口径没对上，把预算收回到 1-2 条继续观察。

## 四、方案 B：个人事务域（建议后置）

### 4.1 它的真实前提

刚修完的一处缺陷值得写在这里：**`escalate` 此前不认 `source`**，所以
「跨线阻塞 → ops」这条映射配了也永远不会有一个事项落进去。
现在 `source` 已透传，但**还要岗位的 prompt 里真的去写它**：

```text
遇到跨线阻塞（别的仓库/会话在等你的产出）时，escalate 请带
source="cross-line-blocker"；供应商口径带 source="supplier-thread"；
人事与排期带 source="people-schedule"。
```

不写这句，映射依然空转——**这不是配置问题，是 prompt 问题**。

### 4.2 配置

```bash
# 1) 开来源
curl -X PUT http://<cell>/api/fleets/delegation-policy -d '{"scope":"cell",
  "domainMap":[{"source":"cross-line-blocker","enabled":true}]}'

# 2) 给域授权到「起草」（先别上自动）
curl -X PUT http://<cell>/api/fleets/delegation-policy -d '{"scope":"cell",
  "mandate":{"version":2,"domains":{"ops":{"mode":"draft","limits":{"count":5}}}}}
```

### 4.3 一个必须知道的语义

`ops` 域的 `mode` **不影响路由**：人员/花费/配置那套类别路由说了算，`agentMayHandle`
只对非 `ops` 域生效。所以给 `ops` 配 `draft` 目前是「声明」而不是「开关」——
真正会改行为的是 `external-comms` / `advancement` / `research` 这三个个人域。

想让它真起作用，第一个该开的是 **`external-comms` + `supplier-thread`**：
供应商问报价 → 代理起草、你放行。**不发出去**，所以错了也只是浪费一次阅读。

### 4.4 一键收回

```bash
curl -X PUT http://<cell>/api/fleets/delegation-policy -d '{"scope":"cell","domainMap":[]}'
curl -X PUT http://<cell>/api/fleets/delegation-policy -d '{"scope":"cell",
  "mandate":{"version":2,"domains":{"external-comms":{"mode":"advise"}}}}'
```

## 五、为什么 A 的风险是「低」

不是靠提示词约束，是三道服务端硬闸，每道都有测试：

| 闸 | 位置 | 越界结果 |
| --- | --- | --- |
| 类别硬闸 | `normalizeRoutes` | 三类高风险写死 owner |
| 严重度上限 | `fleets.js` resolve | 403 `beyond delegation mandate` |
| 日预算 | `fleets.js` resolve | 429，剩余项回落 owner |
| 归属校验 | `deputyGuard` | 403 `this post is not the fleet's delegated deputy` |

再加两条数据纪律：判例只收你手打/你原样发出的（`deputy-ruled` 永不进判例集），
裁决必须引用具体判例，无引用即拒。

## 六、为什么 B 建议后置

1. **B 的价值依赖 A 攒出的判例**：判例为零时它只能靠通用常识，那是「猜」不是「代表你」；
2. **一致率阈值现在是空的**：真实裁决全库只有 4 条，80% 这个门槛没有样本，形同虚设；
3. **对外车道还没有反向能力**：撤不回的消息一律回落 draft，所以 B 的第一阶段
   （`external-comms` + `draft`）实际上只会产出草稿——这没问题，但它意味着
   **B 现阶段不会真的替你说话**，只是替你起草。

结论：先 A 一周，把判例和一致率喂起来；再开 B 的 `draft`；`act-notify` 要等层级
样本达标（服务端会拦，不需要你记）。

## 六之二、目标已经选定（实测）

| 项 | 值 |
| --- | --- |
| cell | `1da519d4c1c0bf89` |
| 舰队 | `fleet_1792719144128_qap1vx`「公司式集群」 |
| 拍板 | 100 条，其中 **94 条已过期** |
| 岗位 | CEO（`0 * * * *`）/ 开源部 / 投资部 / 助理部 / 电商部 / 内容部 + **常务岗（`*/20 * * * *`）** |

**这个舰队已经有一个常务岗，每 20 分钟巡逻一次**——它跑了一百次，一次都没裁过，
因为委托策略是 `enabled: false`，而且队列里的条目没有 `category`。

选它的理由：队列最长、岗位最全（有现成的常务岗，不用新建岗）、且是内部运营
（不涉及对外发声，错了的代价可逆）。

## 七、验收：这两条命令能自己说话

```bash
# 就绪检查（只读，退出码 0=可用 1=有阻塞项）
node scripts/personal-agent-doctor.mjs --db <cell>/data/data/fleets.db

# 全链路 11 个场景（本机跑，不动生产）
node scripts/verify-agent-scenarios.mjs
```

对现状跑 doctor 会输出（因为 policy=0、来源全关）：

```
结论: 还不能用：至少一个域被授予了权限；至少一个事项来源已开启
! 有可引用的判例  0 条
! 有审计官岗位    未设立
```

**这才是「如实」的样子**：不是报错，是明确告诉你缺哪一条、怎么补。
