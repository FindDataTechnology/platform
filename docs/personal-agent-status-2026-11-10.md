# 个人代理 · 状态单一事实来源（2026-11-10）

> 这份文档**取代**零散结论。本会话推翻了八次自己的判断，散落在三份文档里；
> 这里只留「现在实际相信的」。有冲突时以本文为准，并看 §四 的订正表。

## 一、什么已经上产（经血缘验证，不是经「我推了」）

| 项 | 值 |
| --- | --- |
| 生产镜像 | 本会话内滚过多次，最近确认 `sha-ee3e876` 系（pod 名每小时都可能变） |
| 我的合并 | `968a3fc38`（+ `9811d3622`），**是该镜像 BUILD-INFO 里 `baseCommit` 的祖先** |
| 镜像内探针 | 6/6 在位：`assessPersonalAgent`、`AUDITOR_ALLOWED_TOOLS`、`isPersonaBackedTargetKind`、`ESCALATE_CATEGORY_HINT`、`SCHEMA_HEAD`、`auditor_submit_verdict` |
| `healthz` | 200，`cells:4, cellsInError:0` |
| 迁移 | `[db] applied migration v119`；head=119 的 cell 已拿到 `mandate_domain/principal/audience` |
| 归档 | 三个 change 已归档，`validate --strict` 通过 |

**判据纪律**：判断「我的代码在不在线上」只能靠
`git merge-base --is-ancestor <我的合并> <BUILD-INFO.baseCommit>` + pod 内 grep 符号。
镜像 tag 与我的提交没有直接关系（出片源是 `scs001/platform-image-verify` 的快照）。

## 二、启用到底卡在哪（三条客观闸门）

| 闸门 | 判据 | 2026-11-10 实测 | 状态 |
| --- | --- | --- | --- |
| 量 | 上产后新增 ≥ 20 | 6 | ❌ |
| 字段质量 | `category` 非空率 ≥ 90% | 100%（6/6） | ✅ |
| **可裁量** | **`route=deputy` 累计 ≥ 5** | **1** | ❌ |

**第三条是关键，也是本会话最重要的发现。** 上产后 6 条的路由分布：

```
owner 4（infra-ticket ×2、config-change ×2）
deputy-triage 1（infra-ticket）
deputy 1（routine-ops）
```

即 **只有 16.7% 进得了 deputy 的裁量范围**。原因不是量不够：产出里 83% 是
`infra-ticket` / `config-change`，而这两类在 `normalizeRoutes` 里**硬锁给主人、
永不可委托**。

**所以「等量涨到 20 再开」这个策略本身是错的**——按 16.7% 算，20 条里只有约 3 条
可裁，而常务岗每天 72 轮、日预算 20，3 条/天喂不饱，更攒不出判例。

## 三、唯一缺的那个开关，以及它为什么不该我开

真机 `personal-agent-doctor` 对 `1da519d4c1c0bf89` 的结论：

```
结论: 还不能用：至少一个事项来源已开启
✓ 至少一个域被授予了权限        已授予: ops=draft
✗ 至少一个事项来源已开启        三个来源全关
! 有可引用的判例                0 条
! 有审计官岗位                  未设立
```

- **deputy 本身早已 `enabled: true`**（`fleets.delegation_policy`，deputy =
  `m_1793223622441_akv3fj` 常务岗，dailyBudget 20，maxSeverity normal，配置合法）。
  **不要再发一次「开 enabled」的 PUT。**
- 唯一 blocked 是事项来源 `personalDomainMap` 全关。来源→域映射是代码常量：
  只开 **`cross-line-blocker`**（落到已授权的 `ops`）；另两个来源落在未授权域，开了无效。

```bash
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' -H 'cookie: <owner cookie>' \
  -d '{"scope":"cell","domainMap":[{"source":"cross-line-blocker","enabled":true}]}'
```

开完预期：doctor 从「还不能用」翻成「可以跑，但有 2 处值得看一下」，**退出码 1→0**。

为什么我不开：它改的是**主人的授权边界**，且我的身份调该端点必然 401
（内部桥只开 7 条 POST，`PUT /delegation-policy` 不在内）。

