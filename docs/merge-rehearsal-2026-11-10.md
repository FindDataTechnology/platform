# 并线预演 · 本地线 → `release/cell-session-persona`

> 2026-11-10。方法是 `git merge-tree --write-tree --name-only`：**不写盘、不建
> worktree、不推送**，只在内存里算一遍合并。所以这份文档是预演结果，不是操作记录。
>
> 结论先行：**这不是一次「个人代理」的合并，而是六条工作线一起并入 release。**
> 27 个冲突里只有 8 个属于个人代理；13 个属于队列/cron/worker/profile/凭据那几条线，
> 得由它们的人来解。

## 一、拓扑（先记住这三个数）

| 项 | 值 |
| --- | --- |
| merge-base | `90dfdb38d` |
| 本地独有 / gitee 独有 | 85 / 108 |
| 冲突路径 | **27** |
| 生产镜像 | `sha-2040330` = `204033005` = **gitee 当前 tip** |

生产不落后 release 线。所以「上产」= 把本地这 85 条并进去再出片，不是补一个落后的洞。

## 二、27 个冲突的归属

判定方法：对每个冲突文件，数 merge-base→本地 与 merge-base→gitee 各自的增删，
再看 `git log` 里动过它的提交主题落在哪条线。不是凭文件名猜。

| 归属 | 数量 | 文件 |
| --- | --- | --- |
| **个人代理（我解）** | 8 | `lib/personal-mandate.js`、`openspec/specs/agent-personal-mandate/spec.md`、`packages/core/src/lib/surfaces.ts`、`server/routes/actions.js`、`server/routes/fleets-db.js`、`server/routes/fleets.js`、`web/src/components/settings/sections.ts`、`db.js` |
| **别的线（他们解）** | 13 | `credential-refs.js`、`cron.js`、`server/cron-runner.js`、`server/worker-slots.js`、`task-engine.js`、`dsh-profile.js`、`docs/multi-agent-collaboration-explore.md`、`scripts/missed-recalibrate.mjs`、`scripts/test-cron-session-rotation.mjs`、`scripts/test-dual-credential.mjs`、`scripts/test-history-kinds.mjs`、`scripts/test-worker-pool.mjs`、`openspec/changes/archive/2026-11-10-add-fleet-early-stop/…/cron-module/spec.md` |
| **两边都在加键（一起合）** | 6 | `web/src/locales/{zh-CN,en,es,fr,ja}/common.json`、`.env.example` |

那 13 个之所以冲突，不是因为我和他们抢，而是**同一份工作在两条线上各提交了一次**
（同题不同 sha：`be6c0318b`↔`66a41172d`、`a70ee53b5`↔`009416bda`、
`71d1fda70`↔`febe5ce27`、`9236bf9fd`↔`b0acd9e0c`）。

## 三、我这 8 个怎么解（每条都有实测判据）

### 3.1 三个 add/add：gitee 是纯子集，取本地即可

| 文件 | gitee 有而本地没有的行 |
| --- | --- |
| `lib/personal-mandate.js` | **0** |
| `openspec/specs/agent-personal-mandate/spec.md` | **0** |
| `packages/core/src/lib/surfaces.ts` | **0** |

gitee 上那份就是委托状 v1（重放成 `511c89d3b`），本地是 v2/v3 的超集。**取本地，零丢失。**

### 3.2 三个内容冲突：gitee 侧「独有行」是我自己 v1 被 v2/v3 重构掉的旧代码

这一条最容易误判——`diff` 出来的 `gitee 独有` 看着像别人的东西，其实是我自己的旧版本：

| 文件 | gitee 独有 | 实际是什么 |
| --- | --- | --- |
| `server/routes/fleets.js` | 21 行 | `if (m.targetKind === "persona")` 等旧分流判断，已被 `isPersonaBackedTargetKind` 取代 |
| `server/routes/fleets-db.js` | 15 行 | 旧 `MEMBER_TARGET_KINDS`（不含 auditor）、旧 INSERT（无 `source`）、旧 `PLAIN_COLS`（无 `route`） |
| `server/routes/actions.js` | 5 行 | 台账查询的旧版；本地已扩到 `mandate_domain`×10（gitee 6）、并加了 `audience`/`principal`/`disclose_level` |

**取本地，零丢失。** 但必须复核一条：本地 `actions.js` 的撤销窗口与
`reversibleOnly` 语义仍在（`grep` 实测：`reversible_until`×8、`reversibleOnly`×3、`content_digest`×4）。

