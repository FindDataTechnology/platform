# fix-persistence-flush-teardown-race

## Why

`scripts/test-queue-supersede.mjs` 会**偶发地在「所有用例都通过」的情况下把整个文件判红**。
2026-11-10 单独跑三次，第三次红：

```
ok 1..7            ← 七条用例全绿
# Error: A resource generated asynchronous activity after the test ended …
#        "Error: ENOENT: … jobs.json.85415.c7f58e52.tmp"
#        which triggered an unhandledRejection event
not ok 1 - scripts/test-queue-supersede.mjs
```

**这不是测试写错，是写入库的语义漏洞**。`lib/persistence.js:atomicWriteText` 的契约是
「落盘失败只在丢了那次写时告警，绝不把异常抛给调用方」（原注释已这么写），但它只对
**rename 这一步**做了 ENOENT 兜底：

- 目录在 `mkdirSync` 与 `open` 之间被删掉（store teardown / reset 与排队的 flush 竞态）
  → `open(tmp,"w")` 抛 ENOENT → 拒绝逃逸 → 调用方若 fire-and-forget，就是
  `unhandledRejection` → node 测试器把**文件**判红，尽管每条用例都过了。

后果比"一条测试不稳"重：它和 CI 里"作业被砍"同属一类**假红**——报告上写着失败，
实际产品没坏，而排查者会先去怀疑产品（本仓 2026-11-09 已因此误判两次）。

同一病根在 `scripts/test-queue-health.mjs:54` 留过一条**绕过式**注释：那里改成"只删
store 文件、不删目录"来躲开 rename ENOENT。绕得对，但把根因留在了库里。

## What Changes

`atomicWriteText` 的 flush 里**任何一步**的 ENOENT 都归一为「这次写丢了」：告警、清理临时
文件、返回；非 ENOENT 照常抛。

**不做 retry + mkdirSync 重建目录**——这是先试过的错解，实测更糟：目录是*所有者*删的
（teardown/reset），重建它等于把它复活，所有者随后的递归删除就会 `ENOTEMPTY` 失败
（同一文件，8 次里挂 1 次）。删掉的数据目录不该由写库替它重建。

## Capabilities

（无 —— 修复的是共享持久化助手的失败语义，无产品行为变更。）

## 非目标

- 不动 `atomicWriteTextSync` / `writeViaTemp`：同步变体是同步抛错，不会变成
  unhandledRejection，语义本身正确。
- 不改 `scripts/test-queue-health.mjs` 的既有绕法：它现在仍是对的（不删目录更稳），
  只是不再是*唯一*的防线。

## 验证

- `scripts/test-persistence.mjs` 新增 3 条：open 腿 ENOENT 只告警不抛且不留残渣；
  rename 腿同语义；非 ENOENT（EACCES）照常抛。
- **反向验证**：把 `lib/persistence.js` 换回 HEAD 版本，新用例里 4 号必红——证明它钉的是
  真缺陷，不是自证。
- `test-queue-supersede.mjs` 连跑 15 次：15 绿（修复前 3 次挂 1 次）。
- 24 文件 spawn 样本并发 8：131/131 绿（修复前同一并发下 1 红）。
