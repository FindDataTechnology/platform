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

### 3.2b 上产后实测：第 2 步现在**测不出来**（2026-11-10 06:0x）

上产（`sha-deb4b87`，含 category/source 与 prompt 提示）之后实测：

| 指标 | 值 | 含义 |
| --- | --- | --- |
| 回合是否在跑 | 近 6h **97 个回合**、近 1h 23 个 | 岗位在工作，不是没跑 |
| 回合失败率 | **58/97 = 60%** | 多数回合根本没跑完 |
| 失败主因 | 503 上游不可用 ×19、上下文压缩早停 ×16、上下文溢出 ×13、502 ×5 | 模型上游 + 上下文 |
| 上产后新增决策项 | **0 条** | 没有新条目可测 category |
| 存量 305 条里带 category | 2 条（0.7%） | 修复前的老数据 |

结论：**`category` 非空率目前不可测，不是因为我的修复没生效，而是因为岗位
根本走不到 escalate 那一步**——60% 的回合在模型调用或上下文就失败了。

所以真实的阻塞顺序变了：

1. 先把回合失败率压下来（模型上游 503/502、上下文溢出与压缩早停）——**这是别人的线**
   （`fix-overflow-attribution`、`glm-5.3-flash` 降级、模型声明链兜底都在同一天活动）；
2. 回合能跑完之后，才可能产出新决策项；
3. 有了新决策项，才谈 `category` 非空率 ≥ 90%；
4. 才轮到开 `enabled: true`。

**不要把第 2 步当成「配好了等观察」**——现在等一周也不会有样本。判据要改成
「近 24h 新增决策项 ≥ N 条」作为前置，样本为零时不许进入下一步。

### 3.2c 顺手做的归因：这 60% 不是我上产带来的

按上产时刻（05:25 CST）切三段比，回合失败率：

| 时段 | 回合 | 失败 | 失败率 |
| --- | --- | --- | --- |
| 上产后 1.1h | 17 | 10 | 59% |
| 上产前 1.1h | 30 | 20 | **67%** |
| 上产前 24h | 340 | 144 | 42% |

上产前一小时已经 67%，比上产后的 59% 还高；24h 基线 42%。所以恶化在上产**之前**
就开始，方向是模型上游侧（同日 `glm-5.3-flash` 因 96% 失败被降到队尾）。
**不要把这条记成个人代理的回归。** 归因方法值得复用：按部署时刻切同长度窗口对照，
而不是拿「上线后看起来很差」直接下结论。

### 3.2d 结论反转：闸门是时间问题，不是代码问题（2026-11-10 07:5x）

上一节把「60% 失败」当成阻塞，建议去改结算逻辑。**实测推翻了它**，记下来免得下次
有人照错的方向动手：

| 事实 | 读数 |
| --- | --- |
| 近 24h 压力类失败 | 149 条 |
| 其中该岗位**同期有报数记录** | **116 条 = 78%** |
| 其中产出 tokens > 0 的 | 5 条 = 3%（均 769 tok） |
| detail 形状 | `steps: 11–18`、`compactions: 6–9`、`reported: true`、`salvageSkipped` |
| 上产后新建决策项 | 5 条，**5 条全带 category** |
| 近 24h 新增决策项 | 32 条（≥ 阈值 20，量够） |

也就是说：**这些回合干完了活、报了数，然后被按「压缩≥4」的早停闸判成 failed。**
`server/cron-runner.js:1108` 的注释写明这是有意的（`the round STAYS failed
(it did not finish) but the fleet gets the data it was going to get anyway`），
所以**不该改**。真正挡住启用闸门的是 24h 窗口里还混着上产前的老条目（无 category），
再等约 22 小时它们滑出窗口，非空率自然到 100%。

三条纪律（写死，别再犯）：