### 3.3 `db.js`：**不能整取本地** —— 两边各加各的

| 侧 | 加了什么 |
| --- | --- |
| 本地 | migration v116/v117 + `SCHEMA_HEAD` 导出（59 行） |
| gitee | `PERSONAL_TABLE_ALLOW` 个人数据导出读面（55 行，属 `add-personal-data-export`） |

`PERSONAL_TABLE_ALLOW` 在本地 `db.js` 里 **`grep` 为 0**——不是被谁删了，是本地落后
108 条，这个能力从没到过本地（该 spec 的引入提交 `27dc05faf` 只在 gitee）。
**这一处必须两边都留**，整取本地会静默丢掉隐私导出能力。

具体合法是确定的，但**方向与我一开始写的相反**（实跑后更正）。本地对 `db.js`
的增量是 `version: 117` + `SCHEMA_HEAD`（v116 与 gitee **逐字相同**，两边都有）。
所以正确做法是 **取本地版，再把 gitee 的隐私读面追加进去**：

```
取本地 db.js  →  末尾追加 gitee 的 PERSONAL_TABLE_ALLOW / listPersonalRows /
                 erasePersonalRows（51 行，属 add-personal-data-export）
```

反过来（取 gitee 再补本地）会试失败：本地的 v117 块上下文与 gitee 的数组末尾
对不上，`git apply` 直接 rejected。实测合法后 `SCHEMA_HEAD=117`，三个导出齐备。

### 3.4 语言包与 `.env.example`：取并集

gitee 独有的键来自别的功能（`deepGuide`、`officialAdoptedBadge`）以及被改写的
`mandate`/`noDowngrade` 文案；本地独有的键是这一批新增的（117 行/文件）。
**并集，不择一。**

## 四、别做的事

1. **不要「整取本地」**。会丢：个人数据导出（`db.js` 55 行 + 其 spec）、语言包里
   别的功能的键、以及那 13 个属于别人的文件。
2. **不要改走 cherry-pick 我的提交**。我的代码是照本地版本的 `fleets.js` /
   `fleets-db.js` 写的，而 gitee 在这两个文件上另有整型（`replayCallerCredential`、
   `partialTurns` 归因等）。逐条摘过去会得到一个「调着不存在的形状」的分支，
   而且这种错在测试里很难照出来。**合并（merge）保两侧，摘取（cherry-pick）只保一侧。**
3. **不要在没有那 13 个文件的主人的情况下解这 13 个冲突**。那是他们的判例。

## 五、如果要动手，顺序是这样

```bash
# 1) 隔离 worktree，以 release tip 为基线（不碰主工作区）
git worktree add /tmp/merge-rehearsal gitee/release/cell-session-persona --detach

# 2) 在 worktree 里合并本地线
cd /tmp/merge-rehearsal && git merge --no-ff <本地 HEAD>

# 3) 只解我这 8 个（按 §三 的规则），其余置为未解决、交回主人

# 4) 我这半边自证：把三套验收跑一遍
node scripts/verify-agent-scenarios.mjs      # 12
node scripts/verify-personal-agent-loop.mjs  # 10
node scripts/test-personal-auditor.mjs

# 5) 出片前：lint 闸 + 公开快照线（BUILD-INFO 才有真出处）
```

第 4 步是关键：这三条跑绿只证明**我的那半边**在合并后的树上成立；13 个别人的文件
没解完之前，整棵树不该出片。

## 六、实跑结果（2026-11-10 已执行）

预演已经真跑了一遍，不是纸上推演。

| 项 | 结果 |
| --- | --- |
| 基线 | `gitee/release/cell-session-persona` = **`2552d80fa`** |
| 合入 | 本地 `4040a2077` |
| 冲突 | 28（比预估多 `server/fleet-reports.js`，因基线在预演期间又前进 5 条） |
| 合并提交 | `cc64b13fc`，分支 `rehearsal/personal-agent-on-release-2026-11-10`（**本地，未推**） |
| `verify-agent-scenarios` | **12/12** |
| `verify-personal-agent-loop` | **10/10** |
| `test-personal-auditor` | **8 项全过** |

三条验收在合并后的树上全绿，说明**我的代码对着 release 已改过的周边仍然成立**
（`replayCallerCredential`、`partialTurns` 归因等都在树上）。这是本次预演唯一
硬证据，也是「可以合并」的依据——但它只覆盖我那 9 个文件。

### 顺带查实的两件事

