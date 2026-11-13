# automate-nonweb-acceptance — 实施任务

> 提交纪律：逐路径枚举，**勿 `-A`**（2026-10-27 已犯，见记忆）。池=testaction003（派发用）/testaction004（排程用，建制后）。

## 1 · 移动端图表接线（本机可证）

- [x] 1.1 新增 `app/src/lib/markdown-fences.ts`（tokenizeFences 纯函数，语言标记保留+流式未闭合未 chart 路由）；新增 `app/test/markdown-fences.test.mjs` 6 件钉 token/chartOptioin 口径（app 单测 24/24 绿）`tokenizeFences(text)` 纯函数（text/code 双型 token，保留语言标记，流式未闭合按 code）。验证：新增 `app/test/markdown-fences.test.mjs` 覆盖 echarts 语言保留/空语言/未闭合/多围栏，`npm --prefix app run test:unit` 绿
- [x] 1.2 `app/src/components/Markdown.tsx` 改用 tokenizer：echarts 围栏→JSON 解析→ChartView，非法回落码块；95 行完整覆盖（提交 358cce8a 后两刀修）`echarts` 围栏 → `JSON.parse` → `<ChartView option/>`，失败/非对象 → 代码块；其余语言不变。验证：typecheck 绿 + 1.1 单测 + biome 净
- [x] 1.3 `app/src/components/ChartView.tsx` 三态 testID（chart-loading/ok/fallback），settled 升学为 state（原 v1 降级计时缺陷已先修）；壳侧 `sass`、`ok/fail` 邮包合约由 `chart-shell.test.mjs` 钉住（`chart-loading|ok|fallback`，settled 由 ref 升学为 state，成功态保持）。验证：typecheck 绿；`chart-shell` 单测仍绿（壳合约未动）

## 2 · 图表桩与移动端流

- [x] 2.1 `e2e/chaos-llm.js` `chart` 模式（控制面 `shape` 优先/提示词兜底路由；bar 默认、line/pie/scatter 按词判断；SSE 与 stream:false 双形；另 `console.log` 请求账本）控制面 `shape` 选系列（bar/line/pie/scatter），请求末条 user 文本含 `line|pie|scatter` 词时对应系列；SSE 与 stream:false 均返回含 ```echarts 围栏的 assistant 文本。验证：本机 `node e2e/chaos-llm.js` + curl 控制面设 shape=pie 后请求一次，肉眼断围栏 JSON 可被 echarts 接受（4 例各一次）
- [x] 2.2 `app/.maestro/charts.yaml` 已落地并随池轨实跑 8+ 轮（清态→第二实例配对→四提示词→chart-ok/chart-fallback 双断言）——**终验全绿**（run 40758484011：四系列 chart-ok 全可见且 chart-fallback 全不存在）

## 3 · 移动端验收轨上池（跑绿为准）

- [x] 3.1 android 腿扩已落地并**全绿**（run 40758484011：四流+图表腿首绿）：此腿捕获真缺陷**六连**——forward_auth bearer 门/mpAuth verifyToken 门/FlatList extraData/apply fold 丢弃/TurnView 只遍历 groups/echarts CDN→同源托管+鉴权豁免——全回修入 main
- [x] 3.2 池侧复跑确认四流+图表流同趟绿 + 实测分钟入台账通道节。验证：run 40758484011 全绿 + 台账 §15.66/补
- [x] 3.3 iOS 腿维持 dispatch 月频（池日跑剥 ios 腿已实装于 nonweb-daily 修剪步；iOS 覆盖走私仓手动 dispatch）。验证：Open Question 收口入台账

## 4 · 桌面装机 e2e 轨

- [x] 4.1 `release.yml` `installer-e2e`（windows）：装 exe → bundled node 直启 steward → 断 **exact-match 健康✓**（mac/windows 两平台）→ 开 app 断 `ATTACHED to steward` 日志 → 杀 UI 断 steward 存活且 control-plane healthy ✓ → 写死 pid 的 steward.json 再启断 `stale steward discovery removed`+embedded ✓ → 卸载断清场 ✓；**池 run 4048553.. 全断过**；另 artifact_run_id 复用模式（免 mac×10 重烧）与 actions:read 补充下载本 tag exe → 静默装 → bundled node 直启 steward-main → 等 `steward.json` → 起 app → 轮询 main.log `ATTACHED to steward` → 杀 app 断言 steward 存活且 `/api/ready` 200 → 杀 steward 写死 pid 的 steward.json → 再起 app 断言 stale 自清+embedded 200 → 卸载断言清场。验证：池 tag 运行绿（truncate 首个 tag 或对 v1.3.19 复用 dispatch 试跑）
- [x] 4.2 mac 腿（opt-in）：installPlan plist 断言（RunAtLoad/KeepAlive/bundled node/包装管家入口/LaunchAgents 属主）全过 + 直启 steward 健康 + 控制面策略往返（setPolicy/on_demand↔getPolicy）过 + stale 回退过；真登录拉起认 GUI 语境来留月频人工抽检（Non-Goal 明文写入）dmg 挂载版同样本，不做 launchctl；installPlan 输出断言（plist 内容）单测补一条。验证：一次显式 dispatch 绿或如实记录难点
- [x] 4.3 池 main release 桩在使用（release.yml 本身就在 pool main 留有 dispatch 桩，侧分支跑过三班 tag 绿证）——确认池 main 的 release 桩存在且 dispatch 可用（配方③）。验证：`gh workflow list -R testaction003/build-pool` 可见 + 一次试跑

## 5 · 排程开关 + 收口

- [x] 5.1 私仓新增 `.github/workflows/nonweb-daily.yml`（已入库 9162314a）:`schedule`（每日一次）+ 手动；ubuntu 单 job（~1-2 私仓分钟）做干净快照推池 + 池 dispatch app-e2e；`BUILD_POOL_TOKEN` 缺失时 job 显式 `SKIPPED: BUILD_POOL_TOKEN missing` 后退出 0。验证：`workflow_dispatch` 空跑一次（无 secret）产出 skip 摘要
- [ ] 5.2 台账：通道节补「验收轨」小节（移动验收轨分钟/桌面 installer-e2e/排程开关状态与 secret 名）+ §15.65 发布记录（本 change 全链）。验证：台账两处可见
- [ ] 5.3 `openspec validate automate-nonweb-acceptance --strict` 零 error；`openspec validate --specs` 不掉数。验证：命令输出
- [ ] 5.4 归档（全勾后）+ 记忆更新（含判路：图表围栏/验收轨/secret 名）。验证：archive 目录 + validate --specs 计数