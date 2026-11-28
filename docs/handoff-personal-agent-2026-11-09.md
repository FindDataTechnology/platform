# Handoff · 个人代理（代表人决策与作答）· 2026-11-09

> 给下一个会话：这份文件只写**现状 + 下一步 + 陷阱**。设计理由在各 change 的
> design.md 里，不要在这里重述。

## 一句话现状

「个人超级代理」拆成三层，前两层已归档可用，第三层（对外）本仓代码齐了但**卡在真机验收**。

| # | change | 状态 | 交付 |
|---|---|---|---|
| 1 | `add-personal-mandate` | ✅ 已归档 | 授权：域 × 模式 × 动作/知情范围，服务端强制 |
| 2 | `widen-deputy-to-personal-domains` | ✅ 已归档 | 判断：事项接入 + 判例四级 + 审计官 |
| 3 | `add-principal-disclosure-gate` | **27/29，未归档** | 出站：披露闸 + 台账 + 回执 + 撤回 |

主仓 spec：新增 `agent-personal-mandate`(10)、`agent-personal-deputy`(7)；修改 `action-gate`、`agent-fleet-decision-delegate`、`agent-fleet-core`、`principal-facade`、`agent-fleet-decision-lane`、`auth`。

## 分支与提交

分支 `release/cell-session-persona`。本次 8 个提交，最后一个 `3cd2fc341`。
**未 push。**

工作树里这些**不是**本次工作的，勿带：
`docs/queue-backlog-runbook.md`、`server/fleet-reports.js`、`analysis-satellite-sharing-fix.md`、`graphify-out/`、`scripts/test-report-flood-round-exempt.mjs`。

## 代码坐标（按需查阅，别全读）

```
lib/personal-mandate.js       三维求解器（零依赖叶子）：模式/额度/两个 scope/放量闸
lib/personal-domain-map.js    事件源→域映射（默认全关）
lib/precedent-grade.js        判例四级 + 一致率 + 升档闸
lib/precedent-candidate.js    更正→候选规则（永不直接生效）
lib/auditor-tool-face.js      审计官白名单 + 三态
lib/outbound-message.js       对外唯一门（判定不发送）+ 双形态渲染 + 旁路记录
server/routes/actions.js      裁决端点 mandate-verdict / 台账 / 回执 / 撤回
server/bots.js                replyRaw 与 sendTo 都过 gateAndSend
agent-runner/manager.js       turn() 出口闸（仅 mandateDomain 车道）
agent-runner/a2a.js           对外车道禁用流式（-32013）
server/routes/fleets-db.js    决策四列 + 判例候选表 + 域映射 + 越界计数
```

## 下一步只有一件：真机验收

照 `docs/disclosure-gate-verification.md` 跑 6.5 / 6.6。**重点是反证步骤**
（去掉 `mandateDomain` 应恢复正常）——「拦住了」和「链路坏了」在日志里一样。

跑通后：`openspec archive add-principal-disclosure-gate --yes`。

## 交付面（星妍教程）

已发布：`/zh/research/academy/yizuo-mandate-disclosure/` 与
`/research/academy/yizuo-mandate-disclosure/`（**不是** `/academy/<slug>`，也没有
短前缀；结尾斜杠必需）。真浏览器复核：中英各 6 图全部加载。

## 已顺带修掉的既有缺陷

`deserializeDecision` 的 `recommendation` 读的是 `row.resolution`——推荐值写进列却
从不读回。实测：未决恒 `null`（UI 的「推荐」那行从来没显示过）、已决把 resolution 的
JSON 当推荐值。**一致率算的正是这个字段**，所以修之前它结构性失真。已修 + 回归测试。

## 审计官（第五种岗位承载）的六条规矩

审计官不是「又一个 persona」。这六条都是踩出来的，逐条改坏了都会**静默降级**：

1. **persona 承载**：解析、归因、模型声明、车道标记一律问 `isPersonaBackedTargetKind(kind)`
   （`server/routes/fleets-db.js`），不要写 `=== "persona"`。
