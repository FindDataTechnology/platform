# 队列积压 / 假绿的判读手册

> 来源：`openspec/changes/harden-fleet-execution-economics` 任务 5.3。
> 2026-11-08~09 两次误判的产物——先说结论：**看见"队列很深"之前，先确认这个数字是怎么算出来的。**

## 一、为什么这个数字曾经不可信

`jobs.json` 里有两个时间戳，含义不同：

| 字段 | 含义 | 会不会被重置 |
|---|---|---|
| `queuedAt` | **本次尝试**入队的时刻 | **会**——每次重新入队、每次启动 `drainRepairQueue` 都重打 |
| `firstQueuedAt` | 这发请求**第一次**要槽位的时刻 | 不会（`saveTasks` 白名单专门保留） |

用 `queuedAt` 算等待时长，重启后整批积压会显示成"刚入队"。实测（2026-11-08）：

- 用 `queuedAt`：最老等待 ≈ **1 分钟**；
- 用 `firstQueuedAt`：p50 **85 分钟**、最长 **148 分钟**。

同一个队列，差了两个数量级。已在 `task-engine.js::queueAnchorMs` 与
`server/cron-runner.js::_queueWaitMs` 统一为 `firstQueuedAt ?? queuedAt`。

## 二、看见积压：一条命令

```bash
# 1) 队列健康（就绪面同源）：200 正常 / 503 降级
curl -s -o /tmp/q.json -w '%{http_code}\n' http://127.0.0.1:3100/readyz
python3 -m json.tool /tmp/q.json
```

`/readyz` 的字段：

| 字段 | 读法 |
|---|---|
| `queued` | 所有 resident cell 的排队总数 |
| `oldestQueuedMs` | **最老等待**（`null` = 没有任何 cell 答上来 **或** 排队的轮全是按设计豁免的，不要读成 0；用 `queuedExempt` 与 `answered` 区分） |
| `queuedExempt` | 按设计继续等待的排期轮（周期 ≥ 6 小时，丢一轮会损失整天覆盖）。`queued>0` 而 `oldestQueuedMs=null` 且 `queuedExempt=queued` → 队列没卡，是这些轮在正常等槽 |
| `degradedCells` | 哪些 cell 自己报了降级（超阈值/超预算） |
| `unknown` | 问不到的 cell 及原因（**不算失败**：一个慢 cell 不该摘掉整个平台） |
| `answered` | 答上来的 cell 数；`answered < cells` 说明有 cell 失联，结合 `unknown` 看 |

**注意**：`/api/ready`（cell 侧、带 `queue` 段与 503）从 pod 内直连是 **401**——
网关拦在鉴权后面，k8s 探针读不到。要用 `/readyz`（网关侧、无鉴权、聚合各 cell）。

## 三、直接看盘（不依赖任何端点）

```bash
POD=$(kubectl -n fd-prod get pods -o name | grep 'platform-' | grep -v demo | head -1)
kubectl -n fd-prod exec $POD -c platform -- node -e '
const fs=require("fs"),path=require("path");
const now=Date.now();
for (const c of fs.readdirSync("/data/cells")) {
  const f=path.join("/data/cells",c,"data","cron-store","jobs.json");
  if(!fs.existsSync(f)) continue;
  let a; try{a=JSON.parse(fs.readFileSync(f,"utf8"));}catch(e){continue;}
  if(!Array.isArray(a)) continue;
  const q=a.filter(t=>t&&t.state==="queued");
  if(!q.length) continue;
  const w=q.map(t=>{const k=Number.isFinite(t.firstQueuedAt)?t.firstQueuedAt:t.queuedAt;
    return Number.isFinite(k)?Math.round((now-k)/60000):null}).filter(x=>x!==null).sort((x,y)=>x-y);
  console.log(c,"queued="+q.length,"p50="+w[Math.floor(w.length/2)]+"min","max="+Math.max(...w)+"min");
}'
```

## 四、四态口径：别把"没跑"算成"失败"（这是最容易犯的错）

`history[]` 有**四种**结局，不是成功/失败两种：

```js
h.success === null && h.missed   → 到期未执行（槽位被占，从未开始）
h.success === true               → 完成
h.state === "skipped"            → 主动跳过（老化/降级）
h.success === false              → 真失败
```

