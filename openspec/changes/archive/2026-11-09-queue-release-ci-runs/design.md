## Context

见 `proposal.md`。约束来自实测：

- 出片车间的 CI 单测约 26 分钟（`scripts/test-*.mjs` 4111 条，`--test-concurrency=1`）。
- 同一 `main` 上多个会话各自 force-push 快照，间隔可短到几分钟。
- 今天四次取消**全部**落在单测窗口内（最后一次是第 26 分钟）。

## Goals / Non-Goals

**Goals**：任何一次推送的 CI 都能跑完；取消不再是常态；代价（排队等待）显式且可预期。

**Non-Goals**：不缩短单测时间（另一件事：`--test-concurrency` 与慢用例）；不改触发条件；不动 lint/typecheck 门。

## Decisions

### D1 排队而非取消

`cancel-in-progress: false`，concurrency 组保留（按 ref）。

- 为什么：这条 CI 的语义是"给这一片出一个可信结论"，而取消把结论换成了"没结论"。在多人并行的工作区里，取消的是**先提交的那个人**——惩罚错了对象。
- 替代（否）：缩短单测让窗口变小——治的是概率，不是机制；且要动 4111 条用例的组织方式。

### D2 image 也排队

镜像构建中途被掐会留下半完成的 tag，比等待更糟；它和 CI 是不同组，本来不互相取消，但自己组内互掐同样要防。

### D3 取消仍然允许"人工发起"

`workflow_dispatch` 之外，真需要掐断时由人点取消——这不受 `cancel-in-progress` 影响，闸不该剥夺人的最终决定权。

## Risks / Trade-offs

- [排队会把反馈延迟到 30–40 分钟] → 显式写进 `DEPLOY.md` 与 workflow 注释；急事用 `workflow_dispatch` 单独触一次，不靠连推。
- [有人一次推多个快照，浪费时间] → 排队本身会让"连推"变得昂贵，这是正确信号：出片前先把要带的提交凑齐。
- [GitHub 队列有上限] → 同 ref 一般 1–2 个在跑/在排，远不到上限；真遇到时旧 run 会自己结束。

## Migration Plan

改两行 + 注释，随下一次快照生效（快照从本仓 `.github/` 复制）。回滚：改回 `true`。

## Open Questions

- 单测 26 分钟本身是否该并行化（`--test-concurrency` 提到 2–4 + 用例隔离）：那是独立议题，与排队策略无关。