1. **判达标只看上产后新建的条目**，不要用 24h 全窗口——会被老条目稀释成 18.8%。
2. **失败率必须拆成两半**：`reported: true` 的是「跑完被掐断」，不是「跑挂」。
   混成一个数会读成平台大面积故障（我第一次就这么误读了）。
3. **别用单轮各字段去反推整体**。我一开始用「失败行最常见的单个 model」得出
   「一半失败没有模型名」，全量一查只有 3%——按小时看才有 50%，是近期恶化，
   不是全量如此。口径要写清时间窗。

也都不是个人代理的问题：这 149 条的 detail 里没有任何 `mandate`/`disclose` 字段，
与委托状、披露闸无关。

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

## 八、启用命令已填实（2026-11-10 08:xx 实测取值）

前面 §3.3 的 curl 是占位符。这里把实测值填进去，到时直接执行，不用再查。

### 目标与候选

| 项 | 实测值 |
| --- | --- |
| cell | `1da519d4c1c0bf89` |
| 舰队 | `fleet_1792719144128_qap1vx`「公司式集群」 |
| **deputy 候选（memberId）** | **`m_1793223622441_akv3fj`** |
| 岗位 | 常务岗，`persona`，preset `user.preset-2` |
| 节奏 | `*/20 * * * *`（每 20 分钟） |
| 72h 表现 | **159 回合 / 70 ok / 撞墙仅 5 次（3%）** —— 全舰队最健康、最活跃 |
| 当前 delegation_policy | **未设置** |

为什么选它：deputy 必须是**本舰队的 persona 岗位**（`deputyGuard` 按回合归属校验），
而它是唯一一个「persona + 高频 + 撞墙率低」三样都占的。CEO 虽然也 persona，但
`0 * * * *` 且撞墙更多；其余部门岗都是日更，队列消化速度不够。

### 一条 PUT（把 `dailyBudget` 先给 5）

```bash
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' \
  -H 'cookie: <owner cookie>' \
  -d '{"scope":"fleet","fleetId":"fleet_1792719144128_qap1vx","policy":{
        "enabled":true,
        "deputyMemberId":"m_1793223622441_akv3fj",
        "maxSeverity":"normal",
        "dailyBudget":5,
        "digest":"daily"
      }}'
```

**改完必须回读**（本仓有过 PUT/PATCH 返 200 但字段没落库的先例）：

```bash
curl -s "http://<cell>/api/fleets/delegation-policy?scope=fleet&fleetId=fleet_1792719144128_qap1vx" \
  -H 'cookie: <owner cookie>' | python3 -m json.tool | grep -A6 policy
```

判据：`enabled: true`、`deputyMemberId` 等于上面那串、`dailyBudget: 5`。

### 收回

```bash
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' -H 'cookie: <owner cookie>' \
  -d '{"scope":"fleet","fleetId":"fleet_1792719144128_qap1vx","policy":{"enabled":false}}'
```

`enabled:false` 后新条目全部回落 owner，**已裁决的不追溯**（设计取舍）。

### 开之前必须满足的两条（当前状态）

| 前置 | 当前 | 何时满足 |
| --- | --- | --- |
| 上产后新建决策项 ≥ 20 | 约 5–8 条 | 约 2026-11-11 05:00 之后 |
| 新条目 `category` 非空率 ≥ 90% | **5/5 = 100%** | 已满足 |

所以唯一还差的是**量**，等 24h 窗口滑过去即可。观测任务每小时会报这两个数，
达标时它会提醒——**但它不会自己开**（我已明确禁止它代改）。

## 九、重大纠正：deputy 其实早就开着了（2026-11-10 09:xx）

前面 §二 与 §3.2b 说「16 个 cell、委托策略 0、enabled 0」——**那是我查错了表。**
真值在 `fleets.delegation_policy` 这一列，不在 `cell_settings`（后者只有
`delegationDigestAt`）。用错表名 `cell_settings.delegation_policy` 查，永远查到空，
于是把「没查到」当成了「没配置」——正是本次反复出现的那类错误。

