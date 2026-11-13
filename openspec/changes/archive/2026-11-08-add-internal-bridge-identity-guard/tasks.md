# 任务：内部桥接身份判据

- [x] 1.1 复核缺陷：网关从回环代理真人并注入身份头（`gateway/index.js:1107`、`gateway/proxy.js:59`），八个桥接只查地址
- [x] 1.2 反证修前行为：HEAD worktree 跑真闸 → 带身份头的真人得到 `actions-bridge@internal` + `internal:true`
- [x] 1.3 修：十个 predicate 收成 `INTERNAL_BRIDGES` 表 + `isInternalChild`（回环 && 无 `x-forwarded-email`），导出 `internalBridgeEmail`
- [x] 1.4 新测 `scripts/test-auth-bridges.mjs`（7 条：表级 4 组 + 过真闸 3 组），全绿
- [x] 1.5 回归：auth-mode / cell-auth-paths / builder-author-bridges / agent-notify-bridge / cell-gateway / cell-bindings / cell-containment / cell-isolation 全绿
- [x] 1.6 `auth` spec「Trust boundary and scope」回写 + 两条新场景
- [x] 1.7 `openspec validate --strict` + 归档 + 提交