2. **不进工作图**：handoff/dispatch/fanout 的两端、event 目标、fanout 裁判一律不收，
   `code=auditor_orchestratable`（`server/fleet-orchestration.js`）。理由：它复核判断，
   编导边搬活；进了边就在审自己参与的活。
3. **可以有自己的模型**：它必须能与专家用不同模型，否则同向走偏。create / restaff /
   架构师草案三条写面都已放行。
4. **需要委托状**：未配置任何「授予了东西」（mode ≥ draft）的域时，不允许建审计官。
5. **归因必须通**：它的主要产出是「阻断并上报」，归因链不认它等于它说不了话。
6. **不进流式**：对外车道本就不提供 `message/stream`（见披露闸）。

**棘轮**：`scripts/test-kind-dispatch-ratchet.mjs` 扫描全部 `=== "persona"` 分流点。
新增一处必须二选一——用 `isPersonaBackedTargetKind`，或写 `persona-only: <理由>`。
两者都不做测试即红。这不是风格洁癖：这个类型漏了六轮，每一轮都没有报错。

## 就绪检查（五个面，一个判定）

`lib/personal-agent-readiness.js` 是唯一真源，五个消费面：`GET /api/fleets/personal-agent/readiness`
（明细）、坞面行 `personalAgent`（摘要）、设置→事项接入（显示 + 修法）、日报摘要
（「配置体检: 还不能用」）、`scripts/personal-agent-doctor.mjs`（CLI，退出码 0/1）。

两类结论刻意分开：`blocked`（这状态下它不会做任何有价值的事，或做了不安全）与
`warn`（能跑但你大概不是这个意思，例如判例为零＝盲判）。每条都带 `fix`。

## 生产实测数字（2026-11-10 01:5x，fd-prod，只读）

在 `fd-prod` 的 platform pod 里遍历全部 `fleets.db`（只读打开）：

| 指标 | 数值 |
| --- | --- |
| cell 库总数 | 16 |
| **有委托策略的 cell** | **0** |
| **enabled 的 cell** | **0** |
| **有审计官岗位的 cell** | **0** |

拍板记录分布（三个有数据的 cell）：

| cell | 总数 | 已裁决 | delivered | expired | open |
| --- | --- | --- | --- | --- | --- |
| `1da519d4c1c0bf89` | 248 | **4** | 11 | **192** | 44 |
| `3fdc7b8e8ac03b68` | 50 | 0 | 4 | **37** | 9 |
| `6db2b1b4b490223b` | 7 | 0 | 4 | 2 | 1 |

**结论一：这套东西在生产上完全没被配置过。** 委托状、事项接入、审计官全为零。
就绪检查对每个 cell 都会如实报「还不能用」——那是对的，不是误报。

**结论二：拍板队列是「堆到过期」而不是「裁决掉」。** 248 条里 244 条
`resolved_by` 为 NULL、192 条 expired（77%）。没人消化队列——这恰好是 deputy
要解决的问题，但它没被启用。

**结论三：阈值无从校准。** 一致率与层级样本都需要真实裁决，而真实裁决只有 4 条
（且都在一个 cell 里）。**任何 80% / 20 的默认值都只是占位，不是经验值。**

**结论四：判例缩水的实际影响接近零。** 存量 244 条 NULL 会被回填为
`deputy-ruled`（不可引用），但其中本来就没有主人裁决可失去——该 cell 只有 2 条
owner 裁决。之前担心「缩水」，实测是不存在的。

> 观测期间 platform deployment 连续滚了三次（`655f4d88d9` → `69ff94b8cc` →
> `67df7fdbfc`，每次 readiness 9310 首次拒连）。是并发会话在发版，不是本仓改动
> 引起；读数据时按 pod 名重试即可。

## 三件仍悬着（需人决定，不要替人决定）

