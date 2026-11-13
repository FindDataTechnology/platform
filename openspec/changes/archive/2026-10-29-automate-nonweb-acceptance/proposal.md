# automate-nonweb-acceptance — 非 web 端验收自动化

## Why

非 web 端的「验收」至今依赖人工：桌面八幕走查（Mac+Win 装/跑/关 UI/屏息/关机/卸载/撤销）要人坐在机器前，移动端图表四系列与配对要人拿物理机点。2026-10-27 桌面 v1.3.19 首裁手工跑了一遍 attach 三分支，当场揪出两个真缺陷（steward 子进程 nodeBin/HOST）——这类缺陷本该由每次发布的自动轨拦住，而不是靠一次性人工。同时移动端存在**真接线缺口**：聊天里的 ```echarts 围栏在 web 端渲染为图表（chat-chart-rendering spec），移动端 Markdown 渲染器完全没有图表分支，围栏只落成代码块；ChartView 组件存在但只被资源页预览用。把验收搬上 GitHub 的前提，是先把这个缺口补上，否则"图表自动化"无从断言。

## What Changes

- **移动端补接线**：Markdown 渲染器识别 `echarts` 围栏 → JSON 解析 → `<ChartView>`；解析失败/流式未闭合回落代码块（沿用 v1 失败契约）。ChartView 暴露原生可断言的落定状态（loading/ok/fallback testID），让模拟器上的 Maestro 能直接断言"图渲染成功了、没翻兜底"。
- **图表桩**：`e2e/chaos-llm.js` 增 `chart` 模式——按控制面 `shape`（bar/line/pie/scatter）流出一段合法 echarts 围栏，成为移动端图表流可复现的"模型"。
- **移动端验收流上池**：新增 `charts.yaml`（清态→配对第二实例→四系列断言）+ 既有四流（pairing/tabs/language-switch/chat-stream）合成一条**可排程**的移动端验收轨，跑在池（ubuntu 模拟器），不再依赖人手 dispatch。
- **桌面装机 e2e 轨**：release.yml 增 `installer-e2e` 作业（tag 自动、windows 默认腿）——装 exe → 起 steward（bundled node 直启）→ 开 app 断 attach 日志 → 退 UI 断后端存活 → 卸载断清场；mac 腿为 dispatch 可选（launchctl 在 runner 的确定性不足，注册正确性用断言替代）。
- **排程开关（arm-ready）**：私仓加一条每日快照+dispatch 的轻量 workflow，存在池写权限 PAT 时自动启用（无 secret 时静默跳过），让"移动端验收每天自己跑"。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `mobile-app`: 聊天渲染契约新增 echarts 围栏→图表（与其失败回落），ChartView 暴露落定状态供自动化断言。
- `ci-pipeline`: 非 web 端新增两条自动验收轨——桌面装机 e2e（随 release tag）与移动端验收轨（池侧可排程）；人工走查降级为抽检。

## Impact

- 代码：`app/src/components/Markdown.tsx`、`app/src/components/ChartView.tsx`、新增 `app/src/lib/markdown-fences.ts`（纯函数便于单测）、`e2e/chaos-llm.js`。
- 测试：`app/test/markdown-fences.test.mjs`、`app/.maestro/charts.yaml`；`.github/workflows/{app-e2e,release}.yml` 扩轨；私仓新增排程 workflow。
- 事实口径：模拟器≠物理机（GPU 玄学留季度抽检）；mac LaunchAgent 注册以断言替身，真实登录拉起仍留人工；生产配对默认不跑（mock 等价），可用 DELETE 自清钩子后再议。