# design

## D1 · 会话即边界，不造身份

scope key = sha256(sessionId) 前 32 hex。车道侧的 context id（`wx:chat-<idem 派生>`）
在同会话内稳定 → 同一访客的连续对话看到自己的事项；跨会话即隔离。不引入访客表、
不跨会话关联——强身份是 IdP 议题，v2 只做边界。

## D2 · scope 的供给方是 runner，不是 child

child 的工具调用不带会话概念（bot_notify 同型）；manager 在 turn 生命周期内记
childKey→sessionId（单写者：一 child 同时至多一回合，天然无竞态），onMatter 闭包读
之。非回合期的 matter 调用（防御路径）落无界 + 审计行注明 no-session——绝不因取不
到 scope 而拒开（转人工出口不能被边界闸堵死）。

## D3 · 过滤在平台，语义一处定义

internal list/read 路由接收 `visitor_scope` 查询参数（服务凭据信道不变），
SQL 过滤 `(scope_key IS NULL OR scope_key = ?)`；open 接 body `visitor_scope`。
主人路由不过滤。无界存量行全员可见=兼容承诺，主人可关闭清理。

## D4 · 兼容与迁移

matters 表 ALTER ADD COLUMN scope_key TEXT（try/catch——老库已建表）。v1 行
scope 为 NULL。gateway/runner 同镜像同滚（过滤在 gateway、供给在 runner，分开滚
会出现「新 runner 送 scope、老 gateway 忽略」无害窗与反向无害窗，皆安全）。