1. **判例缩水**：升级后存量 `decision_items` 全部记为 `deputy-ruled`（不可引用）。
   可用判例会明显变少。这是有意的保守方向，但**必须写进发布说明**，否则像退化。
2. **`deserializeDecision` 的 `recommendation` 缺陷**：读的是 `row.resolution` 而不是
   `row.recommendation`（列写了不读回）。全链路已绕过它，未修。修它会让 UI 开始显示
   以前看不见的推荐，属用户可感知变化。
3. **`read_scope` 管不到记忆服务** —— 已查清：不是漏接线，是两边判的不是同一件事。
   委托状判「敏感层级」，`fd-memory` 判「命名空间 r/rw 授权」，页面上的 layer(L0/L1/L2)
   是从行类型推的、不是敏感度。后果：代理对某命名空间持 `r` 就能读该空间全部页面。
   处置与真正打通的条件写在 `docs/upgrade-personal-agent-2026-11-09.md` §四之二。

## 既有红：`test-connector-credentials` 3 条（已定性，不是本次引入）

`scripts/test-connector-credentials.mjs` 在基线提交 `db94bca18` 上同样是
**23 pass / 3 fail**，失败项相同：

- `2.3 registry and connector inject independently in one patch write`
- `2.5b a 401 on a connector binding row marks only that binding`
- `3.2 the connector injects as the built-in binding row, not a global row`

判定方法：`git worktree add /tmp/base db94bca18 --detach` + 软链 node_modules，
在基线树上跑同一条。**别把它当成本次改动的回归。**

## 场景验收（十个，跑真实路由与真实 DB）

`node scripts/verify-agent-scenarios.mjs` —— 一次启动，按主人会怎么用的顺序走：
授权收放 / 事项接入 / 判例准入 / 审计官准入 / 审计官不进工作图 / 披露闸 /
台账回执 / 撤回 / 放量闸 / 就绪三面。**10/10**。

写它时踩到一个语义混淆，值得记：`ops` 域**永远存在**（承载 legacy 委托默认值，
默认 `advise`），另外三域才是「未配置即不存在」。断言必须分开，
否则「你把它收回了」和「你从没配过」在界面上分不出来。

## 八个坑（本次都踩过，别再踩）

1. **两套库**：`decision_items` 归 `fleets-db.js` 建；`action_audit` 归 `db.js` 的
   migration。写错库的表现分别是「库直接 disabled」与「端点 500、分区不渲染」。
2. **`ops` 域永远存在**（承载 legacy 委托默认值），所以「domains 非空」不等于
   「配置过」。判「是否真的授权」要看 mode ≥ draft。
3. **类别禁令藏在归一化里**：只改 `routeForItem` 没用，`normalizeRoutes` 已把
   `hr/spend/config-change` 硬写成 owner。
4. **cell 是替换语义、fleet 是合并语义**：把烘焙了默认值的合并视图写回存储，会让
   缺省键被 DEFAULT 复活。
5. **流式与披露闸不兼容**：delta 边生成边发，出口闸来不及。对外车道已禁用流式。
6. **「没值」≠「没发生」**：三次踩同一形态（摘要只收裁决 / disclose_level 只记越界 /
   越界计数必须有域）。改这类判定时先问「这个字段为空代表什么」。

7. **加一个新类型要数「消费者」，不是数「校验」**：审计官那次，校验层（枚举/编导映射）
   第一时间就会红，而导出、实例化落地、解析、模型、归因、编导边六处全是**静默做成
   了别的东西**。校验全绿 ≠ 语义落地正确。
8. **兜底分支比漏判更危险**：`resolveTarget` 曾把任何未知类型当 a2a 解析，于是「下一个
   新类型」注定重演。兜底必须收窄（只归它认识的那一种），未知就判 dead。

## 部署拓扑实测（2026-11-10 03:xx，只读）

上一版说「生产基线查不清」，现在查清了，三条结论都有判据：

