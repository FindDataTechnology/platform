# add-line-credential-renewal — Design

## Context

链路事实（探索期已逐文件核实，出问题先看这里）：

- **铸币**：`server/routes/line-credentials.js`——服务端 PKCE；`:173-175` 把 `offline_access`
  剔出 scope；token 兑换只取 `id_token`（`:243`），响应里即便有 refresh_token 也被丢弃。
  `prompt=none` → interactive 重试一次的机制已存在（`:218-220`），offline_access 首连
  consent_required 会被它自动吸收，**零新工作**。
- **凭据行**：`line-credentials.js` + `db.js:713`（表 `user_line_credentials`，PK
  `(email, line)`）。`markInvalid`（`:109-121`）对 ID-token 线是**整行清除**；401 钩子在
  `server/dsh-events.js:79` 已生产运行。
- **注入与热交换**：token 经 `dsh-profile.js:707 liveTokenForRef` 在写 patch 时快照进
  `headers.Authorization`；`server.js:723-761 dshUpdateMcp` 重写 patch 后——HMR 路径只是
  800ms settle 等待（`:738-746`，注释自认无确认信号），restart 分叉在 `:752` 现成。
- **回合路径**：`server/cron-runner.js:689 runCronJobTurn` 是全部回合形状的收口；persona
  回合跑在每 cell 唯一共享子进程上，`switchPresetForJob:153` 在 preset 未变时短路——**这是
  实跑三轮旧 token 的精确根因**（无 restart，全押 HMR，HMR 对头值变化不生效）。工具岗
  （`tool-turn.js:80`）服务端现读 DB，天然免疫 P2。

## Goals / Non-Goals

**Goals:**

- 无人值守回合（cron 舰队岗）线 MCP 调用零浏览器参与、读面持续 200；
- 凭据值变化到运行中子进程的交付**可证明**（restart 完成即证明），不靠 settle 猜测；
- refresh token 全生命周期只写不读，投影/日志口径与现状逐字节一致。

**Non-Goals:**

- 不修 dsh/cordis 的 HMR（根因在彼侧，且修好也无确认信号——本设计不把它作为任何链路的
  依赖项，调查仅列为可选优化）；
- 不解决多用户 cell 中 `runtimeOwnerEmail` ≠ 回合属主的存量语义（单运营号 cell 无影响，
  显式排除）；
- 不做 P3 内部服务令牌（spike 受阻才启用，届时另立）。

## Decisions

### D1 铸币追加 offline_access，refresh_token 随行存储（一个 ALTER）

scope 过滤处放行 `offline_access`（authorize URL 平台自拼，wire 侧零代码改动）；`mint/callback`
的 token 响应里取 `refresh_token` 一并存入凭据行。迁移 = 下一个编号 migration 一句
`ALTER TABLE user_line_credentials ADD COLUMN refresh_token TEXT`。**`db.js:1936`
`getLineCredential` 的 SELECT 显式列名不加新列**——行投影（status/liveToken/连接卡）零变化，
refresh_token 只有续期模块内部读。旧行 refresh_token 为 NULL = 无续期能力，自然降级为现状
（浏览器重铸 UX），无需数据回填。

*备选否决*：issuer/clientId 持久化到行——不需要，见 D2。

### D2 续期模块独立，config 现拉缓存；单飞 + 单 UPDATE 原子

新模块 `server/line-token-renewal.js`。refresh grant 需要的 `issuer`/`client_id` **不入库**，
续期时现拉各线 auth config（`DEFAULT_MINT_TARGETS.configUrl`，内存缓存 TTL）——顺带自愈
“线轮换 SPA client”场景（mint 路由注释明说 config 现读正是为此）。无 secret、无
redirect_uri（公共客户端 refresh grant）。

- **rotation**：Logto 每次刷新返回新 refresh_token，新值与新 ID token **同一次
  `setLineCredential` 落库**（PK 行单 UPDATE 天然原子）——丢新值链即断，这是硬约束；
- **单飞**：进程内 `Map<email|line, Promise>` 锁，双触发并发命中同一行只发一次请求（每
  cell 单进程，进程内锁足够）；
