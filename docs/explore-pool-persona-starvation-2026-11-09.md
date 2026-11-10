# 池的 persona 亲和 + 全池共享 cap：某个岗位可以被无关岗位无限期饿死

> 状态：**问题陈述，待裁决**（2026-11-09）。不是 change，没有 tasks——因为解法是调度政策选择，
> 需要先定"要不要让 persona 能突破 cap"，再谈实现。

## 一、实测（2026-11-09 22:50–23:25，产线 cell `3fdc7b8e8ac03b68`）

```
/readyz    ready=false  queued=4  degradedCells=["3fdc7b8e8ac03b68"]
           oldestQueuedMs  2,234,123 → 2,649,140 → 3,059,763   （37 → 44 → 51 分钟，持续增长）

日志       同一批 id 每 30–60 秒重复：
           job_1792885292645_v3q0yz / job_1792910487023_nbbier / task_1794234897853_ovd0h8
           其中 ovd0h8 从 22:52 起就在队列里

同期池     [worker-pool] spawned worker-5 for persona intel-patrol
           [worker-pool] spawned worker-6 for persona intel-chief
           [worker-pool] reaped  worker-2 (persona zx-chief, idle)
           → 池在正常起停 worker，不是"池坏了"
```

等待中的三条（同一时刻读 `jobs.json`）：

```
job_1792876490012_ygkf05   intel-poster   queuedBy=human    wait 57.4min  nextRun 次日 00:10Z
job_1792885292645_v3q0yz   zx-patrol      queuedBy=human    wait 57.4min  nextRun 当日 23:50Z
task_1794234897853_ovd0h8  law-chief      queuedBy=cadence  wait 56.5min  nextRun None（manual）
```

占着全池 cap=3 的三个 persona 是 `intel-patrol` / `intel-chief` / `user-preset-2`——与等待中的三个
**零重叠**。这是判定「撞在亲和+cap 上」而非「排序不公」的关键事实：它们的次序再往前挪也没用，
**没有可派的槽**。

### 观测一之后发生了什么（2026-11-09 23:35–23:43）

```
23:35:31  job_1792876490012_ygkf05  done success=true     ← 等到槽，跑完了
23:37:32  job_1792885292645_v3q0yz  done success=true     ← 等到槽，跑完了
23:38     pod 滚版（sha-27c7d1e → sha-0b19a2e）
23:40     /readyz ready=true queued=0；第三条 law-chief 在新 pod 上继续 running
```

**结论要小心读**：这次"好了"不是被修好的——镜像 `baseCommit = 108e694b`，经
`git merge-base --is-ancestor` 核对，其中**不含**任何队列/池修复。它好起来是因为
**等够了**（56 分钟后占用者终于腾出槽）。

### 观测二（反证）：换了占用组合就不堵

```
23:44  /readyz ready=true queued=0 degradedCells=[]
       在跑：law-chief（上一条还没跑完）+ zx-chief（新一轮）
       池：spawned worker-1 for persona zx-chief
       日志：8 分钟内零条 "off the chain"
```

同一批岗位、同一个 cell、同一个 cap=3，**只是占 cap 的组合换成了"1 条长回合 + 空余 2 槽"**，就完全
不堵了。这条反证的价值在于它排除了「这些任务本身有问题」：**是否堵车取决于当时占 cap 的是谁**，
与任务来源（human 点火 / 排期）无关。

### 由此可写死的成立条件

同时满足以下三条才会出现本例的极端等待：

1. cap 个槽位恰好被 **N 个与等待者不重叠**的 persona 占满（本例 N = cap = 3）；
2. 这些占用者都是**长回合**（本例 law-chief 单条就超过 8 分钟）；
3. 等待者是**别的 persona**，既不能复用占用者的 worker（亲和），也不能新开（cap 已满）。

`intel-*` / `zx-*` / `law-*` 是同一批常驻舰队岗位，因此这不是偶发：撞上哪个组合取决于当时谁在跑，
而撞上就必然等到长回合结束。


## 二、机制（读码，`server/worker-slots.js:341-355`）

```js
const placeable = (id) => {
  const persona = t.preset;
  ...
  // ① 空闲匹配：必须是同一个 persona
  if ([...workers].some((w) => !w.busy && w.persona === persona && ...)) return true;
  // ② 开新槽：cap 是全池共享的一个数
  if (workers.size + spawning < cap) return true;
  return human && !humanExtraOut;
};
```

两条规则叠起来产生一个洞：

- **worker 与 persona 绑定**（一个 worker 只服务一个岗位，因为不同岗位要不同的运行时 profile）
- **cap 是全池的总数**（`TASK_WORKER_MAX=3` = 整个 cell 最多 3 个 dsh 子进程）