### 用对表之后的全量实测

| 项 | 值 |
| --- | --- |
| cell / 舰队 | 15 / **81** |
| 有 `delegation_policy` 的舰队 | 2 |
| `enabled: true` 的 | **1** |
| 是哪一支 | `fleet_1792719144128_qap1vx`「公司式集群」 |
| deputyMemberId | `m_1793223622441_akv3fj`（常务岗，**实测是本舰队成员**） |
| dailyBudget / maxSeverity | **20** / `normal` |
| 配置合法性 | `enabled 但无 deputy` 0 个；`deputy 不在本舰队` 0 个 |

另一支有策略的是 `aavc7f`「LLM判据探针集群·试跑」，`enabled:false`。

**所以 §八 那条 PUT 不需要执行。** 已经开着，参数也合法，只是日预算是 20 不是 5。

### 那为什么队列还是不长？

因为它卡在**另一个开关**上。对同一支舰队跑真机就绪检查（`personal-agent-doctor`
只读跑在 `/data/cells/1da519d4c1c0bf89/.../fleets.db` 上）：

```
结论: 还不能用：至少一个事项来源已开启

✓ 至少一个域被授予了权限        已授予: ops=draft
✗ 至少一个事项来源已开启        三个来源全关——没有任何事项会进入它负责的域
! 有可引用的判例                0 条
! 有审计官岗位                  未设立
```

这是**我的代码在真实生产数据上第一次跑出完整结论**，结论是对的、可操作的。
四个面里：授权有了（`ops=draft`，来自 legacy 策略的 `legacyOpsBlock`）、
**事项接入三个来源全关**、判例 0、无审计官。

### 修正后的真实启用路径

| 步 | 动作 | 现状 |
| --- | --- | --- |
| 1 | 开一个事项来源（`personalDomainMap`） | **未做 —— 这是唯一的 blocked 项** |
| 2 | 攒判例 | 0 条，靠正常使用积累 |
| 3 | 建审计官岗 | 未设立 |
| ~~4~~ | ~~开 `enabled: true`~~ | **已经开着，跳过** |

注意第 1 步的语义（§4.3 已写）：`ops` 域的 mode 不影响路由，真正让个人事务流起来的是
`external-comms` + `supplier-thread` 这类个人域 + 对应来源。所以开来源之前要先确认
目标域已配置，否则来源开了也没人接。

### 教训

`cell_settings` 与 `fleets` 两处都有「委托/策略」味道的键，但只有后者是真值。
判「有没有配置」之前先确认**读的是哪张表的哪个键**——我这次连着两次
（上一会话的 survey 与本会话引用）都沿用了同一个错表，直到真机跑 doctor 才暴露。

## 十、最后一步也备好了：开哪一个来源才对得上已授权的域

§九 说唯一 blocked 是「事项来源全关」。这条也不能随便开——**来源开错了，落在没授权的域上，等于什么都没发生**。映射是代码里的常量（`lib/personal-domain-map.js`）：

| 来源 | 落到哪个域 |
| --- | --- |
| `cross-line-blocker`（跨线阻塞与依赖） | **`ops`** |
| `supplier-thread`（供应商/合作方答复口径） | `external-comms` |
| `people-schedule`（人事与排期冲突） | `advancement` |

而这个 cell 实测只有 **`ops=draft`** 被授予（doctor 原文：`已授予: ops=draft`），
另外三域未配置。所以：

> **只开 `cross-line-blocker` 一个来源。** 它落到 `ops`，而 `ops` 已经是 draft，
> 开完 doctor 的第一条 blocked 应当翻绿。开另外两个来源是无效的——它们落在
> 未授权的域，doctor 会继续报「来源开了但域没授权」。

### 一条 PUT（只需这一个来源）

```bash
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' \
  -H 'cookie: <owner cookie>' \
  -d '{"scope":"cell","domainMap":[{"source":"cross-line-blocker","enabled":true}]}'
```