- **失效**：`invalid_grant` → `markLineCredentialStale`（复用现函数），日志只记
  `email/line/成功|失败`。

**生产修正（2026-10-24 深夜，TTL 实测）**：上线当晚测得租户 refresh TTL 仅 ~31-33 分钟
（首刷 30m35s 成功、下一次 rotation 后 32m43s 失败 invalid_grant；远低于 Logto 默认
14 天=租户配置值），rotator 不透明无 exp 可读——D3 原设的「exp-30min」阈值使每次续期都
踩在 TTL 边缘。节奏改为**固定制**：锚 `updated_at`（rotation 年龄）>15min 即续、sweep
5min，rotator 寿命 ≤20min；exp 窗口降级为回合前 belt。原 exp 驱动扫描退役。

### D3 触发点：① `runCronJobTurn` 收口顶部，② boot 巡检 interval

- **① 回合前**：`runCronJobTurn`（cron-runner.js:689）分派 executor 之前，对回合属主
  （`ctx.cellUserEmail`）的 wire-customer/lex 两行做 `exp - now < 30min` 检查并续期。不做
  preset→ref 反解——总共两条线，两行 DB 读即可。落点选收口而非 `runPersonaTurn` 内部，是为
  一处覆盖全部回合形状（tool 岗直读 DB 天然受益；a2a 远程回合续了也无害）。
- **② 巡检**：server boot 处 `setInterval(10min).unref()`（挂法仿 `trace.js` prune / 
  `usage-telemetry.js`），扫全表将到期行。副作用是收益：浏览器用户的 token 也被续命，
  连接卡「静默铸造，自动续期」的承诺对**所有人**成真。

### D4 401 语义改造：refresh-first → stale，不再整行清除

`line-credentials.js markInvalid` 对 ID-token 线从 clear 改为：有 refresh_token → 先试一次
续期（成功即续期+重应用，下一回合自愈）→ 失败标 stale；无 refresh_token（旧行/手贴）→
保持 clear（浏览器下次访问重铸，原 UX 逐字节不变）。接线点就是现有钩子
`dsh-events.js:79 markCredentialStaleOn401`——需求文档「平台拿不到 401 事件」的前提经核实
不成立，此钩子已在生产运行，接上即成安全网。

### D5 P2 交付：restart-first，不信任 HMR 头值热交换

`dshUpdateMcp` 在写 patch 前后 **diff 既有 server 行的 Authorization 头值**：

- 变了 + 空闲（`isReady && !isStreaming`，同 `dshUpdateSkills:773` 门控）→ 直接走 `:752`
  restart 分叉（重 spawn 从磁盘重读 patch = 生产实证有效的唯一交付路径）；
- 变了 + 忙 → 置 pending 标记，`ctx.onRuntimeIdle` 回调/下一回合 `waitForIdle` 之后排空执行
  ——在跑回合永不因续期被打断（打断走 `interrupted` 可重跑语义，由 `taskTurnRegistry` 处理，
  但本设计目标是让它根本不发生）；
- 没变（server 增删/启停）→ 维持现状 HMR 路径，行为与本 change 之前逐字节一致。

与触发①组合后的主路径：**回合边界 → 续期 → patch 重写 → 恰逢空闲 → restart → 新子进程
新 token 出回合**——无人值守链路没有任何一段依赖 HMR 信任。

*备选否决*（与需求文档偏好相反，理由）：文档首选「修 HMR」。否决：① HMR 无确认 RPC，
修好仍是猜测（server.js:743-744 注释自认），无人值守正确性需要可证明交付；② 根因在
dsh/cordis 内部（watcher 对原子重写不触发，或 mcp-client 对同 server 头值变化不重读，未定），
跨仓且工作量未知；③ restart 分叉现成、每活跃线约 30min 一次的频率远低于集群扇出/preset
切换的既有 restart 频率，会话按 id 落盘恢复。

### D6 spike 已执行（2026-10-24，结论全绿；机理终版 2026-10-25 由 wire 侧源码级定案修正）

真机验证已做（platform.finddatatech.cloud 会话 + 手拼 authorize URL + 自兑 code），三问落定：