## 四、本会话推翻自己的八次（每条都别重走）

| # | 曾经的判断 | 实际 | 错在 |
| --- | --- | --- | --- |
| 1 | 该改「报过数仍记 failed」的结算逻辑 | `cron-runner.js:1108` 注释写明是有意的；且不解决阻塞 | 没读代码里的决定 |
| 2 | 近 6h 60% 失败是常态 | 那是 04:00–06:00 上游 503 事故窗；48h 稳态撞墙 9% | 窗口 |
| 3 | prompt 加步数上限能降撞墙 | 全量 117 回合 9% vs 747 回合 10%，**无差异** | 挑 5 个岗位 |
| 4 | 16 个 cell 委托策略 0 / enabled 0 | 真值在 `fleets.delegation_policy`；**1 支已 enabled** | 查错表 |
| 5 | prompt 提 escalate 使产出率高 7.9× | 收窄到已启用舰队后降到 2.8×，落在「无效」区间 | 没控混杂因子 |
| 6 | 常务岗读不到 decision_queue | 那句话出自 `fleet-reports.js:151`，是 **`report_status`** 的错 | 把模型自述当事实 |
| 7 | 上产后业务事项 0 / 自我诊断 6 | 逐条重读至少 2 条是正当事项（押注岗的协调决策、产出位的缺口报告） | 正则误杀 |
| 8 | 等量涨到 20 就可以开 | 83% 是硬锁主人的类别，加量也不会变成可裁项 | 策略错了 |

**共同病根**：口径错（1–5）、信源错（6）、判据错（7）、策略错（8）。
可复用的两条：**分组前先问「两组在别的维度上是不是本来就不一样」**；
**岗位自述的工具故障不等于工具真坏了**（已实证两种误报：转述错误、按 id 规律类推）。

## 五、剩下两件事，都在你手上

| # | 动作 | 产出 |
| --- | --- | --- |
| 1 | 开 `cross-line-blocker` 来源（上面那条 PUT） | 我复验 doctor 退出码 1→0 |
| 2 | 给 `XINGYAN_ADMIN_PW` | 我重发英文教学贴并复验（现在 `/en/` 是回退壳：HTTP 200 但返回站点首页 title、正文 0 命中） |

## 六、交给别人线的两件（不是我的）

1. **`attributionFor` 全仓无调用方传参**：110 条撞墙 `cause` 100% 未判定。
   数据源已有（`usage_cached_input`，48h 内 48% 有值），约十行接线活。
   交 `fix-overflow-attribution` 线，判据：`cause` 非空显著 > 0 且两桶都出现。
2. **岗位遇异常先报「基础设施坏了」而不是先查事实**：六条里三条是误报/幻觉/转述。
   已实证两机制（转述错误、按 id 规律类推拼不存在的 id）。属 fleet 回合可靠性。

## 七、不成立、别当真的东西

- 「非空率 100% 说明链路有价值」——只说明字段传对了（§二）。
- 「deputy 还没开」——早开了（§三）。
- 「队列里堆的是待拍板事项」——83% 是不可委托的类别（§二）。
- 「岗位报的通道故障是真的」——已实证有转述错误与规律类推两种误报（§四·6）。

---

## 附：读这份文档的人请先看这四行

1. **不要重发「开 enabled」的 PUT** —— 早就开着（`fleets.delegation_policy`）。
2. **不要用「上产后新增 ≥ 20」判达标** —— 83% 是不可委托的类别，加量无用（§二）。
3. **不要用内容关键词正则判条目质量** —— 会把「跨线等另一条线的产出」误杀（§四·7）。
4. **不要相信条目正文里的工具故障自述** —— 已实证两种误报（§四·6）。

这四条都是本会话用真实数据否掉的东西，每一条我都先信了、后被自己的测量推翻。

---

## 八、场景 3（对外接待与商务问询）在生产上从未配置过（2026-11-10 实测）

用户最初定的首发是**场景 2（团队阻塞与拍板）+ 场景 3（对外接待与商务问询）**。
实测全量 15 个 cell：