1. **release 线一直在动**。预演开始时 tip 是 `204033005`（= 生产镜像），做到一半
   变成 `2552d80fa`——另一个会话推了 5 条。所以「生产等于 release tip」是有时效
   的说法，判基线必须现查，不能引用旧结论。
2. **`v116` 两边完全相同**。gitee 的 `db.js` 已经有委托状列迁移（逐字相同），
   所以第一批不只是「内容上过线」，迁移也在线上跑过了。缺的只有 `v117`。

### 那 13 个处置：从「占位」升级为「有据代判」

一开始取 release 侧只是为了「让树能跑测试」。后来补了一条可复核的判据，把它从
占位变成**有据代判**：

**判据**：对每个冲突文件，抽出本地版本里所有顶层定义（`function X` / `const X =`
/ `export const X`），逐个看 release 侧**有没有这个名字**。

| 结果（2026-11-10 实测，基线 `2552d80fa`） | 值 |
| --- | --- |
| 13 个文件里本地定义总数 | 229 |
| release 侧**缺失**的 | **0** |

也就是说：本地在这 13 个文件里定义的每一个函数/常量，release 侧都有。本地那些
「独有行」不是未上线的功能，而是**同一功能在被重放后又被后续提交重构掉的旧写法**。
两个实例：

- `task-engine.js` 本地独有 51 行，看着像一大块新功能（`HISTORY_KIND` /
  `classifyHistoryEntry` / `summarizeHistory`）——release 把它**抽成了独立模块**
  `server/history-kinds.js`，逻辑在、位置不同。
- `server/cron-runner.js` 本地独有 42 行（早停、`contextPressureDetail`、
  `shouldSalvageReport`、`parkPersonaForTurn`）——release 全都有，且计数更高
  （`earlyStop` 12 vs 7），是同一功能的更新版。

所以这 13 个取 release 侧**无损**。仍要保留的提醒只有一条：这是**我代判的**，
判据是「符号集合包含」，不是「行为等价」——如果那几条线有**只改行为不改符号**的
修复，这条判据照不出来。所以合并前仍建议 owner 扫一眼 diff。

### 符号判据的盲区：实测抓到一个活例

上面那句提醒不是客套。代判之后跑了那几条线自己的测试，抓到一处「符号在、行为不在」：

| 测试 | release `2552d80fa` | 合并树 `cc64b13fc` | 判定 |
| --- | --- | --- | --- |
| `test-history-kinds` | 9 ✔ / 0 ✖ | 9 ✔ / 0 ✖ | 一致 |
| `test-cron-session-rotation` | 9 ✔ / 0 ✖ | 9 ✔ / 0 ✖ | 一致 |
| `test-cron-catchup` | 11 ✔ / 0 ✖ | 11 ✔ / 0 ✖ | 一致 |
| `test-cron-parity` | 10 ✔ / 0 ✖ | 10 ✔ / 0 ✖ | 一致 |
| `test-cron-missed-watermark` | 6 ✔ / 0 ✖ | 6 ✔ / 0 ✖ | 一致 |
| `test-cron-decisions` | 11 ✔ / 0 ✖ | 11 ✔ / 0 ✖ | 一致 |
| `test-dual-credential` | 7 ✔ / 0 ✖ | 7 ✔ / 0 ✖ | 一致 |
| `test-worker-pool` | 22 ✔ / 0 ✖ | 22 ✔ / 0 ✖ | 一致（首次跑出 3 条红是**假红**，连跑三次全绿） |
| **`test-cron-round-rotation`** | **2 ✔ / 3 ✖** | **2 ✔ / 3 ✖** | **两侧同红：release 线自身的缺口** |

那条真红说的是一件事：**「fleet 回合每轮换子会话 + settle 时回收」在 release 线上
整个不存在**——`freshSession` 没接、`dispose` 不触发、`sessionId` 拿不到。测试先到了、
实现没到。它与我这 9 个文件无关，是那条线自己的事。

**这条红是本次代判最大的收获**：它证明「符号集合包含」不足以保证行为等价，也证明
合并树没有把 release 的绿变成红（其余 8 条全一致）。

## 七、当前状态

- 本地整条线已推到备分支 `backup/cell-session-persona-local-2026-11-10`（tip `9b36bf4fc`），
  不碰 release 线、不触发镜像（`image-publish.yml` 只认 `main`）。
- 预演分支 `rehearsal/personal-agent-on-release-2026-11-10`（`cc64b13fc`）只在本地，
  worktree 在 `/tmp/merge-rehearsal`。**没有推送任何东西到 release 线。**
