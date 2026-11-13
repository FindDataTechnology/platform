# 交接单 · 把观测自动化切到日更（2026-11-10）

> 交接原因：本次会话**无法调用 `CronUpdate`**，调度频率切换没做成。
> 口令、判据、验证步骤全部备好，下一个能调该工具的会话（或用户）一条调用即可完成。

## 一、要改的东西（一个自动化）

| 项 | 值 |
| --- | --- |
| 自动化 ID | **`automation-4788da0c-852e-43d2-92cc-1becb2a7d960`** |
| 现标题 | 按小时只读观测个人代理启用前置（三条客观闸门：量 / 非空率 / route=deputy 条数） |
| 现频率 | **每小时** `0 * * * *`（`intervalUnit: hourly`） |
| 目标频率 | **每日 09:00** `0 9 * * *`（`intervalUnit: daily`，北京时间；排在分析岗 08:41 之后） |
| 现 runCount | 5+（每次回报四行读数） |

### 为什么改

同一口径连采 8 次，**其中 6 次数字完全一致**（新增 13 / 非空率 100% / `route=deputy` 3），
类别→路由分布也一字未变。稳态下小时级采集的边际信息为零。详见
`docs/personal-agent-activation-baseline-2026-11-10.md` §六。

## 二、要执行的调用（原文可直接用）

```
CronUpdate({
  id: "automation-4788da0c-852e-43d2-92cc-1becb2a7d960",
  cron: "0 9 * * *",
  interval: 1,
  intervalUnit: "daily",
  title: "每日 09:00 只读复核个人代理启用前置（稳态期日更）",
  prompt: <docs/observation-daily-prompt.md §四 的全文>
})
```

日更版 prompt 全文已落在 **`docs/observation-daily-prompt.md` §四**，可整段复制。
相对小时版的三处差异：

1. 回合窗口从「近 6h」改成 **「近 24h」**；
2. 新增**三条转折条件**（命中即回报第一行写「转折已出现」并建议切回小时级）：
   ① 新增比上次多 5 条或以上；② `route=deputy` 累计 ≥ 4；③ 出现新类别。
3. 允许**唯一的写操作**：把当日读数追加到基线台账并只推备分支
   （`backup/cell-session-persona-local-2026-11-10`），**绝不推 release/main**。

## 三、为什么我没做成（可复核）

| 检查 | 结果 |
| --- | --- |
| 本轮工具集是否含 `CronUpdate` | **不含**（只有 Agent/Bash/Edit/Read/Write/TodoWrite/WebFetch 等） |
| `crontab -l` | 2 条，均无关（`fd-scraw-harness` `0 */6`、`openspec` 备份 `0 3,15`） |
| `~/Library/LaunchAgents` 中的 `StartInterval=3600` | 4 条，均无关（EgoUpdater、GoogleUpdater、`ai-memory-recover-guard.sh`、`fd-wanxing stats-collector`） |
| `~/.zcode` 全盘 grep `0 * * * *` | 命中全在 `cli/artifacts/` 的历史工具落盘结果里，**不是活配置** |
| `~/.zcode/cli/config.json` 顶层键 | 只有 `hooks / mcp / plugins`，**无 automations** |
| 仓内 `.github/workflows` 的 `schedule:` | 只有 `mcp-registry-publish.yml` 的 `0 3 * * 1`（周更） |
| 本会话内 `CronUpdate` 是否曾可用 | **可用过**：rollout 记录 `2026-11-10T14:50:58Z` 有一次带 `intervalUnit` 的真实调用 |

**结论**：自动化存于 harness 内部状态，不落本地文件；改它只能通过 `CronUpdate`，
而这个工具在当前轮次未暴露。**旧的小时级任务仍在按 `0 * * * *` 运行。**

## 四、改完怎么验（三条，缺一不可）

1. **看频率**：再调一次 `CronList`（或等价读取），确认该自动化的 `cronExpr` 已是
   `0 9 * * *`、`scheduleRule.unit === "daily"`；
2. **实跑一次**：手动触发该自动化（或等到次日 09:00），确认它能跑完并回报四行——
   **不能只看配置改了，要看它真的产出过一次读数**；
3. **看它有没有真写台账**：确认 `docs/personal-agent-activation-baseline-2026-11-10.md`
   的「## 二、基线数据」表末多了一行当日读数，且推送目标是**备分支**而不是 release。

## 五、两条仍待裁决（与本次切换无关，但别丢）

| # | 事项 | 现状 | 需要什么 |
| --- | --- | --- | --- |
| 1 | **`MANDATE_VERDICT_TOKEN` 未注入** | `platform-secrets` 17 个键里没有它；披露闸失败关闭 ⇒ **场景 3（对外接待与商务问询）结构性不可用**，即使授权了 `external-comms` 也发不出一个字节 | 生成密钥 → `kubectl patch secret platform-secrets` → **`delete pod`**（env 不热载，`rollout restart` 无效） |
| 2 | **漂移哨两例去留** | `1da519d4`（active，`40 14 * * *` Asia/Shanghai）与 `3fdc7b8e`（**archived**，`17 * * * *` UTC，归档后 16 天零调度）。两例**分属不同 cell**，单 cell 读面不可能同时返回——所以「看到两条」的那个界面尚未查明 | 指明看到两条的具体页面/接口；若是多 cell 聚合看板，则问题不在 `fleets.js` 单 cell 读面 |

## 六、附：不要顺手做的事

- **别把观测挪到 crontab/launchd**：它要现取 pod 名 + 逐 cell `kubectl exec`，
  系统 cron 里跑这类长命令会静默失败；而且等于把「谁能改它」从工具面搬到 shell 面。
- **别为了凑量去放宽路由**：`config-change` / `hr` / `spend` 在 `normalizeRoutes` 里写死
  不可委托，改不动；让 ③ 达标的唯一产品口径是**让岗位多产 `routine-ops`**。
- **别删归档舰队里的残留**：`fleet_row_audit` 是审计留痕，且官方接口对归档舰队返回 409
  （`fleets.js:3829`），只能直改 SQLite——与「别让台账说谎」相反。