返回即 `{"ok":true,"scope":"cell","domainMap":[...]}` —— 这个端点**会回写整张表**，
所以回读就是它自己的响应，但也请再 GET 一次确认（同 §八 的理由）：

```bash
curl -s "http://<cell>/api/fleets/delegation-policy?scope=cell" -H 'cookie: <owner cookie>'
```

判据：`cross-line-blocker.enabled === true`，另两个来源仍是 `false`。

### 开完之后预期

真机 `personal-agent-doctor` 应从

```
结论: 还不能用：至少一个事项来源已开启
✗ 至少一个事项来源已开启
```

变成

```
结论: 可以跑，但有 2 处值得看一下
✓ 至少一个事项来源已开启   已开启: cross-line-blocker
! 有可引用的判例           0 条
! 有审计官岗位             未设立
```

`退出码` 从 1 变 0。**这就是「可用」的定义**：能跑，但判例还是零、没有审计官。
这两个 warn 靠使用与建岗消除，不是配置项。

### 收回

```bash
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' -H 'cookie: <owner cookie>' \
  -d '{"scope":"cell","domainMap":[]}'
```

空数组会被 `normalizeDomainMap` 填回三条**全关**的默认形状，等价于停流。

### 为什么这一步仍然不该我做

它改的是「哪些个人事务进入代理负责的范围」——是**主人的授权边界**，不是运维参数。
而且我的身份调这个端点会 401（内部桥只开 7 条 POST，`PUT /delegation-policy` 不在内）。
所以：命令备好，由你执行，执行完我可以立刻只读复验 doctor 的输出是否如预期翻转。

## 十一、非空率 100% 不等于产出可用（2026-11-10 补测）

上产后 6 条决策项的 `category` 全非空（100%），我一度当成「链路已通」的证据。
把 6 条**内容**拆开看之后，这个绿灯要打折：

| 时间 | 岗位 | 类别 | 内容摘要 |
| --- | --- | --- | --- |
| 02:18 | 押注岗 | routine-ops | 取数通道未挂载 → 0 条可验结论 |
| 01:49 | CEO | infra-ticket | 助理部全部外部数据通道失效 |
| 01:42 | 常务岗 | infra-ticket | 声称 decision_queue / escalate 均报「not a member of any fleet」 |
| 01:02 | 指标巡检员 | config-change | 政心真库读面不可用 |
| 00:44 | CEO | config-change | 岗位探活失败 |
| 00:09 | 产出位 | infra-ticket | 账实对账通道整条 NOT_WIRED |

**六条全是「我的工具/通道坏了」的自我诊断，没有一条是业务事项。**

其中常务岗那条经核查是**模型转述错误**：
`this agent is not a member of any fleet` 在仓里的唯一出处是
`server/fleet-reports.js:151`，那是 **`report_status`（报数）** 的归因失败话术，
与 `decision_queue` / `escalate` 无关。模型把报数的错误套到了另外两个工具上。

所以：

1. **「非空率 ≥ 90%」只证明字段传对了，不证明产出有价值。** 判据必须补一条
   内容维度，否则拿一串自我诊断噪声也能验收通过。
2. **不要相信条目正文里的工具诊断。** 模型会把 A 工具的报错讲成 B 工具坏了，
   并据此发假警报。要判工具通不通，只能自己调一次或看该轮的 trace 返回原文。
3. 这条线在此停：继续追等于相信模型的自述；自己构造归因头去调
   `/api/fleets/deputy/queue` 等于伪造身份，不做。

### 建议给观测补的第五行（下次改观测任务时加）

```
CONTENT 上产后新增里 业务事项 / 自我诊断 各几条
```
判据：**业务事项 ≥ 半数**才算真达标。只报非空率会让自我诊断噪声冒充进度。

### 十一之二、启用闸门补一条硬前置：业务事项占比 ≥ 50%（2026-11-10 实测）