于是当 cap 被两个**与它不相干**的 persona 占满时，第三、第四个 persona 的轮次**既不能复用**（①不匹配）**也不能新开**（②没余量）——只能等某个 worker 空闲回收。实测等待 51 分钟仍在涨。

对方在 `1c003d38b` 的提交说明里也点到了这一层：

> The rounds only move when a matching persona slot frees up, which for four intel-* rounds
> behind two unrelated personas can be **tens of minutes**.

## 三、为什么这不能靠"修 bug"解决

它不是判据错误，是**两个正确设计相遇后的容量事实**：

- persona 亲和是对的（跨岗位复用会串 profile/凭据）
- 全池 cap 是对的（每个 worker ≈ 一个 dsh 子进程 ≈ 137–200MB，7Gi 上限下只能开几个）

错的是"**它们之间没有任何公平性仲裁**"：先到的两个岗位吃掉全部容量，后到的岗位没有上限保护。

## 四、三个候选解法与代价

| 选项 | 做法 | 收益 | 代价 / 风险 |
|---|---|---|---|
| **A. 按 persona 分配 cap**（保底 + 争用上限） | 每个 persona 至少保底 1 个槽；总 cap 不变，但任一阵营不得占满 | 消除"被无关岗位饿死"；最贴近直觉的公平 | 需要"保底"意味着可能超出总 cap（3 个岗位各保底 1 = 至少 3），实际等于**隐性扩容量** |
| **B. 等待超阈值时破例起 worker** | 某个 persona 的队首等待超过 N 分钟 → 允许临时超出 cap 起一个，空闲即回收 | 不改变稳态容量，只在异常时救火 | 破例期间内存可能超限（7Gi 下多一个 dsh ≈ +137–200MB）；需与唤醒准入闸协同，否则可能触发拒醒 |
| **C. 按 persona 分别排队 + 轮转派发** | 不改容量，只改**顺序**：多个 persona 都有等待时，派发轮转而不是先到先服务 | 纯排序，零容量风险 | **不解决本例**——本例的问题是"没有可派的槽"，不是顺序（只有一个 persona 有队） |

**C 不能解决本例**，这点值得写明：今天立的 `fix-operator-ignition-priority` 也是纯排序改动，同样救不了这个。

## 四之二、这份文档的证据强度

| 证据 | 内容 | 作用 |
|---|---|---|
| 观测一 | 23:25，三条轮等 51–57 分钟，占 cap 的三个 persona 与它们零重叠 | 证明撞车确实发生 |
| 观测一续 | 23:35/23:37 两条 done（等够才跑），23:38 滚版，镜像不含任何队列修复 | 排除"已被修好"的误判 |
| 观测二 | 23:44 同 cell 同 cap，占用组合换成"1 条长回合 + 2 空槽"→ 完全不堵 | **反证**：与任务来源无关，只与占用组合有关 |

三条合起来，足以把"这是 persona 亲和 + 共享 cap 的结构性结果"这一判断与"这是某个 bug / 排序问题"
区分开。

## 五、我倾向哪个

**A 的变体：不给保底，给上限**——即"任一 persona 占用的槽不得超过 cap − 1"，保证总有一个槽能轮换给别的岗位。它不增加容量、不需要破例，只是禁止"独占"。

理由：B 的破例会破坏 7Gi 内存预算的安全边界（那个预算今天刚因为 OOM 历史抬过一次，不该再随意突破）；而"禁止独占"是可证明的、不依赖阈值调参的。

代价也要说清：`cap=1` 时"不得超过 cap−1"等于谁也不能跑——所以 A 的变体**要求 cap ≥ 2**，生产现在是 3，可行；若将来退回 1，此规则必须显式禁用。

## 六、需要裁决的问题

1. 选 A 的变体（禁独占，要求 cap ≥ 2）、B（等待超阈值破例扩容）、还是暂不处理？
2. 若选 A：cap = 1 时如何退化（禁用规则 / 按"最老等待优先"破例）？
3. 这件事和 `enable-worker-pool-1`（0→1→3 的容量决定）是同一条线——要不要等池跑满一个月再动？

## 七、与今天其他单的边界

| change | 处理的是 |
|---|---|
| `1c003d38b`（已推） | sweep 不再把池等待当孤儿重派 |
| `fix-pool-waiting-is-not-an-orphan`（已立项） | `queueHealth` 不再把池等待计入 orphaned |
| `fix-operator-ignition-priority`（已立项） | 池内**排序**：人的点火优先 |
| **本文档** | **容量/公平**：某个 persona 被无关 persona 独占 cap 而饿死 |

前三个是"信号要如实"，本文档是"事实要合理"。**信号修好之后，这个 51 分钟的等待会从"看起来像故障"变成"如实显示为等待"——但那不意味着它可接受。**
