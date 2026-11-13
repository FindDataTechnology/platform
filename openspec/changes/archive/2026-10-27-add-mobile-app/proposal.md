# add-mobile-app

## Why

壹座通用客户端计划（ADR-0020、词汇表"通用客户端/设备配对"）的服务器侧已完成并归档（add-device-pairing-auth：`/api/app/*` 配对端点、capabilities 通告、web 设备管理）。本 change 交付 App 本体——安卓/iOS 的官方移动客户端，连接任意自建壹座实例，让开源用户和云用户在手机上获得超出小程序限制的移动体验（无包体上限、无平台审核约束、可后台续连）。全部产品决策已于 2026-10-09 grill 定案（Expo/RN、v1 范围、视觉、分发路线）。

## What Changes

- 新建 `app/` 目录：Expo（managed workflow + expo-router）React Native 客户端，与 web/miniapp 并列，`file:` 依赖复用 `@platform/core`（configureHttp/WsClient 的注入式 transport 与 socket factory 零改动接 RN）
- 底部三 Tab 信息架构：**对话 / 定时任务 / 资源库**；配对页、分享页、设置页为流程页
- 登录 = 设备配对（消费已上线端点）：首启填实例地址 + 扫码/输绑定码 → Ed25519 密钥对（SecureStore）→ pair；启动静默挑战换发；401 binding_required 重回配对页
- v1 功能对齐小程序 6 页（chat/cron/resources/share/login/bind-guide）+ 设置页（第 7 面：语言、实例地址与状态、解绑换实例、关于）：流式聊天（WS 契约同 web）、会话历史、模型/角色选择、问询卡、产物条带、分享只读视图
- 图表渲染：受控 WebView 内嵌 echarts 吃 option JSON（保留"失败→原始代码块"降级契约）；Markdown 用 RN 渲染器复用 core 解析约定
- 中英双语（i18next，复用 web 词条资产中可移植部分）；浅色 only；连接能力探测按"永远能连上，只是少功能"降级
- 交付管线：EAS Build 出 iOS+Android 包；Maestro e2e 走 GHA；GitHub Releases APK + TestFlight 为 v1 alpha 渠道
- 不做（全部明确后置 v1.x）：离线推送、本地通知、OTA、深链、官方实例快捷入口、双主题、多工作区、iPad 专属布局

## Capabilities

### New Capabilities

- `mobile-app`: 壹座通用客户端——设备配对登录与实例连接、三 Tab 主干、WS 聊天全链（含 AppState 生命周期重连+resync）、RN 侧 Markdown/图表渲染契约、问询卡/产物/分享对齐、设置页实例管理、中英双语与能力探测降级。

### Modified Capabilities

（无——服务器侧能力已在 add-device-pairing-auth 落定，本 change 纯客户端消费）

## Impact

- **新增**：`app/`（Expo 工程：expo-router、@noble/curves、expo-secure-store、expo-crypto、i18next、RN markdown/webview 渲染件）、`.github/workflows/` 增 Maestro e2e 作业、开源快照管线纳入 app/ 目录
- **复用零改动**：`@platform/core`（WS 客户端/REST/chat store/图表围栏解析均为注入式设计）
- **消费**：`/api/app/*`（pair/challenge/login/devices/revoke）、`/api/mp/bindcode`（铸码语义已在 QR 载荷）、`/api/config` capabilities、既有 WS+REST 契约
- **不触碰**：web、miniapp、gateway、server（共享模块不动；App 只作新客户端接入）
- **分发前置**：Apple 开发者账号（用户行动项）、EAS 账号接线、APK 签名密钥（EAS 托管）