1. **refresh_token 正常发放**：wire client（`i0oxdswqxv4x7te99iukv`）对 offline_access
   发 refresh_token；token 响应含 `access_token/expires_in/id_token/refresh_token/scope`，
   id_token TTL 实测 1.0h。**P1 成立，P3 永久搁置**（除非后续回归）。
2. **rotation 开启且宽松**：每次刷新返回不同 refresh_token，且**旧值在宽限窗口内重放仍
   200**（Logto lenient rotation）——并发竞态天然可存活；单飞锁（D2）仍然执行，落库以
   最新返回值为准。
3. **机制终版（wire 侧源码级定案，10-25）**：SPA 公共客户端的 refresh token 带
   `expiresWithSession`+`sessionUid`，**绑定铸币时的浏览器会话**（三重校验：铸币会话存活/
   主体未变/grant 未换），且**自铸币起 14 天绝对租约、rotation 不续命**。推论：
   - 无人值守的周期上限 = min(铸币会话寿命, 14 天)，**验收口径由「30 天不再点连接」改为
     「≤13 天周期自动重铸」**（壹座 headless 铸币配方已具备，走 platform mint 通道）；
   - 舰队/5.x 结构性正解 = 每 cell 专属服务账号 + <14 天自动重铸；备选机密客户端不首选；
   - 独立会话的登录/重铸不杀既有链；同铸币会话的再授权（复用 cookie 的脚本化铸币）杀链。
   详细证据链：fd-wire 闭环报告 §七（壹座观测）+ §八（wire 源码定案）。
4. **首连 consent**：wire client 首次 offline_access 在 prompt=none 下返回
   `consent_required`（requested scopes not granted）；interactive 通道**免屏自动授权**
   （first-party app 无 consent UI，直接 303 发码），既有 interactive=1 重试完整吸收，
   存量已连接用户下次静默重铸时同样被吸收，零额外工作。

## Risks / Trade-offs

- [Logto SPA client 不放行 refresh grant / rotation 关闭] → **spike 已排除**（D6：发放且
  rotation 宽松开启）。
- [refresh 链断裂（平台停机超过租户 refresh TTL）] → 断链时行标 stale、用户重连一次即
  重建链（诚实降级，不假成功）；持续刷新期间 rotation 重锚定 TTL，无绝对上限。
- [restart 每 ~30min/线，打断长回合] → 忙则推迟到回合边界（D5），在跑回合零打断；空闲
  restart 的会话恢复已有 dsh 落盘保证。
- [refresh_token 落库的安全面] → 与现有 secrets 同级（DB 内，不引入新 KMS）；SELECT 投影
  显式列名不含新列；日志只记 email/line/结果；不进任何 read 面。
- [多用户 cell 中 focused runtime 的属主漂移（注入错属主 token）] → 存量语义，非目标显式
  排除（单运营号 cell 无影响）；若 5.x 外部开放时多租户 cell 成为现实，另立 change。
- [巡检与浏览器 mint 竞态（用户正点连接时巡检并发续期）] → D2 单飞锁覆盖同 row 并发；
  巡检续出的新 token 覆盖用户行属正常续期，非覆盖用户意图（同一 refresh 链）。

## Migration Plan

1. 迁移（ALTER 加列，可空，无回滚需求）随镜像上产——列 NULL 即现状降级，新旧代码共存安全；
2. spike（任务 1）在真机 cell 先行出结果，再进实现任务；
3. 上产后验收：`fleet_1792786329045_jchvsd` 连续 7 天 09:00 巡线读面全 200，全程零浏览器、
   零 platform 重启；
4. 回滚 = 整体回退镜像即可（列遗留无害；refresh 链断后自动落回现状浏览器重铸 UX）。

## Open Questions

- HMR 对头值变化不生效的精确根因（watcher 未触发 vs mcp-client 不重读头值）——留作可选
  调查，不门禁任何交付路径；若未来 dsh 补出热交换确认 RPC，可再评估把凭据交付迁回 HMR。
- 巡检间隔（10min）与续期阈值（30min）的实跑调参空间——初值按 TTL 3600s 推得，验收期
  观测后可调，不构成设计变更。