| 问题 | 结论 | 判据 |
| --- | --- | --- |
| 生产镜像是哪个提交 | `ccr.ccs.tencentyun.com/law-bench/platform:sha-2040330` = 提交 `204033005` | 该 sha 是 `gitee/release/cell-session-persona` 的**当前 tip**，逐字相等 |
| 生产是否落后 release 线 | **不落后**，生产就钉在 release tip 上 | `git merge-base --is-ancestor 204033005 gitee/...` 为真，且 tip 就是它 |
| `BUILD-INFO.json` 为什么是 `unknown` | **设计如此**，不是漏配 | 见下 |

`BUILD-INFO.json` 的三个 `unknown` 来自 `Dockerfile`：

```dockerfile
# 真出处只有一种：从 scripts/make-public-snapshot.mjs 写出的公开快照树构建。
# 从别处（私有仓、功能分支）构建根本没有这个文件，而运行阶段的 COPY 是显式
# allowlist，缺文件会直接失败。所以构建器保证它存在：有出处写真的，没出处写
# 诚实的 "unknown" —— 绝不编一个 sha。
RUN [ -f BUILD-INFO.json ] || printf '%s\n' \
      '{"baseRef":"unknown","baseCommit":"unknown","builtAt":null}' > BUILD-INFO.json
```

也就是说：**这次生产镜像不是从公开快照线出的**，所以镜像里永远查不到基线——
想追基线只能看 registry tag 与 git，别指望镜像自证。

### 本地分支与 release 线的关系（别按提交信息认领）

```
merge-base 90dfdb38d
本地独有 81 条 / gitee 独有 108 条
```

两个坑：

1. **同题不同 sha**。多个「我的」提交在 gitee 上有同题同样的另一份
   （`be6c0318b`↔`66a41172d`、`a70ee53b5`↔`009416bda`、`71d1fda70`↔`febe5ce27`、
   `9236bf9fd`↔`b0acd9e0c`）。所以**按提交信息认领会重复计数**，只能按内容判。
2. **内容判据才是准的**。实测 gitee tip 上有 `lib/personal-mandate.js` 但**没有**
   `agentMayHandle`；`lib/auditor-tool-face.js`、`lib/personal-agent-readiness.js`
   整个不存在。结论：gitee 只吃了第一批（委托状 v1），**第二批（个人事务域/判例/审计官）
   与第三批（披露闸）从未上过 release 线**。

本地 81 条里还混着别的会话的未推工作（`feat(supply): 谦面交互收口`、看板页签、
池亲和等），所以「把我的提交挑出来单推」不可行——会连带发布别人的东西。

**当前处置**：整条本地线推到 gitee 的备分支
`backup/cell-session-persona-local-2026-11-10`（tip `bda3fa3db`，与本机 HEAD 逐字一致）。
不碰 release 线、不触发镜像（`image-publish.yml` 只认 `main`）。

要真正上产，得在隔离 worktree 里把本地线并到 release tip 上——这会一并发布别人的
约 50 条提交，**需要那些人点头，不是我能替他们定的**。

## 验证命令

```bash
cd paas
node --test lib/*.test.js                      # 108
node --test scripts/test-personal-*.mjs scripts/test-outbound-*.mjs \
            scripts/test-fleet-delegation.mjs scripts/test-bots.mjs \
            scripts/test-auth-trust-boundary.mjs agent-runner/test/*.mjs   # ~150
node --test scripts/test-kind-dispatch-ratchet.mjs   # 岗位类型分流棘轮（改 kind 相关必跑）
npx playwright test e2e/settings-mandate.spec.js e2e/settings-mandate-intake.spec.js \
  e2e/settings-disclosure-levels.spec.js --project=fast    # 5（需先 web:build:e2e）
```

## 探索底稿

`docs/personal-agent-mandate-explore.md` —— 最初的命题拆解、幕僚团拓扑、两条流水线的
排期理由。**注意**：其中「新造 Mandate 对象」的初稿结论已被推翻（正确底座是 `action-gate`），
文内 §四.3 已更正。
