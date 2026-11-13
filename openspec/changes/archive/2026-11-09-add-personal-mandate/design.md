## Context

见 `proposal.md` — Why。影响设计的三条现状约束：

1. **`action-gate` 已存在并且做对了半件事**：动作注册表（`lib/action-registry.js`）声明风险等级，`lib/action-preflight.js:186` 的 `preflightAction(action, ctx, args)` 是提议进入确认档位前的唯一前置钩子，`lib/action-executor.js:269` 的 `executeRegisteredAction` 是单一执行路径。所以委托状不是第二套闸。
2. **委托策略已经是两层作用域**：`cell_settings['delegationPolicy']` + `fleets.delegation_policy`，归一化在 `server/routes/fleets-db.js:1913-1966`，强制校验在 `server/routes/fleets.js:2110-2160`。委托状沿用同一存储与同一种「服务端逐项校验」形态，不新建策略表。
3. **既有审计台账与错误语义是合同**：`action-gate` 的「单一执行路径与审计台账」、deputy 的 403/429 文案与语义都已有 spec 钉住，本 change 只能加维度，不能改它们的判定顺序。

## Goals / Non-Goals

**Goals:**

- 一个可测试的纯函数式求解点：给定（主体，域，动作，参数），确定「该不该做、以什么档位做、能说多少」，且这个结果可解释（命中哪条配置、被哪条硬约束拦下）。
- 授权维度的扩展**不引入任何新的默认权限**：升级即等价。
- 披露校验拦在**已有**的出站执行路径上，不新增旁路。

**Non-Goals:**

- 不做个人事务域的数据接入与判例检索（`widen-deputy-to-personal-domains`）。
- 不做对外身份口径切换与溯源回执（`add-principal-disclosure-gate`；本 change 只立 `disclose_level` 字段与校验骨架）。
- 不给**副驾**（copilot）任何委托状——副驾的工具面仍只含读 + `propose_action`，委托状只对代理生效。这条是防止把提权路径开给可见工具面最多的角色。
- 不做可视化的权限模拟器（设置面只做配置与清单）。

## Decisions

### D1 · 委托状是 `action-gate` 之上的一层策略，不是并行闸

- **采纳**：`lib/personal-mandate.js` 提供一个纯求解函数 `resolveMandate({ policy, domain, action, args, usage })`，返回 `{ decision: 'deny'|'advise'|'draft'|'execute', tier, disclose, reasons[], mandateRef }`。`preflightAction` 在既有前置检查之后调用它；`executeRegisteredAction` 只消费它的结论，不自己判断。
- **否决 (a) 直接在 `action-registry` 里按域写死**：动作 × 域的笛卡尔积会写进注册表，注册表变成策略表，两个变更节奏被绑死。
- **否决 (b) 独立 mandate 服务进程**：多一个进程边界和一次网络往返，而它必须与执行在同一事务视图里（额度消耗要跟执行一致）。
- **理由**：单一求解点让「授权」可被单测穷举，也让 `fleets.js` 的 deputy 路径和动作路径复用同一结论——否则会出现「拍板能自主、说话却不能」的口径分裂。

### D2 · 四档模式的映射表写死在代码里，不由配置推导

`advise → 不产生动作`（propose 阶段即拦）、`draft → 进入待放行队列`、`act-notify → 直接执行 + 通报`、`act-silent → 直接执行 + 日报`。

- **理由**：不要用「模式名的语义」去推导档位（例如把 `act-notify` 理解成「确认后执行」），映射写死才能被测试钉住，也才能在设置面上如实展示。
- **代价**：新增一档要改代码。可接受——档位是产品语义，不该由数据驱动。

### D3 · 不可降级动作集硬编码在风险常量旁，设置面从同一常量生成选项

`lib/action-registry.js` 里与 `RISK` 相邻导出 `NON_DOWNGRADABLE = ['destructive','publish']`。设置面的可选模式由它派生，服务端校验也读它。

- **否决**：把不可降级集合放数据库（哪怕带审计）。一行 UPDATE 就能放开破坏性动作，而这条约束的价值恰恰是「不能靠改数据绕过」。
- **代价**：要改这个集合必须发版。这是刻意的。

### D4 · 披露校验做成 `preflightAction` 的扩展步骤，并要求注册表声明 `contentArgs`

- 发送/发布类动作的注册条目 SHALL 声明 `contentArgs: ['message','subject',...]`（哪些参数是「要说出去的话」）。`preflightAction` 用这些参数取**原文**做披露校验，不是取摘要。
- **fail-closed**：`publish` / `write` 类且影响面为「对外」的条目，若未声明 `contentArgs`，注册表加载即失败——否则闸看不见内容，等于静默放行。
- **否决**：在 MCP 工具层拦。任何绕过执行路径的调用都会失效，而 `action-gate` 的价值前提就是「单一执行路径」。
- **否决**：用模型生成的摘要做校验。摘要会丢信息，而泄露恰恰发生在被丢掉的细节里；摘要只入账，不用于判定。

### D5 · `read_scope` 的落点不在动作路径，在记忆读面

