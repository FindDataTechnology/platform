# add-line-credential-renewal

## Why

产品线操作凭据（wire-customer/lex）是短命 Logto ID token（实测 TTL 3600s），续期依赖用户浏览器
的 Logto 会话——但舰队岗位是无人值守 cron 回合，没有浏览器。实跑首日即撞墙：凭据 00:12Z 铸入、
01:13Z 过期，巡线三轮全部 401，直到 platform 重启才恢复（fd-wire `reports/2026-10-24-fleet-live-run.md`
缺陷⑤）。日节奏巡线必然每天撞一次过期。根因在代码：`server/routes/line-credentials.js:174` 把
`offline_access` 显式剔出 scope——服务端续期能力在铸币那一刻就被放弃了。伴生缺陷：凭据重铸后
新 token 到不了运行中的 dsh 子进程（HMR 对 Authorization 头变化不生效，三轮读旧 token）。

## What Changes

- **P1 · 服务端续期**：铸币流追加 `offline_access`，token 响应里的 `refresh_token` 随凭据行
  存储只写不读；续期在服务端完成（refresh grant，rotation 每次落新值），不再需要浏览器。两道
  触发都做：① 每 cron 回合开始前，岗位属主凭据 `exp - now < 30min` 先续再跑（`runCronJobTurn`
  收口处）；② 后台低频巡检（10min interval）扫将到期行。refresh 被拒 → 行标 stale（复用连接卡
  「需重连」语义），回合拿到的是明确未连接态。
- **401 语义改造（伴生必须）**：ID-token 线的 `markInvalid` 从**整行清除**改为「先试一次
  refresh → 失败标 stale」——现有 401 钩子（`server/dsh-events.js:79`）一旦触发会把 refresh
  token 连带删掉，恢复链即断。文档原判「平台拿不到 401 事件」不成立，该钩子已在生产运行，
  接上即成安全网（本轮已烧，下一轮自愈）。
- **P2 · 凭据变更确定性交付**：`dshUpdateMcp` 检测到 Authorization 头值变化时改走
  restart（`server.js:752` 现成路径），空闲即执行、忙则推迟到回合边界；不再信任 HMR 对头值
  变化的交付（现实现无确认信号、800ms settle 纯属猜测，生产已实证失效）。HMR 保留给非凭据
  变化（server 增删）。
- **工具岗（T1）零改动受益**：`tool-turn.js:80` 本就服务端现读 DB，续期落库即生效。

### 不做

- 不改 wire（柏讯）侧代码：authorize URL 平台自拼，追加 scope 无需 wire 动作；唯一外部依赖是
  Logto 租户 client 配置（refresh grant 开关与 TTL），由 spike 先行验证；
- 不做跨用户凭据共享、平台级超级 token、拉长 ID token TTL（交互场景安全面，否决）；
- 不做 401 主动续期作为主路径（当回合已烧救不回，仅作为上述安全网）；
- 不动舰队编排面（派发边、报数）——那是 wire-content-fleet 已交付部分；
- P3 内部狗粮长效服务令牌**仅作 spike 受阻时的止损备选**，本 change 不实现。

## Capabilities

### New Capabilities

（无。）

### Modified Capabilities

- `line-credentials`: 重写「短命 ID token 浏览器重铸」需求——铸币追加 offline_access、
  refresh_token 随行存储只写不读、服务端双触发续期（回合前 + 巡检）、rotation 落新值、
  refresh 失效标 stale（替代整行清除）、cron 回合拿到的永远是续后凭据。投影/日志无密钥
  口径不变。
- `mcp-integration`: 修改「MCP server tools are registered…」需求中的热交换条款——凭据
  （Authorization 头）变化 SHALL 走 restart 交付（空闲门控、忙则回合边界推迟），不依赖
  dsh-mcp-client HMR；非凭据变化（增删）维持 HMR 语义不变。

## Impact

- `server/routes/line-credentials.js`（scope 追加 + 回调存 refresh_token）；`line-credentials.js`
  （stale 语义改造 + refresh 读取）；`db.js`（`user_line_credentials` 加 `refresh_token` 列，
  一个编号迁移；`getLineCredential` 投影**不加**该列）；
- 新模块 `server/line-token-renewal.js`（双触发 + 单飞锁 + config 现拉缓存）；
  `server/cron-runner.js`（`runCronJobTurn` 顶部续期钩子）；`server.js`（`dshUpdateMcp`
  Authorization diff → restart/推迟）；
- 外部依赖：wire/lex 的 Logto 租户须允许 SPA client refresh grant（spike 验证）；30 天验收
  受租户 refresh token TTL 约束（Logto 默认绝对 14 天，若如此需 wire 侧租户配置配合——
  配置非代码，边界写进 design）；
- 验收现场：`fleet_1792786329045_jchvsd`（platform-test cell）7 天 09:00 巡线读面全 200。
