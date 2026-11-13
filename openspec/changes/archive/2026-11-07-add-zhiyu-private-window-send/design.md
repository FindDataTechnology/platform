# Design: add-zhiyu-private-window-send

## D1 · 形状：一条端点 + 一个 mode，零 schema 变更

`POST /api/zhiyu/rooms/:id/private`（`gateway/zhiyu/index.js`）：

```
authorize(req) → active user seat 要求（沿用 POST /messages 的闸）
分身在席检查：membersOf 里 kind=facade && onBehalfOf=user.email && state=active
  └ 缺席 → 409 { error: "值守分身未在场……" }（吩咐行不落库）
store.messageAppend({ kind:"human", senderMemberId: myUser.id, content,
                      visibility: `private:${myUser.id}` })
路由器 dispatchPrivateTurn({ room, sender: myUser, message })  → fire-and-forget
res 200 { message }
```

路由器（`room-router.js`）新增 `dispatchPrivateTurn`：定向 `runTurn` 到该成员的 facade，`mode: "private"`；`runTurn` 的应答行加 `visibility: mode === "private" ? \`private:${sender.id}\` : "shared"`（memberId 取发起者 user id——应答与吩咐同窗）。事件行（busy/pass/失败）在 private 模式下同样 private 档——不进共享流。

## D2 · 口径边界

- **不计入广播口径**：private 模式不经过 `targetsFor`/广播征询/@解析——直接单目标。reply_cap（每次人类消息的应答数上限）针对空间广播轮；私窗一问一答天然为 1，不占 cap。
- **日预算闸照常**：`roomConsumeTurnBudget` 照常计数（房间开销口径），预算触顶时 `budget_exhausted` 事件行也落 private 档。
- **计费照常**：`settleTurn(target, { usageId: ... + "-private" })`——部署键结算 + 归因尾缀（guest 的 `-guest` 先例）。
- **pass 处理**：分身 pass → private 档 pass 事件（对 owner 可见的如实呈现）。

## D3 · 前端

私窗抽屉（`ZhiyuRoomPage.tsx` `zhiyu-private-panel`）追加输入区：发送 → `POST /private`；乐观回显不做（服务端行为权威，抽屉随 messages 轮询自然刷新——与共享流同款读路径）。guest 视角不渲染输入区（`myMemberId` 为 guest 席时该端点必然 403）。

## D4 · 测试

`test-zhiyu-rooms.mjs`（或新增独立小套件，沿两用户两座 harness）：
1. 私窗交换：user 发 → human 行 `private:<u>`；facade 应答 → agent 行同档；共享读取面（viewerMemberId=null 及另一成员视角）**均不可见两行**。
2. guest 403：guest seat POST /private → 403。
3. 分身缺席：room 无 active facade → 409 且零落库。
4. 日预算计数：private 回合消耗 dayTurns。
5. usage id 尾缀：settleTurn 收到 `-private` 归因。

## Risks

- 分身缺席的谢绝路径若误落共享行会直接破坏「私窗不外泄」——用例 3 以零落库为硬断言。
- private 行对 SSE overlay 的过滤已有码锚（index.js:815 `ev.visibility` 三元判断），private 模式的 overlay 事件全部带 private visibility 即可复用，零改动。
