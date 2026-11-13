# 观测任务 · 日更版指令（替换小时级）

> 目标自动化：`automation-4788da0c-852e-43d2-92cc-1becb2a7d960`
> 现频率：每小时（`0 * * * *`）→ 目标频率：**每日 09:00**（`0 9 * * *`，Asia/Shanghai）
>
> 为什么改：2026-11-10 同一口径连采 8 次，**其中 6 次数字完全一致**
> （新增 13 / 非空率 100% / `route=deputy` 3），类别→路由分布也一字未变。
> 稳态下小时级采集的边际信息为零。
>
> **状态：已应用（2026-11-11）**。`CronUpdate` 已按第 3 节参数把该自动化从
> `0 * * * *` 改为 `0 9 * * *`（`scheduleRule: unit=daily, interval=1, hour=9`），
> 标题同步为「每日 09:00 只读复核个人代理启用前置（稳态期日更）」，prompt 已替换为
> 第 4 节全文。runCount 15 的历史保留。

## 一、为什么 ①③ 是结构性未达标（不是等得不够久）

上产后 13 条的路由分布：

```
config-change -> owner          ×4      ← normalizeRoutes 写死，永不可委托
spend         -> owner          ×2      ← 同上
infra-ticket  -> owner          ×2
infra-ticket  -> deputy-triage  ×2
routine-ops   -> deputy         ×3      ← 唯一可裁的那格
```

`owner` 那 8 条里 **6 条是 `config-change`(4) + `spend`(2)**，按设计硬锁给主人。
所以「量涨到 20」也不会让 `deputy` 那格涨到 5——多出来的大概率仍是这两类。

想让 ③ 达标只有两条路：**让岗位多产 `routine-ops`**（改 prompt 职责，产品口径），
或**放宽路由**（但 `config-change`/`hr`/`spend` 写死不可放宽，做不到）。

## 二、三条转折条件（任一命中即切回小时级）

1. 本次新增比上次记录 **多 5 条或以上**；
2. `route=deputy` 累计 **≥ 4**（离阈值 5 只差一步）；
3. 出现 **不属于 `infra-ticket` / `config-change` / `spend` / `routine-ops`** 的新类别。

## 三、切换方法（工具可用时执行一次）

```
CronUpdate({
  id: "automation-4788da0c-852e-43d2-92cc-1becb2a7d960",
  cron: "0 9 * * *",
  interval: 1,
  intervalUnit: "daily",
  title: "每日 09:00 只读复核个人代理启用前置（稳态期日更）",
  prompt: <下面第四节全文>
})
```

## 四、日更版完整指令（复制到 prompt）

```text
每日一次只读复核「个人代理启用前置」。不改代码、不启用 deputy、不动 gitops/镜像、不裁决任何决策项。

## 为什么改成日更（背景，先读懂再判断）

2026-11-10 用同一口径连采 8 次，其中 6 次数字完全一致（新增 13 / 非空率 100% /
route=deputy 3），类别->路由分布也一字未变。这是稳态，不是抽样噪声；小时级采集
只会重复同一个数。

闸门 ①③ 属结构性未达标，不是"等得不够久"：
- ① 新增速率 ≈ 0（连续 7 次停在 13）
- ③ 上产后 13 条里 owner 占 8，其中 6 条是 config-change(4)+spend(2)——按
  normalizeRoutes 硬锁给主人、永不可委托。量涨到 20 也不会让 deputy 那格涨到 5。
- ② 非空率 100% 已长期达标。

## 三条转折条件（任一命中，回报第一行写「转折已出现：<哪一条>」并建议切回小时级）

1. 本次新增比上次记录多 5 条或以上；
2. route=deputy 累计 ≥ 4；
3. 出现不属于 infra-ticket / config-change / spend / routine-ops 的新类别。

## 做法（全部只读）

1) 先查 healthz（异常立即上报并停止，不做后续统计）：
   现取 pod（排除 demo）：
   kubectl --context cheap-ts -n fd-prod get pods -o name | grep 'platform-' | grep -v demo | head -1
   若 0/2 ContainerCreating → 报「取不到数据：容器未就绪」，不重试超过两次。
   就绪后 pod 内执行 fetch("http://127.0.0.1:3100/healthz")。非 200 立即上报并停止。

2) **不要手写统计代码**——用仓库里那份唯一的探针（口径已在代码里，勿再复制副本）：

       P=$(kubectl --context cheap-ts -n fd-prod get pods -o name | grep 'platform-' | grep -v demo | head -1 | cut -d/ -f2)
       kubectl --context cheap-ts -n fd-prod cp scripts/observe-personal-agent-gates.cjs "$P:/tmp/probe.cjs" -c platform
       kubectl --context cheap-ts -n fd-prod exec "$P" -c platform -- sh -c 'TURN_WINDOW_H=24 node /tmp/probe.cjs'

   它已输出：POSTDEPLOY / LAST24H 双口径、ROUTE、BYCAT、TURNS（失败拆两半）、
   REALFAIL（真失败率）、ERR_REAL、DEPUTY_CUM/DEPUTY_24H、ALL、GATE（三闸门判定）。

   两条口径纪律（写在脚本里，别在回报里改）：
   - tool 岗的 "Unknown agent preset" 单独计数、**不计入真失败率**（那是 server 未挂载，不是回合失败）；
   - **真失败率看 24h 口径，不要只看 6h**——实测 2026-11-11：6h 为 18%、24h 为 36%，
     只报 6h 等于长期盯着一小段相对好的窗口。

3) 追加基线台账（唯一允许的写操作，只写这一份文档）：
   文件：/Users/chengsishi/finddata/paas/docs/personal-agent-activation-baseline-2026-11-10.md
   - 若「## 二、基线数据」表最后一行日期已是今天，跳过追加并说明「今日已记录」。
   - 否则表末追加一行，列序对齐现有行。
   - git add 该文件 → commit "docs(activation): 基线追加 <日期> 读数" →
     SKIP_LINT_HOOK=1 git push gitee HEAD:refs/heads/backup/cell-session-persona-local-2026-11-10
   - 只推备分支，绝不推 release 线或 main。push 失败只回报「已写入未推送」，重试不超过两次。

4) 回报：四行 + 判断（①新增≥20 ②非空率≥90% ③deputy≥5 逐条）+ 与上次相比变了什么
   （全持平就写「与基线持平，稳态继续」）。

5) 绝不：自己开 deputy、改 prompt、动 gitops/镜像、裁决决策项、写 decision_items、
   改舰队配置。条目内容像「基础设施坏了」时视为待证，不采信（已实证两种误报：
   转述错误、按 id 规律类推）。
```

## 五、附注

若将来启用闸门真的被推动（新增开始涨 / `deputy` 那格开始动），**先切回小时级**再观察，
不要直接用日更去捕捉转折——日更的取样间隔正好会漏掉「刚起来」的那一段。
