# 内部桥接的身份判据：回环 + 无代理身份（审计 N-2/N-4 派生）

## Why

`auth` spec 的「Trust boundary and scope」早就写着一条：**真人经回环网关转发的
请求 SHALL 保有自己的身份**。代码没做到——十个内部桥接里有八个只查了源地址：

```js
// 修前（server/auth.js，八个桥接同形）
const isInternalActionsBridge = (req) =>
  req.method === "POST" && req.path === "/api/actions/propose" &&
  isLoopback(req.socket?.remoteAddress);
```

而托管模式下网关**把每个真人都从 127.0.0.1 送进 cell**，并注入
`x-forwarded-email`（`gateway/index.js:1107` + `gateway/proxy.js:59`）。于是回环
地址根本分不开「cell 自己的子进程」和「cell 的主人」。

两处路径今天就有真人走：
- `POST /api/cron/:taskId/run` — 集群抽屉的「立即执行」（`web/src/components/fleet/InspectorDrawer.tsx:220`）
- `POST /api/actions/propose` — 看板提案（`web/src/pages/BoardsPage.tsx:316`）

第二条不只是日志脏：`server/routes/actions.js:157` 的 `resolveProposerEmail` 对
`req.user.internal` **直接信任 body 里的 `proposerEmail`**。实测（HEAD worktree
反证）：带合法网关身份头的真人打 `/api/actions/propose`，被盖章
`{"email":"actions-bridge@internal","internal":true}` —— 于是可以**以任意地址的名义
提案**。领域上这是冒充面（提案的审批人等于提案人，受害者会看到别人代他发起的待审提案）。

修法不用发明新东西：已上产的两个演化桥接（skill-evolution / persona-evolution）
本来就是对的，注释也把原因写清了——「网关把主人的请求也从回环送进来、总带
`x-forwarded-email`，所以缺头才是子进程的判据」。本单把这半个判据扶正为**唯一**
判据。

## What Changes

- `server/auth.js`：十个桥接 predicate 收成一张表（`INTERNAL_BRIDGES`）+ 单一判定
  `isInternalChild(req) = isLoopback(源地址) && !req.headers["x-forwarded-email"]`，
  导出 `internalBridgeEmail(req)` 供测试直打（含非回环地址这种 HTTP 测不出来的形状）。
  十个桥接的身份、路径、作用域与「服务端归属」理由都留在表里。
- `scripts/test-auth-bridges.mjs`（新）：表级四组（子进程仍过、真人不过、非回环不过、
  verb 作用域仍成立）+ 过真闸三组（真人保身份 200、无头子进程仍盖章、伪造身份头无密钥
  仍 401）。
- `auth` spec「Trust boundary and scope」回写：把判据写成两半（地址 + 无代理身份），
  补「真人走桥接路径保自己身份」的场景，并修掉三处与现势矛盾的绝对化条款——logto 模式
  下平台**确有**签名会话 cookie（R1 要求它）、确有按代理身份邮箱为键的偏好行
  （`user_model_bindings`/`user_mcp_bindings`/`user_registry_credentials`），多用户隔离
  是 `tenant-cell-runtime` 的机制。真正该守的是「没有本地口令、没有平台自建账号生命周期」。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `auth`：「Trust boundary and scope」按代码实况与既有意图回写，补一条回归场景。

## Impact

- 代码：`server/auth.js`（一个表 + 一个判定，替换十个 predicate 与五处内联 if）。
- 测试：`scripts/test-auth-bridges.mjs`（7 条），随 `test:unit` 进 CI。
- 行为变化只在托管模式且只对**带身份头的回环请求**：它们不再被盖内部身份，改为按网关
  身份通过。子进程（不带身份头）行为逐字节不变；单机/开发模式不变。
- 已跑的回归：auth-mode / cell-auth-paths / builder-author-bridges / agent-notify-bridge
  / cell-gateway / cell-bindings / cell-containment / cell-isolation 全绿。
- 遗留（另单）：`forward-auth` spec 的「信任边界台账」还停在 ~10/23 条，本单只收口桥接这一类。