- **失败率** = `failed / (done + failed + skipped)` —— 分母**只含真正执行过的**；
- **排队饥饿** = `missed / (done + failed + skipped)`。

⚠️ **`missed` 只在"重启不频繁"时才是饥饿指标**（2026-11-09 实测修正）：
`countMissedOccurrences` 原先从 `lastRun` 一路数到现在，而它在每次启动加载与
每次 resume 都会跑——于是同一批历史触发点被**按重启次数重复累加**。
实测一个 `10 9 * * *`（每天一次）的 job 一天内 `missed=69`，其中 8 次集中在
我滚了 4 次版的那两小时。

**判据**：看 `missed` 的分时分布。若每个 job 的 missed 次数**正好等于重启次数**、
且集中在几分钟的窗口里，那是重启假信号，不是饥饿。已修（水位
`lastMissedCountedUntil`，同一缺口只记一次）。

### 4.1 `missed` 的两个新口径（2026-11-09 复算后补）

**① 撞上限的行只是下界。** `countMissedBetween` 一次加载最多数
`MAX_MISSED_PER_LOAD = 100` 个触发点；撞上限时水位照样推进到 `now`，
超出那截**永久不计**。这是有意的取舍（反过来的错——重复记——曾让我误判
"饥饿恶化"），但必须打标：写入方盖 `missedCapped: true`，
`summarizeHistory()` 分开报 `missed`（行数）/ `missedOccurrences`（次数）/
`missedCapped`（下界行数）。**一行 `missed:100` 与一行 `missed:1` 都是"一次记录"，
但差 100 倍**——用行数当饥饿量级会把最糟的 job 读成最轻的。

**② 暂停任务不欠轮次。** 原先 boot pass 只把 `!paused` 用在补跑与告警上，
`countMissedOccurrences` 与落盘没拦：一个 10-25 起就暂停的 `17 * * * *` 任务
在每次 cell 重启时都记一笔缺口，24h 内积到 **2700 次（27 行 × 上限 100）**，
占该窗口全部 missed 的 83%，读起来像"排队饥饿恶化"。现已跳过暂停任务；
resume 时把水位推到 `now`，不把暂停窗口当欠账。

### 4.2 唯一读面：`scripts/queue-history-stats.mjs`

不要再在报表脚本里自己写 `cls()`——那正是同一天里同一个形状被读错三次的原因。

```bash
# 直接对生产 job 库算（先从 cell 拷出来；3MB 级文件 kubectl cp 会截断，见 §6）
node scripts/queue-history-stats.mjs --hours 24 /path/cell-a.json /path/cell-b.json
node scripts/queue-history-stats.mjs --hours 24 --per-task ...   # 按饥饿比排序
node scripts/queue-history-stats.mjs --json ...                  # 给 24h 报表吃
node scripts/queue-history-stats.mjs --hours 24 --trusted ...    # 见下
```

两条内置的诚实性约定：

- **坏文件不当零行**：解析失败的文件单独列出。`kubectl cp` 截断过的 JSON
  看起来只是"这个 cell 没记录"，实测骗过一次。
- **存量污染要告警**：`kind` 字段是 2026-11-09 才加的，之前写入的 missed 行
  没有它，而且那批数字本身就是重复记的。窗口一旦跨过修复时刻，`missed`
  就是虚高的——脚本会点名有几行 legacy burst，`--trusted` 只丢掉
  **存量的 missed 行**（执行行的 `state` 一直都在，分类不依赖 `kind`）。

**复算结果（2026-11-09，4 个在用 cell，24h 窗口；窗口边随运行时刻滑动）：**

| 读法 | 分母 | 结果 |
|---|---|---|
| 正确（`executed`） | 557 | **失败率 34.6%**（failed 193） |
| 旧读法（missed+meta 当失败） | 1007 | 63.9%（failed 643） |

差 **1.85 倍**。旧读法把 375 行 missed 与 75 行校准留痕（`note` 行）一起
塞进了失败桶——那 75 行正是我自己早前做校准留下的审计行。

⚠️ `--trusted` 在该窗口返回 `missed = 0`：线上**还没写入任何一行
`kind:"missed"`**（镜像未更新），所以当期窗口里的 missed 全是存量。
饥饿量级要等带本次改动的镜像上产、且窗口完全落在修复之后才可读。

