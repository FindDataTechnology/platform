# line-proxy-lane Specification

## Purpose
规定车道 `/api/lines/<line>/proxy/*` 的**转发面**必须让 MCP 会话协议头双向通过，
同时坚持「只放协议头、不整体透传调用方头」这条边界。本 spec 只管转发面的头；
换票、身份判定、`503 upstream_unresolved` 这些承诺不在本 spec 内。

## Requirements

### Requirement: MCP 会话头 MUST 双向通过

车道 SHALL 在上行请求上转发 `mcp-session-id`、`mcp-protocol-version`、`last-event-id`
（若调用方带了），并在下行响应上回抄 `mcp-session-id`、`mcp-protocol-version`（若上游发了）。
这些头是 streamable-http 会话握手的一部分，缺任一方向都会让客户端停在握手之后。

#### Scenario: 上游在 initialize 上发会话 id

- **WHEN** 上游对 `initialize` 返回 `200` 且带 `mcp-session-id` 响应头
- **THEN** 车道 SHALL 把该头回抄给调用方
- **THEN** 它 MUST NOT 只回抄 `x-fd-line` 与 `content-type` 就结束

#### Scenario: 调用方带会话 id 继续请求

- **WHEN** 调用方在后续 `tools/call` 请求上带 `mcp-session-id` 请求头
- **THEN** 车道 SHALL 把该头转发给上游
- **THEN** 上游因此返回的结果 MUST NOT 变成车道的 `400 Missing session ID`

#### Scenario: SSE 响应同样要带会话头

- **WHEN** 上游以 `text/event-stream` 返回并同时带 `mcp-session-id`
- **THEN** 该头 MUST 在开始推送事件体**之前**就发给调用方
- **THEN** 流式分支结束时应留下一条成功日志（否则「流成功」与「请求没进来」同形）

### Requirement: 只放行协议头，不整体透传

车道 SHALL 只转发上面那份白名单里的协议头。
MUST NOT 把调用方的 `cookie`、`x-forwarded-*`、网关身份头或任意未列名头带到上游——
上游本来就该只看到「这条线的票 + 这条请求的正文」。

#### Scenario: 调用方带 Cookie 与网关身份头

- **WHEN** 调用方请求里带 `cookie` 与 `x-forwarded-email`
- **THEN** 上游收到的请求 MUST NOT 含这两个头
- **THEN** 白名单里的协议头 MUST 仍然被转发（两条判据同时成立才算通过）

#### Scenario: 上游回了未列名的头

- **WHEN** 上游响应里带 `set-cookie` 之类未列名的头
- **THEN** 车道 MUST NOT 把它回抄给调用方
- **THEN** `x-fd-line` 与协议头仍 MUST 正常下发