`read_scope` 校验的是「读」这个动作，但它的消费者是记忆/语料读面（`memory_*` 工具与语料加载），不是 `action-gate`。两个消费者共调同一个 `resolveMandate` 的 scope 部分，保证「能读」与「能做」的域口径一致。

- **理由**：把读也塞进动作注册表，会让每个读工具都变成受闸动作，确认档位语义（二次确认读操作）荒谬。

### D6 · 台账复用既有审计表加列，不新建表

新增列：`mandate_ref, domain, mode, disclose_level, reversible_until, content_digest, revoked_at`。

- **否决**：新建 `mandate_ledger` 表。两本账一定会对不上（一次执行两条记录、时序不一致），而审计的价值在于单一事实源。
- **对外发言的内容**：只存摘要 + 目标，不存全文。存全文会把「代理替你说过的话」变成第二个敏感数据面。

### D7 · 额度用量从台账派生，不设计数器表

与 deputy 的 `dailyBudget` 同构（`fleets.js:2150-2156` 从 `decision_items` 现算）。

- **代价**：每次求解一次聚合查询。缓解：`(domain, mode, executed_at)` 索引 + 日界缓存（进程内按日失效）。
- **理由**：计数器表在崩溃/重试时会漂移，而漂移方向通常是「多给额度」。

### D8 · 不可撤销的动作 MUST NOT 被配置为自动执行

若某动作无法给出反向操作（撤回消息、取消承诺），则其 `reversible_until` 恒为 null，且 `resolveMandate` SHALL 拒绝把该动作配置为 `act-notify` / `act-silent`，回落 `draft`。

- **理由**：撤销窗口不是贴心功能，是「先做后报」可信的前提。一条撤不回的动作被自动执行，事后通报只是通知事故。

### D9 · 迁移惰性、写入即新结构，等价性用对照测试钉

- 读取：`normalizeDelegationPolicy` 识别扁平旧结构 → 视为 `domains:[{domain:'ops', ...}]`；识别多域结构 → 原样。
- 写入：一律多域结构，带 `version: 2`。
- 回滚：`version` 字段被旧代码忽略；回滚时若需要，把 `ops` 域字段摊回扁平结构（一次性脚本，非必需路径）。
- **等价性证明**：同一组 `(item, policy)` 输入分别跑旧归一化 + 旧闸、新归一化 + 新求解器，输出必须逐字段相等。这组对照测试是本 change 的验收硬门。

### D10 · 域枚举是封闭集合，未知域拒绝

v1 域：`ops`（舰队内部运营）、`external-comms`（对外沟通）、`advancement`（事项推进）、`research`（研究产出）。未声明的域按 `advise` 处理——但**显式写入未知域名** SHALL 被拒绝，避免「以为配了、实际拼错、静默按 advise」。

### D11 · 撤销走同一执行路径的反向工具，不直连下游

撤销 = 一次受闸动作（`mandate.action.revoke` 类），复用凭据解析、审计与幂等。窗口过后拒绝，不做「尽力而为」。

## Risks / Trade-offs

- **[授权面扩展 = 默认放大]** → 未配置域 `advise` + 升级等价对照测试 + 设置面不预勾选任何域。三者缺一都等于一次性放开权限。
- **[披露闸漏拦]** → 注册表 `contentArgs` 完整性 fail-closed；校验原文不校验摘要；对外类条目上线前逐条核对（任务里单列一条）。
- **[披露闸误拦导致代理不可用]** → 越界返回结构化越界项，代理可改写重试；连续越界计数进日报，避免「无声地一直失败」。
- **[额度派生查询变慢]** → 索引 + 日界缓存；若仍慢，降级为「每次最多扫当日」。
- **[副驾被意外提权]** → 委托状解析要求「主体是代理」；副驾路径不读委托状，且测试钉死「副驾的 write 动作恒走原档位」。
- **[两本账]** → 同表加列，不新建表（D6）。
- **[模式与确认卡的用户困惑]** → 通报里必须写明「本次是按某域某模式自动执行」，而不是让用户以为是自己点过。

## Migration Plan

1. 加列 + 结构升级（向后兼容读），无行为变化上线（等价测试必须绿）。
2. 上线求解器与披露闸骨架，但**所有域默认 `advise`**，即：除 `ops` 域依既有委派语义外，无任何自动化。
3. 设置面开放四域配置（初始全 `advise`），由主人逐个开启。
4. 回滚：`version:2` 结构对旧代码等价于「无多域配置」；旧代码读扁平 `ops` 字段仍工作（写入方在迁移期双写 `ops` 扁平字段一个版本周期，随后移除）。

## Open Questions

- 撤销窗口的默认值：先按「对外发送 10 分钟、内部动作 30 分钟」给保守默认，实际值由主人在设置面调。
- `disclose_level` 的初始枚举集合：先用「公开 / 内部 / 机密 / 人事 / 财务」五档，等 Lane B 的披露需求落地后再收敛。
- 域是否需要允许用户自定义：v1 封闭（D10），若个人事务域的实际切分与四域不合，在 `widen-deputy-to-personal-domains` 里再评估。