把「业务事项 / 自我诊断」这一维度加进观测后，第一次读数就是：

```
POSTDEPLOY 上产后新增 6 条，带 category 6 条
CONTENT   业务事项 0 / 自我诊断 6
```

即 **100% 非空率、0% 业务价值**。

所以原闸门（`上产后新增 ≥ 20 且 category 非空率 ≥ 90%`）**不充分**，补一条硬前置：

| 闸门 | 判据 | 现在 |
| --- | --- | --- |
| 量 | 上产后新增 ≥ 20 条 | 6（差 14） |
| 字段质量 | category 非空率 ≥ 90% | **100% ✅** |
| **内容质量（新）** | **业务事项 / 上产后新增 ≥ 50%** | **0% ❌** |

**业务事项占比不达标时，即使量到了 20 条也不开 deputy。** 理由很直接：
让一个专门处理「个人事务」（跨线阻塞 / 供应商口径 / 人事排期）的代理，
去裁一堆「我的通道坏了」的自我诊断，不是激活，是把噪声灌进裁决队列——
而且它裁得越多，裁决记录（判例）就越脏，而判例是这套东西唯一的信任基础。

分类口径（写死在观测脚本里）：命中
`通道|探活|未挂载|不可用|失效|NOT_WIRED|绑定|读不到|读面|取数`
任一即为「自我诊断」，其余算业务事项。这口径粗糙，但 0/6 的差距不需要更细的尺子。

### 这也解释了「为什么 6.5 小时只有 6 条」

岗位不是在做事，是在**报自己的工具坏了**。而上一节已查明其中一条是模型幻觉
（把 `report_status` 的错误讲成 `decision_queue` 坏了）。所以真正要解决的是
「岗位为什么频繁自认工具故障」，不是「怎么让它多拍板」。

### 十一之三、收回「业务占比 0%」——那个口径太粗，把正当事项也扫成了噪声

§十一之二 用一条正则（命中 `通道|探活|未挂载|不可用|失效|NOT_WIRED|绑定|读不到|读面|取数`
即算自我诊断）得出「业务事项 0 / 自我诊断 6」。**逐条重读原文后，这个判断是错的。**

| 岗位 | 原文要点 | 粗分类 | 实际性质 |
| --- | --- | --- | --- |
| 押注岗 | 「分析岗仍报取数通道未挂载→0 条可验结论，但取数岗已确认恢复并交付 5 条带口径序列（晚 20 小时）。押注岗因此无结论可落行。**是否让分析岗立即基于这 5 条重跑？**」 | 自我诊断 ❌ | **正当的协调决策**：有事实、有冲突、有建议、明确要人拍 |
| 产出位 | 「账实对账通道整条 NOT_WIRED：账本无仓库维度、WMS 无库存快照、采购/到货/入库全断」 | 自我诊断 ❌ | **真实的数据缺口报告**（正是「跨线阻塞」这类事项） |
| 常务岗 | 「decision_queue / escalate 均报 not a member of any fleet」 | 自我诊断 | **幻觉**：该话术的唯一出处是 `server/fleet-reports.js:151`，属 `report_status` |
| CEO | 「akv3fj 岗探活失败：试了 m_1792719144128_akv3fj 与 m_akv3fj 均返回 not a member」 | 自我诊断 | **合理误推**：真实 id 是 `m_1793223622441_akv3fj`（创建时间戳不同），它按其它岗位的规律类推拼了一个不存在的 id |
| CEO | 「助理部全部外部数据通道失效（引用其 01:35Z 报数）」 | 自我诊断 | 转述他人报数，待查 |
| 指标巡检员 | 「政心真库读面不可用」 | 自我诊断 | 待查 |

**结论：六条里至少 2 条是正当事项（33%），不是 0%。**

#### 为什么这个错很要紧

