# clarify-zhiyu-guest-failure-copy

## Why

访客侧对"接待席没答上来"只有一句固定话：`agent_failed → 「接待席位暂时出了点问题」`（`ZhiyuEmbedPage.tsx:44`）。而生产实测（演示房，2026-10-30~11-03 共 12 次失败）的真实原因分布是：

| 真实原因 | 次数 | 对访客的真实含义 |
|---|---|---|
| A2A 429 上游限流 | 3 | **忙**，过一会儿再问就好 |
| A2A 502/503 | 2 | **忙/上游抖动**，可重试 |
| A2A 连接错误 | 2 | 同上 |
| A2A 405 | 4 | 配置问题（非访客可解决） |
| agent parked: key-invalid | 1 | 配置失效（非访客可解决） |

也就是说：**8/12 是"忙"，访客却被统一告知"出了点问题"**——一句话把人劝走，而他其实该再问一次。接待台 2.0 的诚实纪律（"答不上会如实说明"）在文案层没有兑现。

## What Changes

- 服务端把"可重试"与"配置/未知"分开，事件名不变（`agent_failed`），但 `meta` 增加 `retryable: true|false`（按 reason 正则归类：429/5xx/timeout/连接错误 = retryable；405/parked/未部署/未知 = 不可重试）。
- 访客侧文案按此分两档：可重试 → 「接待席位正忙，请稍后再问一次」；不可重试 → 保持「接待席位暂时出了点问题」。站内房间页同样按此分档（它渲染的是同一批事件）。
- `meta.reason` **不出现在任何访客可见文案里**（含内部 packId / 上游 URL / 状态码），只进日志与房间页的运维视角。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——`skip_specs: true`。这是文案与归类的实现细化：`zhiyu-room` 只说"失败的智能体 SHALL 给出如实失败标记"，本单让"如实"在可重试性上说真话，不改契约。）

## Impact

- 代码：`gateway/zhiyu/room-router.js`（事件 meta 加 `retryable`）、`web/src/pages/ZhiyuEmbedPage.tsx` + `web/src/pages/ZhiyuRoomPage.tsx`（两档文案）、五语 locale 补词条。
- 测试：单测断言归类函数覆盖六种真实 reason；脚本级断言 meta 带 `retryable`。
- 不改任何状态机、不影响计费、不改变失败重试行为（只是把话说准）。