| 检查 | 结果 |
| --- | --- |
| 有 mandate 的 cell | **1 个**（`1da519d4`） |
| 出现过的域 | **只有 `ops(legacy): draft`** |
| `external-comms` | **0 次** |
| `advancement` | **0 次** |
| `research` | **0 次** |

而且那个 `ops` 不是显式配的——是从 legacy 扁平策略推导出来的（`legacyOpsBlock`）。
**也就是说：委托状设置面板从来没被人打开过。**

对应关系：

| 用户要的场景 | 依赖 | 现状 |
| --- | --- | --- |
| 场景 2 · 团队阻塞与拍板 | `ops` + deputy + `cross-line-blocker` | 域有（legacy 推导）；来源全关 |
| **场景 3 · 对外接待与商务问询** | **`external-comms` + `supplier-thread`** | **两条都是零** |

### 修正 §三 的优先级

§三 里我写「只开 `cross-line-blocker`（落 ops，最小动作）」——**那只是最小动作，不解决场景 3**。
按用户最初的意图，真正缺的是 `external-comms`：

| 步 | 动作 | 说明 |
| --- | --- | --- |
| 1 | 给 `external-comms` 授 `draft` | 场景 3 前置；`draft` = 只起草、不发、你放行，**错误成本最低的起步档** |
| 2 | 开 `supplier-thread` 来源（落 `external-comms`） | 场景 3 的事项才开始流进来 |
| 3 | （可选）`cross-line-blocker` + `ops` | 场景 2，已在跑 |

```bash
# 1) 授 external-comms 到 draft
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' -H 'cookie: <owner cookie>' \
  -d '{"scope":"cell","mandate":{"version":2,"domains":{"ops":{"mode":"draft"},"external-comms":{"mode":"draft","limits":{"count":3}}}}}'

# 2) 开供应商来源
curl -s -X PUT "http://<cell>/api/fleets/delegation-policy" \
  -H 'content-type: application/json' -H 'cookie: <owner cookie>' \
  -d '{"scope":"cell","domainMap":[{"source":"supplier-thread","enabled":true}]}'
```

注意：`mandate` 是**整块覆盖**（`setCellMandatePolicy` 写整个对象），
所以第 1 步要把 `ops` 一起带上，否则会把现有的 `ops=draft` 写没。

### 为什么先 draft 而不是更高档

`draft` 只产出草稿，**不发送**。所以判断它答得对不对，不需要任何发送权限，
也不会对外说错话——这是验证「它能不能替你答人」唯一零风险的档位。
按 `NON_DOWNGRADABLE` 与层级样本闸，`act-notify` 要等层级样本达标，服务端会拦，不用记。

---

## 九、生产使用状态：除「字段传对了」之外，没有一条业务路径被真实使用过

2026-11-10 实测（cell `1da519d4c1c0bf89`）：

| 检查 | 结果 |
| --- | --- |
| `action_audit` 新四列 | `mandate_domain, disclose_level, principal, audience` —— **迁移在位** |
| 台账总行数 | **3** |
| 带 `mandate_domain` | **0** |
| 带 `disclose_level` | **0** |
| 带 `audience` | **0** |
| 有 mandate 的 cell（全 15 个） | **1**，且只有 `ops(legacy): draft` |
| `external-comms` / `advancement` / `research` | **0 / 0 / 0** |
| 审计官岗位 | **0** |

汇总成一张使用状态表：

| 组件 | 生产使用次数 |
| --- | --- |
| 委托状 v2 的三个人事域 | **0** |
| 披露闸（越界拦截 / 台账 / 撤回） | **0** |
| 审计官 | **0**（未设立） |
| 就绪检查 | 可跑（doctor 真机验证过，但只被我自己调用过） |
| `category` / `source` 字段 | **已生效**（上产后 6/6 带 category） |
| deputy | **已开，但几乎无物可裁**（1/6 落在 `route=deputy`） |

### 这不是缺陷，是「默认值即上界」的正确表现

设计上未配置的域一律只给建议、未开启的来源一律不进事项。所以「零使用」正是
默认状态的**正确**表现。但它同时说明：

> 本会话反复测的「失败率 / 撞墙 / category 非空率」，测的全是**管道通不通**，
> 没有一条测到**业务价值**——因为业务价值要有人真的把开关打开。

