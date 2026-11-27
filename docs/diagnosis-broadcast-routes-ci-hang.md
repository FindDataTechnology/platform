# CI 挂起诊断：test-broadcast-routes.mjs（shard 2/8，>180s）

**归属**：`test-broadcast-routes.mjs` 是 `shichengsi` 在途诊断中的文件（c7a2afbea 加心跳 / cd7ef7b9b 去连接池 / 50529d8ee 原文）。本记录只固定证据，不改该文件。

**日期**：2026-11-28（CI run `46053882516`，公开仓 `a6eba8a7d`）

## 现象（精确）

```
[unit-shard] ▶ scripts/test-broadcast-routes.mjs
✔ ... 前 10 条全绿 ...                     ← 停在 receipt without a cell id
[unit-shard] ↻ 未自行退出（用例可能全绿但进程挂着）——加 --test-force-exit 重跑
✔ ... 同样 10 条再次全绿 ...               ← --test-force-exit 也救不了
[unit-shard] ✖ 超时（>180s，已杀掉）
```

- 本地：`17/17 pass, 349ms, real 0.42s` —— **完全正常退出**。
- CI：只跑到第 10 条，第 11 条 `a null center (ledger unavailable) answers 503` 之后再无输出。

## 已排除

| 假设 | 证据 |
|---|---|
| 同步阻塞（死循环） | 心跳 `setInterval(...).unref()` 一条都没打印 —— 但注意：**心跳走 stderr，runner 可能只透传 test reporter 的行**，所以这条证据不可靠，不能用它排除同步阻塞 |
| 连接池复用 socket | cd7ef7b9b 已改成 `agent:false` + 5s 超时，仍挂 —— 不是它 |
| 用例逻辑错 | 本地 17/17 绿，且两条失败都在「用例之外」 |

## 最可能根因

第 11 条是**唯一用 `boot(t, null)` 的用例**（其余传真实 center）。`boot()` 里的清理是：

```js
t.after(() => { server.closeAllConnections?.(); server.close(); });
```

`center=null` 分支下若 `registerBroadcastRoutes` 在 `t.after` 注册**之前**就抛出或提前 return，server 已 listen 但**没有被任何人关闭** —— 本地因 socket 早已空闲而被 GC/进程退出兜住，CI 上 keep-alive socket 保持事件循环存活，进程永不退出。这与文件里 2026-11-25 那条注释描述的形态一致（`server.close()` 留下 keep-alive socket）。

## 建议（给属主，不是本会话执行）

1. 把 `boot()` 改成 **先注册 `t.after`、再 listen**，或在 `center=null` 分支里显式 `server.closeAllConnections()`；
2. 让 `boot()` 返回的 server 恒可被 teardown —— 用 `try/finally` 包住 `registerBroadcastRoutes`；
3. 心跳改打到 **stdout 或 test reporter**（`t.diagnostic()`），否则心跳证据在 CI 日志里看不到，等于白加；
4. 若属主暂不修：把该文件从分片 manifest 里**单独**跑并允许 skip，别让它连坐杀掉同分片后半段（本次它之后还有 `test-builder-face-gate` 等文件被延迟）。

## 影响面

它挂在 shard 2/8 的第 10↔11 条之间，导致该分片报 `失败 1，超时 1`；同分片其后文件仍继续跑（runner 有 per-file 隔离），但整分片记红。**与本会话的 change 无关**（本会话文件分布在 shard 1/3/4/6/7，均绿）。