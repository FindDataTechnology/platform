# automate-nonweb-acceptance — 设计

## Context

见 proposal.md · Why。现场事实（2026-10-27 全部实测）：

- **图表两条实现路径不同源**：web 端聊天是把 assistant 文本（含 ```echarts 围栏）灌进 reducer 后由 Markdown 渲染成图表（`e2e/chat-chart-rendering.spec.js`，断言 `testID=echart` + canvas）；移动端 `app/src/components/Markdown.tsx` 只用 `split(/```…/)` 取代码块，**丢弃语言标记**，echarts 围栏必然落成代码块。ChartView（4.2）只被资源页预览（4.3）用。
- **可断言面**：Maestro 只能看原生视图树，WebView 内部不可查。ChartView 当前无状态 testID——必须把 loading/ok/fallback 暴露为原生 testID 才能在模拟器上断言。
- **桩设施现成**：`e2e/chaos-llm.js` 是 OpenAI 兼容 chaos 网关（`POST /v1/chat/completions` SSE + `POST /__chaos/control` 控制 mode/shape）；`server.js` 认 `LLM_BASE_URL`/`LLM_API_KEY`（server.js:168、dsh-profile.js:144）。移动 mock 既有 dead-LLM 实例（9411）供 chat-stream 流断言「错也要有 UI」。
- **池上配对流已证**：`40425053536`（2026-10-27）gates/apk/antroid 三棒全绿，pairing 流以 testID（`server-input`/`code-input`/`bind-button`）走手输路径。
- **凭证位面**：私仓与池仓现存 secrets 均无跨仓 PAT（池=仅 TCR；私仓=仅 TCR/Apple/MinIO）。排程轨需要一枚新 PAT，实施为「无 secret 静默跳过」的 arm-ready 形态。

## Goals / Non-Goals

**Goals:**

- 移动端图表路径与 web 对齐（围栏→图表；失败→代码块），并有自动化断言钉住。
- 移动端**整套验收**（配对+三页签+语言切换+chat 错误面+图表四系列）成为一条可排程的池侧轨，日常不再依赖人手 dispatch。
- 桌面安装包验收：每次 release tag 自动跑「装→steward attach→退 UI 存活→卸载清场」，把首裁三分支固化为 CI 断言。
- 所有断言可在 ubuntu(模拟器)/windows runner 上确定性通过，不依赖物理机或 GUI 会话。

**Non-Goals:**

- 不做桌面「屏息/关机重登」真 reboot 验证（ephemeral runner 自杀），注册正确性用 plist/task 断言替身；真登录拉起留季度人工抽检。
- 不在 CI 里做 LaunchAgent `launchctl bootstrap gui/` 路径（headless runner 无 GUI 会话域，确定性不足）——steward 用 bundled node 直启，覆盖 attach/detach/自清机制本身。
- 不指生产做配对（mock 等价；生产自清钩子另案）。
- 不改 web 端图表渲染与既有 chat-chart-rendering 契约。

## Decisions

### D1 围栏解析下沉为纯函数 `markdown-fences.ts`

`tokenizeFences(text)` 返回 `{kind:"text"|"code", lang, body}[]`；流式未闭合尾段按代码处理。Markdown.tsx 消费它；单测直接断言 token 序列（Node 跑 .ts，含 echarts 语言标记保留、空语言、未闭合、嵌套 ``` 不误切）。替代方案「Markdown 内正则就地改」被否：tsx 无法进现单测体系。

### D2 echarts 围栏→ChartView，失败回落代码块

`JSON.parse(body)` 失败或非对象 → 原样渲染代码块（与 web「其他语言保持代码块」同构）；成功 → `<ChartView option={parsed} />`。高度用 ChartView 默认 220。

### D3 ChartView 三态 testID 化

`state: 'loading'|'ok'|'fallback'`（把原 settled ref 升学成 state，顺便修掉 v1 的降级计时缺陷——`c2afc68f` 已修壳回邮，这里把确认升级为可渲染状态）。容器 `testID=chart-{loading|ok|fallback}`；fallback 分支同时保留码块文本。Maestro 断言= `chart-ok` 可见 且 `chart-fallback` 不存在。

### D4 图表桩=chaos-llm 的 `chart` 模式

控制面 `{mode:"chart", shape:"bar|line|pie|scatter"}`；`/v1/chat/completions`（stream 与 stream:false 都覆盖）返回一条 assistant 文本，内容=对应系列的 ```echarts 围栏（JSON 单行，合法 echarts option）。选择逻辑=读取请求里最后一条 user 消息，含 `line|pie|scatter` 词则对应系列，否则 bar；控制面 shape 优先级更高（供流内切换）。理由是复用既有 chaos 网关的 OpenAI 兼容面与自检模式，不新造服务。

### D5 第二 mock 实例承载图表流（9411 维持 dead-LLM）

charts.yaml 需要"能出图的模型"，chat-stream 流断言"模型死了也必须给错误 UI"——两者对 9411 的期望互斥。故 charts 腿起第二个 mock（9412，`LLM_BASE_URL=http://127.0.0.1:3288/v1`），charts.yaml 以 `clearState` 清态后对 9412 重新配对（复用 pairing 流的 testID 手法）。`clearState` 在 iOS 模拟器的支持不稳，charts 腿先在 android 落地；iOS 腿同步接入但以 android 证据为准（dispatch 月频）。

### D6 移动验收轨的调度形态：arm-ready 双触发

- **可立即用**：池侧 `app-e2e.yml` 桩（池 main，dispatch-only）+ `--ref` 侧分支快照（今日已建制）。
- **可排程**：私仓新增 `nonweb-daily.yml`——每日定时在 ubuntu 上做快照推送+池 dispatch（快照与 dispatch 合计约 1-2 分钟私仓分钟），**secret `BUILD_POOL_TOKEN` 缺失时该 job 直接 skip**（`if: env.TOKEN != ''` 经 env 间接判断）。用户铸一枚对 `testaction00x/build-pool` 有 contents:write 的 PAT 塞进私仓 secret 即自动生效。
- 备选「池仓直接 checkout 私仓」被否：池仓无私仓读 PAT，且私仓源码进池 runner 工作区不如快照有明确边界。

### D7 桌面 installer-e2e 挂 release.yml 的 windows 腿

`installer-e2e`（needs: build；windows-latest）：下载本 tag exe → `/S` 静默装 → 断言安装目录存在 → 以 bundled `node.exe` 直启 `resources/app/supervisor/steward-main.js`（`PLATFORM_DATA_DIR` 指向 tmp）→ 等 `steward.json` → 启动 app → 轮询 `main.log` 出现 `ATTACHED to steward` → 杀 app → 断言 steward 进程仍在且 `127.0.0.1:<status 端口>/api/ready` 200 → 杀 steward → 以死 pid 写 `steward.json` → 再启 app → 断言 `stale steward discovery removed` 且 embedded ready 200 → 卸载断言（NSIS 卸载器出清）。mac 腿（input `installer_e2e_mac`，默认 false）同样本但起停走 dmg 挂载+直启，不做 launchctl。

### D8 分钟预算

移动验收轨一次 ≈ gates 2.3 + apk 23.7 + Maestro(四流+图表流) ~8-10 = **~35 池分钟**；桌面 installer-e2e windows 腿 ~6-8 分钟（×2 billing ≈ 14）；mac 腿可选 ×10。每日移动轨一个月 ≈ 1050 池分钟，独占一个池账号（testaction004）即可长期成立。

## Risks / Trade-offs

- [echarts CDN 在 runner 不可达] → ChartView 壳已有 `window.__fail` 降级；Maestro 断言会翻 `chart-fallback` → 红灯暴露 CDN 依赖，这正是 v1.x「vendored 离线副本」硬化路径的触发条件。首跑若红，改由 mock 静态托管 echarts.min.js 并换 `src`。
- [`clearState` 在两平台行为差异] → charts 腿先 android 落地；iOS 腿若 `clearState` 不可用则退化为「设置页解绑→重配对」或该腿仅跑非图表流。
- [steward 直启路径覆盖不到 LaunchAgent 安装器] → 注册正确性用 installPlan 输出断言（plist 内容/schtasks 参数）单独测；真实登录拉起留人工抽检，已在 Non-Goals 声明。
- [排程 secret 缺失时静默 skip 会被误读为"自动化已开"] → workflow 完成摘要里打印 `SKIPPED: BUILD_POOL_TOKEN missing`，台账同记。
- [模拟器 GPU 差异] → 断言的是「echarts 成功落定」不是像素；物理机眼见保留季度抽检。

## Open Questions

- iOS 腿的 `clearState` 行为首跑后再定（不影响 android 主干）。
- 生产配对自清钩子（DELETE binding）是否纳入下一棒——与 device-pairing-auth 的调用方一起议。