# fix-unit-lane-web-dist-assertion

## Why

`scripts/test-cell-gateway.mjs` 断言「匿名访问 `/` 拿到 200 + SPA 壳」，而壳来自
`gateway/index.js:346` 的 `res.sendFile(web/dist/index.html)`。

**unit 车道永远没有 `web/dist`**：`ci.yml` 用 `PLATFORM_SKIP_WEB_BUILD=1` 装依赖，
真正的 `web:build:e2e` 排在本车道**之后**。所以这条断言让该文件在 unit 里**恒红**——
本机实测（dist 缺失）连跑 3 次全红，抛的正是
`anonymous browsers get the SPA shell`。

它不是"某个环境特殊"：同一条代码路径、同一个缺失产物。它之所以没被发现，是因为
unit 车道最近根本走不到这一步（lint 先红、随后被作业上限砍），所以这个红一直被埋着。

## What Changes

把断言拆成**两个环境都成立**的那一条，加上**只在产物存在时**才做的严格检查：

- 恒成立：匿名 HTML 请求**不得**被身份兜底劫持成 302 跳到托管 Logto 页——这才是
  `add-login-hero 6.2` 要守的边界（"从'重定向每个页面'改成'绝不触达 cell'"）。
- 有 `web/dist/index.html` 时（镜像、e2e 车道）：再断言 200 与 `<!doctype html`。

## Capabilities

（无 —— 只改测试对构建产物的依赖方式，无产品行为变更。）

## 已知未解（本单不修，留给对应所有者）

放开上面那条断言后，同一文件**暴露出更深一层的红**（此前被它挡住，从未跑到底）：

```
AssertionError: the restarted cell must sync its session list over the proxied WebSocket
scripts/test-cell-gateway.mjs:304
```

流程是 SIGKILL cell → 等 error（30s）→ 重连 WS → 等 running（30s）→ 等 `sessions` 帧（10s），
实测耗时 57–99s 后失败。**与本次改动无关**（改的是更早的一条断言，且不触达 cell 启动/WS），
但 unit 车道要真正变绿必须先解它。需要 cell 启动方向的所有者看：是本机 dsh 环境差异，
还是 `be083e4b0` / 之后某次 gateway 改动的真回归。

## 验证

- 改后该文件不再卡在壳断言上（实测直接推进到 304 行那条）。
- `biome check` 无告警。
