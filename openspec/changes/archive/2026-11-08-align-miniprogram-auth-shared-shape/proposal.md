# 对齐小程序身份路径的共享形状（N-3）

## Why

体检 N-3 记「spec 称共享实现，实为两套路由并存」。核实后要分两层说：

- **逻辑层是共享的**（`gateway/mp-auth.js` + `gateway/mp-bindings.js`，单进程侧经 `ctx.mpAuth`/`ctx.mpBindings` 注入同一对模块），spec 的核心承诺成立；
- **展示层是逐字复制的**：绑定码人工页（11 行 HTML + 身份行 + 6 位码 + 「刷新新码」链接）在 `gateway/index.js:336..344` 与 `server/routes/mp.js:33..43` 各存一份，内容完全一致。这是真正会长歪的面——改一处文案/有效期措辞必然漏另一处，而两条腿分别服务于「多租户网关」和「单进程」两种部署形状，漂移只有在对应部署上才会暴露。
- **spec 措辞把「同一套四端点」读成了穷举**：单进程侧另有 `GET /api/mp/command-summary`（属 `add-mp-command-center`），按现文读会被判为越界。

此外两条腿的未认证拒绝路径本来就不同（网关 `resolveUser()` + `rejectUnauthenticated()`；单进程由 `registerAuth` 的 logto 闸在路由之前拦下），这一点只写在 `server/routes/mp.js` 的文件头注释里，spec 未记——spec 却要求「identical request/response contracts」，读者会以为是同一段代码。

## What Changes

- 抽出共享渲染器 `gateway/mp-bind-page.js`（`renderBindCodePage({ code, email })`），两个宿主改为调用它——消除逐字复制面。
- `miniprogram-auth`「The single-process server exposes the mini-program identity endpoints」Requirement 改写：明确共享的是认证/绑定逻辑与绑定码页渲染；路由注册是每宿主一份薄壳，差异仅限未认证拒绝路径；「同样四端点」不是对单进程全部 `/api/mp/*` 的穷举。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `miniprogram-auth`：单进程身份端点 Requirement 的共享形状与边界 MODIFIED。

## Impact

- spec 文本 + 两个宿主的路由注册处 + 一个新共享模块；无 API 契约变化（响应体、状态码、页面外观全部不变），既有 `test-mp-auth` / `test-mp-single-auth` 断言（页面含 6 位码与账号名）应保持全绿。
