# pageset-base/v1 — 壹座 miniapp 底座兼容契约

> change: `add-erp-miniapp-pagesets` tasks 1.1（P0）。本文把「可复用底座层」落名为
> **pageset-base/v1**：四套 ERP 页面集 manifest（finddata 根
> `fd-erp-vertical-templates/templates/supply-chain/pagesets/*/manifest.json`）的
> `base.minBaseContract` 已引用此名，本文是该引用的**内容终裁**——底座最低兼容面、
> 复用边界与版本纪律。底座自身演进仍按 paas 仓 openspec 根治理。

## 1. 契约名与版本

- 契约名：`pageset-base/v1`（major.minor；patch 不锁死，沿 manifest `baseNote` 原文）。
- 声明方式：页面集 manifest 的 `base` 段。字段 schema 见 §2，与四份现行 manifest 逐字段一致
  （P0 落名时四份 manifest 的 base 段已互相一致、且 `minBaseContract` 已写
  `pageset-base/v1`，**finddata 侧 0 diff 回填**——落名即现状的成文，无字段改名）。
- 版本升级：只在**破坏**最低面时升 major/minor（如底座换框架大版本、移除复用页/lib）；
  向后兼容的底座演进（新增页面、lib 内部重构、Daylight token 扩充）不升契约版本。

## 2. manifest `base` 段 schema（v1）

| 字段 | 类型 | v1 语义（与四份 manifest 现行值一致） |
|---|---|---|
| `platform` | string | `壹座 miniapp（paas 仓 paas/miniapp）` |
| `framework` | string | `Taro 4.2.1 + React 18.3`（@platform/core 经 file: 链共享契约层） |
| `designSystem` | string | `Daylight（paas/miniapp/DESIGN.md，The Daylight Pocket）` |
| `minBaseContract` | string | `pageset-base/v1`（本契约名） |
| `reusedBasePages` | string[] | 底座复用页路由：`pages/chat/index`、`pages/login/index`、`pages/bind-guide/index` |
| `reusedBaseLibs` | string[] | 底座复用 lib：`src/lib/bind-scan.ts`、`src/lib/runtime.ts`、`src/lib/taro-http.ts`、`src/lib/taro-socket.ts` |
| `baseNote` | string | 底座演进治理与不锁 patch 的声明 |

## 3. 最低兼容面清单（本仓实地核验）

底座层是**既有代码的成文与组件化，不是重写**（design D1）。v1 最低面：

1. **工程**：Taro 4.2.1 + React 18.3 单工程（`paas/miniapp/package.json`，`@platform/miniapp`）。
2. **登录绑定**：扫码绑定登录——`src/lib/bind-scan.ts`（Taro.scanCode 封装，取消不算失败）、
   `src/lib/bind-qr.ts`、页面 `src/pages/login/`、`src/pages/bind-guide/`；承接 spec
   `mp-bind-guide`/`miniprogram-auth`/`device-pairing-auth`。
3. **运行时层**：`src/lib/runtime.ts`（单 WsClient 生命周期 + token/auth + wsSend）、
   `src/lib/taro-http.ts`（Taro.request 传输，401 静默重登一次）、`src/lib/taro-socket.ts`；
   WS/REST 契约与 web 共享 `packages/core`。
4. **Daylight 设计系统**：`paas/miniapp/DESIGN.md`——纸面底/白卡/唯一 Pocket Blue/闭色板
   （`src/app.css` 字面 hex 闭集，禁新增 hex）/88rpx 触达/rpx 纪律。
5. **确认门**：四段式「提交→服务器确认→拒绝回显→超时兜底」通用组件
   `src/components/ConfirmGate/`（P0 自 cron 页抽出，cron 页回归零变化）。
6. **AI 入口**：底座 chat 面（`src/pages/chat/index`）为 AI 助手主面；各端
   `*-ai-assistant` 页与 chat 面同源取数，禁平行取数路径。

## 4. 页面集宿主规则（v1 附带约束）

- **静态注册 + 运行时守卫**：小程序页面必须静态注册（`src/app.config.ts`），页面集页随包
  编译并按 `pages/<surface>/<page-id 去前缀>` 命名空间追加；「未授权不可见」落在
  **入口渲染（`useVisiblePagesets`）+ 路由守卫（`<PagesetGate>`）**，永不动态装载代码
  （装载/授权实现在 `src/pagesets/`，fail-closed：授权读面未就绪/失败/畸形一律不可见）。
- **无旁路**：页面集全部 REST/WS 必须经 `src/lib/runtime.ts`/`taro-http.ts`/`taro-socket.ts`
  与 `packages/core` 的 http 传输；禁止第二套前端框架、第二套色板、直连后端。
- **服务端逐页校验为准**：端上守卫是体验层隐藏/拦截（spec `erp-pageset-hosting`）。

## 5. 消费方核对清单

新页面集接入（P1-P3 及以后）自查：

- [ ] manifest `base.minBaseContract = "pageset-base/v1"`，base 段字段与 §2 schema 一致；
- [ ] 页面路由入 `src/app.config.ts` 静态注册，并在 `src/pagesets/registry.ts` 登记清单；
- [ ] 每页包 `<PagesetGate pagePath=...>`，页面集首页用 `useVisiblePagesets()` 出入口；
- [ ] confirmGate 页走 `src/components/ConfirmGate/`，禁乐观关闭、超时不假报成功；
- [ ] 样式只用 DESIGN.md 闭色板 hex；网络面 grep 无 runtime/taro-http/taro-socket 旁路。
