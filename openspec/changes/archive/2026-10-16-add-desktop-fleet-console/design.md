# Design: add-desktop-fleet-console

> 前置：切片①（add-desktop-fleet-runner，b3da9ef）。底稿：
> `docs/wanxing-desktop-fleet-plugin-explore.md`。

## D1 数据面=cell 代理，零新凭据

`server/routes/wanxing-fleet.js`（新）：
- `GET /api/wanxing/fleet/live`：服务端 fetch `WANXING_RUNNER_URL||http://127.0.0.1:8790`
  的 `/health`（2s 超时）；连不上=503 `{error:"runner_not_running"}`（页面引导态，
  不是 bug）。runner 与 cell 同机 loopback——不经任何代理链。
- `GET /api/wanxing/fleet/catalog`：以 `AGENT_SERVING_REGISTRY_URL/TOKEN` 代理
  `GET /api/agents?limit=500`，映射为 `{agents:[{path,name,description,version,
  tags}]}`（只读字段，剪掉 metadata 细节）。未配置=503 `{error:"registry_not_configured"}`。
- 两端点挂 cell 标准鉴权（同 tasks.js 的显式非 loopback 豁免形状——本机 runner
  是合法 loopback 消费者之外的调用面，走用户会话）。

## D2 舰队页=桌面精简版

`web/src/pages/FleetPage.tsx`（新）：上区「本机舰队」（live 数据：agents 表——
名称/key、五态徽标、版本、端口、budget 条 `footprint/budgetMb`）；下区「市场目录」
（catalog 卡片：名称/描述/标签）。部署按钮 disabled+tooltip「待设备管理面解锁
（切片③）」。未启用/未运行的引导态文案直接来自 503 error 码。Sidebar `NAV_BASE`
加 `/fleet`（icon: Rocket）+App 路由+i18n 五语（nav.fleet 与页面键）。

## D3 托盘驻留=main 进程三处改动

`electron/main.js`：
1. `window-all-closed` 不再 `app.quit()`——驻留（mac 的 dock 语义本就如此；win/linux
   靠托盘）。`before-quit` 的 drain 逻辑不动。
2. `Tray`（icon=build/icon.png 打包路径解析；nativeImage resize 16px）：菜单
   「显示」（restore+focus，无窗则重开）、「退出」（走既定 stopping 流程：
   supervisor.stop()→app.quit()）。
3. 托盘单击=显示。双实例锁已有。
（打包图标资源经 electron-builder files 已含 build/icon.png——verify-bundle 不动。）

## D4 部署链挪③的依据（安全）

部署动作的现成通道=wanxing console 的 selfservice（x-facet-user+x-facet-token
转发身份）。x-facet-token 是服务间内部凭据：下发到桌面=任何桌面持有者可伪造
任意 email 的转发身份（提权）。正确链路=③设备管理面让本机机位成为 console 的
合法部署目标，桌面市场页届时以用户身份接入。②的目录区先立住浏览面。

## D5 测试与验收

- 单测 `scripts/test-desktop-fleet-console.mjs`：live 透传（stub runner 200/超时
  503）、catalog 代理（stub registry 字段映射/未配置 503）、鉴权门（无会话 401）。
- 验收探针 `scripts/probe-desktop-fleet-console.mjs`：起 stub runner + 真 server
  路由（express app 级）→ live/catalog 两端点数据断言 + 503 两降级态断言。
  浏览器级眼见（FleetPage 渲染）走既有 e2e 通道，与出片同窗补——本切片验收以
  端点数据+单测收口。