这套代理要处理的「跨线阻塞与依赖」，**本来就长这样**——另一条线/另一个岗位的产出没到，
所以这件活儿没法往下走。用「提到通道/取数/NOT_WIRED 就算噪声」去筛，
恰好会把目标事项整类筛掉。

#### 修正后的口径

取消「业务事项占比 ≥ 50%」这条硬闸（它的分类器不可靠，会误杀）。改成**人工抽样**：

```
每轮把上产后新增的条目原文逐条读一遍（现在只有几条，读得起），
判断标准是三条：① 有没有具体事实/证据 ② 有没有明确的「要拍什么」
③ 建议是不是可执行的。三条都缺的才是噪声。
```

**不要用关键词正则做这个判断。** 正则能把「取数通道」判成噪声，也能把
「跨线等另一条线的产出」判成噪声——而后者正是这套东西的用途。

#### 真正值得记的模式（比分类更重要）

这六条暴露出岗位的一个共性行为：**遇到工具/数据异常，第一反应是发一条
「基础设施坏了」的决策项，而不是先把事实查清楚。** 其中已经实证两种误报机制：

1. **转述错误**：把 A 工具的错误信息说成 B 工具坏了（常务岗）；
2. **规律类推**：按别的成员的 id 规律拼一个不存在的 id 再报「探活失败」（CEO）。

这两种都不是「模型胡编」，是**在信息不足时做了合理但错误的推断**。要治的是
「报之前先验一次」——比如 `探活` 前先用 `fleet_members` 确认 id 存在。

（这条属于 fleet 回合的可靠性问题，不是个人代理功能的问题，交回那条线。）

### 十一之四、路由分布才是对的判据：6 条里只有 1 条真能进 deputy（2026-11-10）

§十一之三 收回内容分类之后，缺一个客观替代品。实测发现**路由**就是：

| 路由 | 上产后新增 | 类别 |
| --- | --- | --- |
| `owner` | **4** | `infra-ticket`×2、`config-change`×2 |
| `deputy-triage` | 1 | `infra-ticket` |
| **`deputy`（真能裁）** | **1** | `routine-ops` |

即 **1/6 = 16.7%** 落在 deputy 的裁量范围。

#### 为什么这条比「业务占比」可用

1. **客观**：`routeForItem` 按 category 算出来的，不是我的主观分类；
2. **直接对位闸门**：deputy 能不能裁，看的就是 route，不是内容像不像业务；
3. **可再生**：每小时重算，不依赖人读原文。

#### 它推翻了一个隐含假设

原计划是「等上产后新增涨到 20 条再开」。按 16.7% 的比例，20 条里只有 ≈3 条进 deputy。
而常务岗 `*/20 * * * *`（每天 72 轮）、`dailyBudget: 20` —— **3 条/天喂不饱它**，
更别说积累判例（判例是这套东西唯一的信任基础）。

**所以「等量」这个策略本身是错的。** 真问题是：
产出里 83% 是 `infra-ticket` / `config-change`，而这两类按设计**永远硬锁给主人**
（`normalizeRoutes` 写死：配置改动 / 人事 / 花费三类不可委托）。
这不是修复的缺陷，是**岗位在干什么**的问题——它们在报基础设施坏了，不是在处理要拍板的事。

#### 修正后的闸门（三条，全部客观）

| 闸门 | 判据 | 现在 |
| --- | --- | --- |
| 量 | 上产后新增 ≥ 20 | 6 ❌ |
| 字段质量 | category 非空率 ≥ 90% | 100% ✅ |
| **可裁量（新）** | **`route=deputy` 的条目 ≥ 5** | **1 ❌** |

第三条替代了已收回的「业务占比 ≥ 50%」：同样是内容质量，但它由系统算、不由我判断。

#### 观测第五行

```
ROUTE 上产后新增按路由分布 owner / deputy-triage / deputy
```
判据：`route=deputy` 累计 ≥ 5 才算有东西可裁。只看总量会让 83% 的硬锁项冒充进度。
