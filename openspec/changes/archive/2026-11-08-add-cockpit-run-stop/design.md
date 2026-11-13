# Design — add-cockpit-run-stop

## D1 停止只能出现在「还在跑」的 run 上

判定取 `status === "open" && stoppedAt == null`。`runListEntry` 里 `status` 是**派生结果**，
`stoppedAt/stopReason` 才是「为什么停」——所以已经停过的 run 可能仍是 open 或已转
interrupted，两者都要排除：前者靠 `stoppedAt`，后者靠 `status`。对已结束的 run 给按钮等于
承诺一件做不到的事。

## D2 为什么必须确认，且确认框是危险态

这一下会**中断正在跑的回合**：可能是一个已经烧了十分钟、马上要交稿的回合。所以：
- 复用 `ui/confirm-dialog`（取消在 DOM 顺序前 = 默认焦点落在安全侧；Esc = 取消）；
- `variant="danger"` 走 destructive 填充；
- 文案写清后果（在飞回合中断 / 已完成回合与报数保留 / 停止后不再点火），而不是只说「确定吗」。

## D3 回执必须如实，不能一律「已停止」

接口返回 `alreadyStopped`。如果主人点了一条其实早就停了的 run，说「已停止」会让他以为刚刚
发生了什么事。所以三种回执分开：
- `alreadyStopped` → 「这一轮此前已停止。」
- 正常 → 「已停止：本轮中断 N 个在飞回合。」
- 抛错 → 「停止失败：<服务端原因>」（错误体里的 `error` 原样带出，不吞成通用文案）。

## D4 停止后重新读，而不是本地改状态

`stopRun` 会中断在飞会话，那些回合的 finalize 是**异步**的；本地直接把 run 标成 stopped 会和
事件的真实到达顺序打架。所以停止成功后重新 `getRun` + `listRuns`，让读面说真话。
`fleet_run_updated` 广播也会推一次，这里只是不依赖它。

## D5 为什么用 StatusPill 而不是自绘琥珀色

`design-lint` 对该文件的 named-color 有棘轮（baseline 13，加 3 就是违规）。更重要的是
`web-design-system` 的规矩：状态色只能由 `StatusPill` 承载，且颜色永不单独表达含义（`label` 必填）。
`status="paused"` 的语义正好是「停着」。

## Risks

- R1 误点：两次点击才生效（按钮 → 确认框内确认），且确认框按钮文案是动作本身。
- R2 中断后残留：`stopRun` 的中断经 `taskTurnRegistry`，找不到会话时只打标记——所以回执里的
  「中断 N 个」是**真实中断数**，不是乐观值。
- R3 与并发广播竞态：停止后立即重读一次；若广播随后到达，`runsVersion` 会再刷一遍，两者幂等。