历史读法（有效，但要看窗口内是否重启过）：2026-11-08 最近 24h 真执行 590
（done 148 / failed 328 / skipped 114），另有 842 次到期未跑 → 失败率 55.6%。
（更早的 89.7% 是把 missed 当成失败算出来的，错。）

## 五、判断"该不该加承载"

顺序不能颠倒：

1. **先看失败构成**：如果 68% 是 `budget_exhausted`，加并发只是更快地把额度撞完；
2. **再看积压是"排不上"还是"跑得慢"**：`missed` 高 = 排不上；`turn_timeout` 高 = 跑得慢；
3. **最后才谈并发**：`TASK_WORKER_MAX>0` 需要确认三件事——
   容器大版本已抬（准入按 `used + cell 足迹` 比对 `limit × 0.85`）、
   池级看门狗在镜像里（否则不结算的回合会永久占槽）、
   目标 tag 已在节点缓存（否则 `Recreate` 会拉取失败）。

## 六、已知的坑（都实测过）

| 现象 | 真因 |
|---|---|
| 积压很深但 `/api/ready` 绿 | ①探针读不到（网关 401）；②`queuedAt` 被重启重置 |
| 改 limit 后 pod 建不出来、全站断 | `fd-prod` 配额 `limits.memory` 顶满；`Recreate` 先删旧 pod → 直接断服。**改资源前先 `get quota`** |
| worker 池开了但回合空转 608s | 唤醒准入拒（`limit` 太小，投影 <15% headroom）；且当时无池级看门狗 |
| `budget_exhausted` 占比极高 | 每日额度 8M 已耗尽；加并发无益，要么分账要么降任务量 |

## 七、抬 tag / 滚版前的三查（2026-11-09 实战版）

> 这三查都是当天真踩过才写的：第一查漏了会**上线一个死的端点**，第二查漏了会
> **拉镜像失败停机 3 分钟**，第三查漏了会**建不出 pod 直接断服**。

### 查 1：目标镜像里到底有没有你要的那个提交

不要相信 tag 的语义，直接用**能区分新旧的特征**去镜像仓源码里 grep：

```bash
# 例：确认某版本的 gateway/index.js 里已经有 /readyz 这个端点
gh api "repos/<mirror-org>/<mirror-repo>/contents/gateway/index.js?ref=<shortsha>" \
  --jq '.content' | base64 -d | grep -c '"/readyz"'
# 1 = 有；0 = 没有
```

更彻底的做法是让出片写 `BUILD-INFO.json`（基线 commit + 源分支），那样"这片含不含
某提交"可以直接读文件回答，不用猜。

**当日教训**：镜像滚上去了、代码也在里面，但 `/readyz` 返回的是 SPA 的 HTML——
路由被兜底正则吞了。**"代码在镜像里" ≠ "功能可用"**，接口类改动必须打一次真实请求验。

### 查 2：tag 是否已在目标节点缓存（否则 Recreate 会停机）

```bash
M=$(grep -m1 '^\s*image:' all-services/prod/platform.yaml | sed 's/#.*//' | awk '{print $2}')
L=$(kubectl -n fd-prod get deploy platform -o jsonpath='{.spec.template.spec.containers[0].image}')
echo "manifest=$M"; echo "live=$L"
```

- **两者相同** → 该 tag 的进程正在节点上跑，必然已缓存，滚版不会拉取。
- **不同** → 需要拉取，先确认镜像仓里已有该 tag（跨区同步有分钟级延迟），
  否则会复现 `ImagePullBackOff`（2026-11-08 实测停机约 3 分钟）。

### 查 3：命名空间配额装得下新 pod

```bash
kubectl -n fd-prod get resourcequota compute-quota \
  -o jsonpath='{.status.used.limits\.memory} / {.status.hard.limits\.memory}{"\n"}'
```

`strategy: Recreate` 会**先删旧 pod 再建新的**——新 pod 被配额拒绝就是全站断服，
不是"滚版失败"。（2026-11-08 实测断服约 2 分钟：改 limit 前没查这一项。）

### 抬完怎么验（四条，缺一不算成功）

