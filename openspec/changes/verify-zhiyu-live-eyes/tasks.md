# Tasks — verify-zhiyu-live-eyes

> 三项都"有代码、缺条件"。每项写明触发条件与一条可直接跑的命令；条件未到就保持 `- [ ]`。

## 1. live 浏览器眼（访客链路端到端）

- [ ] 1.1 换有效口令（`.env` 的 `PAAS_TEST_PASSWORD`，在环境里改，**不要**进出口对话），然后跑：
      `cd paas && PW_LIVE=1 LIVE_SERVICE_URL=https://platform.finddatatech.cloud npx playwright test e2e/live-zhiyu-embed.spec.js --project=live`
      判据：绿，且断言里两条新行为成立——首屏请求 `/widget/<token>/messages?tail=200`、实时流请求 `/events?after=<cursor>`；
      该 spec 自带清理（结束房 + 吊销两条令牌）。注意 `live-helpers.js` 默认的 `LIVE_SERVICE_URL`（23.144.68.246:30950）已不可达，必须显式覆盖。
- [ ] 1.2 跑通后把 `polish-zhiyu-reception-welcome-line` 与 `fix-zhiyu-room-lifecycle-and-bridge-watermark` 的 4.3 证据补进各自的归档件（只补证据，不重开）。

## 2. 健康抖动合并的生产样本

- [x] 2.1 生产观察（2026-11-10，自建观察对象，事后已删）：新建一间活跃房订阅真实车队 `fleet_1794014195618_jjf1l1`，owner 指向有 cell 的账号（首版用 e2e-verify@ 无 cell，采样返回 null，watermark 停在 null——这也是个判据：**订阅 owner 必须是有 cell 的真实账号**）。逐轮观察到的三段行为与 spec 完全一致：
  - ① 首见静默基线：`{abnormalCount:1, healthPending:null}`，零行；
  - ② 抖动被抑制：队伍从 1 岗异常翻到 0 后水位线变成 `healthPending:{value:0, since:14:08:08}`，**零事件行**；
  - ③ 房间被空闲巡检自动结束（14:14:31 `room_ended/idle`）→ 走"结束房清 pending"分支：`healthPending→null`、状态提交为 1、**不补发**（该房只留 room_ended 一行）。
  即"抖动合并 + 持续态 + 结束清 pending"三条在真实车队上同时成立，无一需要人工干预。
      判据：抖动窗口内 `zy_room_messages` 里 `provenance='fleet-room-bridge' AND json_extract(meta,'$.at')` 无新增行，
      而稳定满 `ZHIYU_HEALTH_SETTLE_MS`(默认 10 分钟) 后恰落一行且尾注「其间抖动 k 次已合并」；
      同时 `zy_fleet_subs.watermark` 里 `healthPending` 在观察期非空、结算后归 null。
- [x] 2.2 无需手工构造：2.1 的自然抖动已足够结案（若未来复验需要，仍可用 tasks 里原本的手工方案）。
- [x] 2.3 顺带验证了保留期的**删除语义**（同批自建）：一间结束房放三条行（40 天前的 system / 40 天前的 human / 新 system），强制 `retention_last_run=1` 让下一轮 tick 立即到期 → 结果只删了那条 40 天前的 **system** 行，human 与新 system 行都在。证明 `pruneRoomSystemRows` 的"只碰已结束房的过期非对话行"在生产真成立（此前只有 `matched=0` 的日志，没有删除样本）。

## 3. 收口

- [ ] 3.1 归档本单：仅剩 1.1/1.2（完整浏览器眼，需有效口令）——换好口令跑通后归档，并把结论回写进 `polish-zhiyu-reception-welcome-line` / `debounce-zhiyu-fleet-health-events` 的归档件（一行 evidence）。抖动与保留期两项已结案（见 2.1–2.3），不阻塞本单剩余部分。