### 第一个开关的三条候选（都备好了，选一条）

| 目的 | 动作 | 第一个可观察结果 |
| --- | --- | --- |
| 验场景 3（对外起草） | `external-comms: draft` + `supplier-thread` | 供应商类事项进域，代理出草稿，**不发** |
| 验场景 2（内部拍板） | `cross-line-blocker` | 跨线阻塞进 `ops`，deputy 每 20 分钟可见 |
| 只看管道 | 只开 `supplier-thread` | 来源开启但域未授权 → doctor 明确报「来源开了但域没授权」 |

命令见 §八 / §十。**我不执行**：改的是主人的授权边界，且我的身份调该端点必然 401。

### 验收时请注意

「零使用」是验收的一部分，不是可忽略的空白。开完第一个开关后，应当能看到
**至少一条** `action_audit` 行的 `mandate_domain` 非空——那是「这套东西第一次真的
替你在某个域上做了事」的唯一硬证据。

---

## 十、场景 3 的硬阻塞：`MANDATE_VERDICT_TOKEN` 没注入（我的上产疏漏）

查完整前提链（cell `1da519d4c1c0bf89`）：

| 前提 | 状态 |
| --- | --- |
| 对外通道 | ✅ 5 个 bot、2 个 channel、23,830 条消息、83 条中继日志 |
| `BOTS_ALLOW_TOOLS` / `BOTS_RELAY_TOKEN` / `CHATWOOT_BASE_URL` | ✅ 都在 |
| **`MANDATE_VERDICT_TOKEN`** | ❌ **未注入** |

披露闸的设计是**失败关闭**（`docs/upgrade-personal-agent-2026-11-09.md` §四 我自己写的）：

> `MANDATE_VERDICT_TOKEN` 未配置时，对外裁决端点返回 503，runner 侧**不发任何文本**
> （失败关闭），不是放行。上线前必须注入。

**后果：即使把 `external-comms` 授到 draft、把 `supplier-thread` 打开，
对外那条链仍然一个字节都发不出去。**

### 这是我的上产疏漏

「注入 token」写进了**升级说明**，但**没进上产检查单**。于是：代码上线、表列迁移、
端点在、doctor 能跑——**唯独这条链在生产上结构性不可用**，而且失败形态最坏：不报错，只是不发。

这是本会话那个反复出现的形态的又一例：**「上产 ≠ 可用」**。
镜像里有代码，但缺一个 env，整条路静默失败。

### 补齐的上产检查单（以后照这个走）

| # | 检查项 | 判据 |
| --- | --- | --- |
| 1 | 镜像内有新代码 | `git merge-base --is-ancestor <合并> <BUILD-INFO.baseCommit>` + pod 内 grep 符号 |
| 2 | 迁移已跑 | 启动日志 `[db] applied migration vN`；目标 cell 的 head 到位 |
| 3 | 新端点已挂 | 未鉴权返回 **401 而非 404** |
| 4 | **新代码需要的 env 全部注入** | **逐个列名核对**（本次就漏了 `MANDATE_VERDICT_TOKEN`） |
| 5 | 需要开关的能力已打开 | doctor / readiness 的 blocked 项清零 |
| 6 | **至少一条真实业务行** | `action_audit.mandate_domain` 非空 ≥ 1 |

第 4 与第 6 是本会话的教训：**「有代码」和「能跑」「真的跑过」是三件不同的事。**

### 你需要做的两件事（顺序不能反）

```bash
# 1) 生成并注入（platform 容器与 runner 侧必须是同一个值）
export MANDATE_VERDICT_TOKEN="$(openssl rand -hex 24)"
# 写进 fd-infra-deploy 的 platform.yaml env，或 platform-secrets
# 注意：envFrom 不热载 —— 改完必须 delete pod（不是 rollout restart）

# 2) 再授 external-comms 到 draft、开 supplier-thread（命令见 §八）
```

顺序不能反：先授域再注入，中间那窗口代理会尝试起草但发不出去——虽然也是失败关闭
（安全），但日志会看起来像故障。