```bash
POD=$(kubectl -n fd-prod get pods -o name | grep 'platform-' | grep -v demo | head -1)

# ① 存活 + cell 数没掉 + 无错误 cell
kubectl -n fd-prod exec $POD -c platform -- curl -s http://127.0.0.1:3100/healthz

# ② 新端点真的打得通（且返回 JSON，不是 HTML）
kubectl -n fd-prod exec $POD -c platform -- \
  sh -c 'curl -s -H "accept: application/json" http://127.0.0.1:3100/readyz | head -c 200'
#   拿到 {"ready":...} 才算通；拿到 <!doctype html> 说明被 SPA 兜底吞了

# ③ 队列读面
kubectl -n fd-prod exec $POD -c platform -- curl -s http://127.0.0.1:3100/readyz | python3 -m json.tool

# ④ 镜像身份（防止"以为滚了其实没滚"）
kubectl -n fd-prod get deploy platform \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
```

**当日教训**：`/readyz` 的 5 条单测全绿，而线上它返回 HTML——因为测试只测了聚合纯函数，
没测路由可达性。所以第 ② 步不能省：**接口类改动必须打真实请求**。

## 八、`history[]` 是执行历史，不是便签本（2026-11-09 实测）

**任何写进 `history[]` 的行都会被统计工具当成"一次执行"。**

当天教训：校准脚本为了留痕，往 `history[]` 追加了一条
`{ time, missed: 0, success: null, note: "missed counter recalibrated …" }`。
这条记录没有 `state`、没有 `error`，于是被统计脚本归进"未分类失败"——
**真实失败率 38.3% 被我读成 62.1%**（75 条审计行冒充失败）。

规则：

- `history[]` 只写真执行结果（`success` 必须是 true/false/null+missed 三态之一）；
- 元数据类改动（校准、迁移、重置、打标）写**记录级字段**，例如
  `missedResetAt` / `missedResetReason` —— 它们已经在 `clientShape` 的读面里；
- 统计脚本必须能识别非执行行：若某行没有 `state` 且有 `note`，它不是一次执行。

自检一条命令（近 6 小时）：

```bash
# 形状分布：出现 state=undefined + note 的行就是元数据混入
node -e '...过滤 h.success===null && !h.missed...'
```

清理（需停 cell，否则 `saveTasks` 覆盖）：

```bash
node scripts/missed-recalibrate.mjs --dir /data/cells --clean-markers --apply
```

## 九、读数不可信清单（2026-11-09，一天之内六个坑）

> 这一节的存在理由：当天每一次误判都不是"想错了"，而是**信了一个看起来在动的数字**。
> 每一条都写清「它为什么骗人」和「该怎么读」，下次先查这里再下结论。

| # | 读数 | 为什么骗人 | 正确读法 |
|---|---|---|---|
| 1 | `jobs.json` 的 `queuedAt` | 每次重新入队、每次启动 drain 都重打 | 用 `firstQueuedAt`（`queueAnchorMs`）。实测同一队列，前者显示 1 分钟，后者 85 分钟 |
| 2 | `missed` 累计数 | 修好前每次启动都从 `lastRun` 重数同一批缺口，按重启次数翻倍（一个日频 job 到 25315） | 现已加水位 `lastMissedCountedUntil`；判据看**分时分布**——每个 job 次数≈重启次数就是假信号 |
| 3 | `executionCarrier` | **瞬态，不落盘**（`saveTasks` 白名单里没有），从磁盘加载的任务恒为 `null` | 查持久化账本 `member_turn_events.carrier`，别看 `jobs.json` |
| 4 | `history[]` 里的 `success:null` | 三种含义混在一起：到期未执行（`missed:1`）、审计/元数据行（有 `note` 无 `state`）、真失败 | 失败率分母只含 `done+failed+skipped`；先按 `keys` 分组看形状 |
| 5 | `history[]` 的任意一行 | 统计工具一律当作"一次执行"——我的校准脚本写了 75 条审计行，把 38.3% 读成 62.1% | 元数据只写记录级字段；见第八节 |
| 6 | CI 的 lint 红 | `ci.yml` 的 lint/unit 与出片门无关；`image`/`image-publish` 才是出片门 | 判出片看 `gh run list --workflow=image-publish.yml`，不要看仓库最近一次 run |

### 一句话判据

**看到任何数字先问三句**：它是谁写的？写了什么时候？会不会被重置/重复计？

三句里有一句答不上来，就先做一次交叉验证（换一个数据源对同一个事实），再下结论。

