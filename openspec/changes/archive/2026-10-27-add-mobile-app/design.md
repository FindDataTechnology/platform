# add-mobile-app — Design

## Context

决策已由 2026-10-09 grill 定案（本 change 前置探索），服务器契约已上线（add-device-pairing-auth 归档）。关键既有事实：`@platform/core` 的 `configureHttp`（transport 可注入）与 `WsClient`（SocketFactory 可注入）是"纯 TS 无 DOM"设计——RN 的 `fetch` 与全局 `WebSocket` 直接喂入，core 零改动；小程序 6 页 + 11 个组件是翻译底稿（chat/index.tsx 782 行）；web 的 i18next 资产五语言，App 取中英两份并补 App 特有文案。

## Goals / Non-Goals

**Goals:**

- `app/` 目录进 paas 仓，miniapp 同款 `file:` 依赖模式接 core
- 对齐小程序的聊天主链一次到位（含问询卡/产物条带/折叠组），v1 alpha 能真机自用
- 构建与测试管线自足可复现（EAS 出包、Maestro e2e 走 GHA）

**Non-Goals:**

- 服务器任何改动；web/miniapp 任何改动；多工作区、深链、推送、OTA、双主题、iPad 布局（全部 v1.x）；App Store 正式上架与中国区备案（v1 alpha = APK + TestFlight）

## Decisions

### D1: Expo managed + expo-router，CNG（continuous native generation）

managed workflow + `expo prebuild` 生成原生壳；不 bare 不锁原生文件。expo-router 声明式路由：`(tabs)/chat|cron|resources` 三 Tab + `pair`、`share`、`settings` 流程页。**替代**（bare RN + react-navigation）被否：自持原生工程违背"源码可自编译"的开源自足目标；**替代**（Taro RN 目标）在探索期已否（样式双运行时坑深）。

### D2: 依赖矩阵（最小面）

- `@noble/curves`（Ed25519 纯 JS，与服务器 RFC 8032 固定向量互证）+ `expo-secure-store`（Keychain/Keystore 存私钥）
- `expo-crypto`（随机）+ `expo-camera`（扫码；permission 被拒时输码路径兜底）
- `react-native-webview`（echarts 宿主：单 HTML 资产打包 echarts.min.js，postMessage 传 option JSON）+ `@dr.pogodin/react-native-markdown`（或同级渲染器，评审时定，验收只认 spec 的降级契约）
- `i18next` + `react-i18next`；zustand（core 已带）
- 不引入：原生图表库、推送 SDK、OTA 更新（expo-updates）、深链插件

### D3: core 注入层 = `app/src/lib/platform.ts` 一处收口

- `configureHttp({ baseUrl, transport: fetch, tokenProvider })`——token 从 zustand 持久化 store 读
- `new WsClient({ socketFactory: (url) => new WebSocket(url) })`——RN 全局 WebSocket 直用
- AppState（active/background）→ WsClient 重连 + chat-store resync；token 过期先走一次静默挑战换发再报错
- **这是唯一允许 import core 的桥层**；页面组件只消费 store 与封装好的 hooks，方便未来鸿蒙/其它壳复用

### D4: 设备身份与配对客户端

- 首启生成 64-bit hex `deviceId`（`expo-crypto`）+ Ed25519 keypair；私钥/`deviceId`/实例地址/token 入 SecureStore + zustand persist（非敏感的地址/语言入普通持久化）
- 扫码解析规则与 MP 登录页同构：URL 带 `bindcode=<6 digits>` → 取 origin 为实例地址 + code；裸 6 位 → 已填地址后兑码
- 401 binding_required → 清配对态回配对页（文案区分"被撤销"与"首次"由服务器同形契约决定：不区分，统一重配引导）

### D5: 图表 = 受控 WebView 池化渲染

单例 `ChartWebView` 组件：assets 内置 echarts.min.js 的 HTML 壳，`postMessage` 传 option JSON + 高度回传自适应；同一会话内图表复用同一 webview 实例序列化渲染（内存上界）。失败（超时/异常回执）→ 原样降级代码块。资源页预览复用同组件。

### D6: i18n 资产策略

`app/src/i18n/`：`zh-CN.json` + `en.json` 两份，结构与 web 的 `settings.*` 等可移植键对齐（直接拷贝 chat/cron/resources 相关键），App 特有键（配对/实例/设置）新写；`i18next` 检测系统语言为初值。**替代**（运行时拉实例词条）后置 v1.x——实例侧无此契约。

### D7: 构建、测试、发布管线

- **EAS Build**（FindData expo org）：`release` profile 出 signed APK + iOS archive；开源用户 `expo prebuild && npx react-native run-android` 自编译文档化
- **Maestro e2e**（`.maestro/` flows）：配对（mock 实例）、聊天流（真服务器 + dead-LLM 模式）、Tab 导航、设置语言切换；GHA `app-e2e.yml` 用 macOS runner 跑 iOS 模拟器流 + linux 跑 android 流（账单阻断期走公开仓通道触发）
- **发布**：GitHub Releases 挂 APK（tag `app-v0.1.x`）；TestFlight 由 EAS Submit 上传
- CI 门禁排序：`app lint/typecheck（tsc）→ unit（pairing client 与注入层单测）→ Maestro（android）`，iOS e2e 仅 nightly

### D8: 仓库与快照管线落位

- `app/` 整目录进快照（make-public-snapshot 无需改排除表；`app/node_modules` 天然被 git 忽略；EAS 凭证不入仓）
- 根 `package.json` 增加 `app:install`/`app:typecheck` scripts（web 同款模式）；不开 monorepo workspace（维持各端自装惯例）

## Risks / Trade-offs

- [Expo SDK 版本与 RN 生态漂移] → 锁 Expo SDK 单一版本（.x-service 版本），升级走独立小 change
- [WebView 图表内存/滚动性能] → D5 池化 + 高度自适应 + 失败降级；真机验收在 5.x 任务
- [Maestro iOS 流水线成本/稳定性] → v1 以 android 流为门禁，iOS nightly 观察窗
- [扫码权限被拒] → 输码路径是规格内一等公民，非降级
- [服务器侧变更破坏在野 App] → capabilities 探测 + "永远能连上"哲学；线协议（配对/挑战）由 ADR-0020 锁定不可破坏性变更

## Migration Plan

纯新增目录与工作流，零存量面改动；部署顺序无约束。回滚 = 删目录。发布循环：EAS build → 内部真机冒烟（配对+一轮对话）→ APK Release + TestFlight。

## Open Questions

（无——全部决策已在前置 grill 定案；图表 RN 渲染器的具体选型在实现 4.x 时按验收契约定，不影响 spec/tasks 结构）
