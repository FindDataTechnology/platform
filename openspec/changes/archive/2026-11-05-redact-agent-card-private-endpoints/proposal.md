# Proposal: redact-agent-card-private-endpoints (paas)

## Why

孪生半边仍在产：platform 域名（`platform.finddatatech.cloud`）的公开 agent card 由 `gateway/wanxing/a2a.js` 的 `publicCard()` 序列化，与 fd-wanxing 门面同漏——生产实证（2026-11-05）卡片携带 `"provider":{"url":"http://100.64.0.8"}`（tailnet 内网 runner 地址）。只修 fd-wanxing 不修此半边，则 platform 域名泄漏面原样保留。

## What Changes

- `gateway/wanxing/a2a.js` 的 `publicCard()`：与 fd-wanxing 同口径的 provider 红敏器——`provider.url` 指向非公网可路由地址（RFC1918、CGNAT 100.64/10、loopback、link-local、单标号、`.svc`/`.cluster.local`/`.local`/`.internal` 后缀）或不可解析时剔除 `url` 键；其余字段与公网 URL 原样。
- `scripts/test-wanxing-facade.mjs`（paas 版）补同三态测试。

## Capabilities (scope)

- Modified capability: `wanxing-facade`（paas 半边 serving 面）— 公开卡片内部地址红敏。
- Out of scope: gateway 其余面；registry 源数据治理；facade 真源半边在 fd-wanxing 仓同名单独立案。
