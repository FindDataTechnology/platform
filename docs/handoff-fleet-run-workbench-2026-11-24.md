# 交接：fleet-run-workbench（工作台物理实现，0/27）

**日期**：2026-11-24
**交接自**：完成 `fleet-run-concurrency` 的会话
**上游已完成**：`fleet-run-concurrency` 已归档、已上产、CI 绿

---

## 一句话

配置面已经有了（`concurrency` / `workbench` 两个字段、三层解析、读面四数、worker 池的角色闸），
**缺的是「工作台从哪来」**。缝留在 `server/worker-slots.js:54`，注入点叫
`ctx.workbenchCwdForTask`，目前**没人注入**。

⇒ 现在声明 `workbench: "auto"` 是完全无效的（静默不生效）。这是刻意的 fail-open，
不是 bug。改的时候别把它当 bug 修；要修的是「把实现装上」。

---

## 缝长什么样

```js
// paas/server/worker-slots.js:54
function resolveWorkbenchCwdFor(task, ctx) {
  try {
    if (resolveTaskWorkbench(task) !== "auto") return undefined; // off ⇒ 不覆写 cwd
    const fn = ctx?.workbenchCwdForTask;                          // ← 空的
    if (typeof fn !== "function") return undefined;
    const p = fn(task);
    return typeof p === "string" && p.trim() ? p : undefined;
  } catch { return undefined; }
}
```

调用点已经在 `scheduleNext` 里（`spawnWorker(persona, { workbenchCwd })`，
`fleet-run-concurrency` 的 4.3 做的）。所以下一位要做的是：

1. 写 `lib/run-worktree.js`（tasks 1.1–1.5）；
2. 在 `server.js` 里 `ctx.workbenchCwdForTask = (task) => workbenchFor(task).cwd`。

---

## 27 个 task 的分组与依赖

| 组 | tasks | 依赖 | 备注 |
|---|---|---|---|
| 1 原语 | 1.1–1.5 | 无 | 全新增 `lib/run-worktree.js` |
| 2 接线 | 2.1–2.5 | 1 | 2.1/2.2 的上半已在 4.3 做完；2.5（cell 主链）完全没做 |
| 3 变更摘要 | 3.1–3.4 | 2 | 挂 dsh 内置插件，只需自写持久化 |
| 4 检视面 | 4.1–4.2 | 2 | 扩 `/api/files` 允许根，只读 |
| 5 闸 | 5.1–5.8 | 全部 | 5.1（off 时逐字节不变）是回归门槛 |

---

## 三处已知坑（都是实打实的）

### 1. 磁盘：worktree 首次快照 = 整个工作树
`@deepseek-ai/dsh-workspace-changes` 的 README 明说：无 `.gitignore` 的仓库首快照会写
等于工作树大小的临时空间。**配额（1.5）必须与创建同批上线**，不能留到后面。
生产已两次「单盘余量被吃光触发驱逐」。

### 2. 回收不得阻塞槽位归还
规格写死：`release()` 失败 MUST NOT 阻塞 `worker.busy = false`。反过来会让一次删除
失败冻结整个 worker 池。

### 3. 本机跑不了 build / e2e
这台 Mac 8 GB。`npm run web:build:e2e` 会把 swap 顶到 90% 且跑不完。验证走 GitHub
Actions，但公开仓只跟 gitee/main 快照：

```
node scripts/make-public-snapshot.mjs --ref gitee/main \
     --stack git@github.com:FindDataTechnology/platform.git
node scripts/publish-ci-mirror.mjs
gh run list -R FindDataTechnology/platform --limit 5
```

**绝不用 `--ref HEAD`** —— 工作树里常有别人的在途改动，会一起发进公开仓。
发布前会过泄漏闸（tailnet IP / 内网域名 / harbor 等），闸红就先修再发。

---

## 上下游边界

- **上游（已完成，别动）**：`fleet-run-concurrency` 的配置解析（`server/cron-runner.js`
  的 `resolveTaskConcurrency` / `resolveTaskWorkbench`）、读面（`server/fleet-concurrency-view.js`）、
  worker 池的角色闸、四道写面的交叉闸（并行必须隔离）。
- **下游（不在本 change）**：控制台的可视化（4.2 有 REST 读面即可，UI 可另开）。

---

## 起手建议

先做 **1.1–1.2 + 2.2 + 5.1 + 5.2** 这五条：能跑通「一份运行一份工作台」且
「off 时逐字节不变」，就是最小可验收闭环。3.x（变更摘要）可以独立成第二个 PR——
它是独立价值（每回合改了哪些文件），不依赖工作台本身（无 git 时也会列出文件工具改动）。

---

## 参考

- `paas/openspec/changes/fleet-run-workbench/`（proposal / design / specs / tasks）
- `openspec/changes/archive/2026-11-24-fleet-run-concurrency/`（上游规格）
- `openspec/specs/fleet-queue-fairness/spec.md`（互斥与并行的现行主规格）
