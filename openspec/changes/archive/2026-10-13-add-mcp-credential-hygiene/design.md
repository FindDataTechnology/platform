# Design: add-mcp-credential-hygiene

## Context

见 proposal.md。三条代码事实定死设计空间（2026-10-13 逐行核实）：

1. 凭据物化链：DB 只存 ref/名字（干净）→ `resolveCredentials`（credential-refs.js:76）写盘前把 token 物化进 `config.headers`；stdio 侧 envRefs 在 `toMcpClientEntry`（dsh-profile.js）把值解析进 `entry.config.env`。两个通道的值都进 `mcp.patch.yml`，`atomicWriteTextSync`（lib/persistence.js）不设 mode，按 umask 落 0644。
2. dsh-mcp-client（@deepseek-ai 外部包）的 streamable-http 分支对 `config.headers` **原样透传**，无 env 插值、无 ref 机制——"patch 只留占位符、运行时解析"路线必须 fork 外部包，排除。
3. `failOnStartupError: true` 在 dsh-mcp-client 里等价于 `registrationFailure: "throw"` 且 apply 抛出——单个抽风上游会砸掉整个会话启动。翻转被排除，失败显形改在平台侧做。

威胁模型拆分决定优先级：跨租户读文件 ≈ 0（cell 各自独立 pod fs）；用户自己的 key 躺自己 cell = 既有接受面；**平台级秘密（SEARCH_RELAY_TOKEN）躺全部 cell** = 本设计要消灭的系统面暴露。

## Goals / Non-Goals

**Goals**

- 泄露爆炸半径从"平台"缩到"单 cell"：relay 凭据 per-cell 派生、可归因、可吊销
- patch 0600 纵深防御
- MCP http server 健康状态在平台侧可见（消灭"三无声"）

**Non-Goals**

- 不改 dsh 镜像 / dsh-mcp-client（headers 原样透传是现状约束，接受）
- 不消灭"值出现在本 cell patch"本身——单 cell 作用域下这是可接受残留；真正消灭需要 dsh 侧凭据代理（记录为长期方向，不在本 change）
- 不动 registry/connector 凭据链（per-user，威胁模型内）
- 不翻 `failOnStartupError`

## Decisions

### D1 派生令牌形态：`wsrc-<scope-id>-<hex-hmac>`

- `scope-id`：调用方（host）自定义稳定标识，生产用 cell/租户 id（`cell-<hash>`），演示部署可用 `demo`。明文自带归因，日志按前缀记账（沿用现有 `token.slice(0,6)` 打法，扩展为整段 scope-id）。
- `hmac`：`HMAC-SHA256(master, scope-id)` 取前 24 hex（48 字符总长与现静态令牌同量级）。**不含时间戳**：relay 是无状态单文件，过期语义没有吊销墙可靠；泄露处置走 denylist 即时止血。
- 校验顺序：静态 `tokens` 列表 →（命中即过）→ 前缀 `wsrc-` 解析 → HMAC 恒时比较 → denylist 查 scope-id。
- master secret 来源：keys.json 新增 `"scoped_master"` 字段（与 tokens 并列，同文件同保密级），env `RELAY_SCOPED_MASTER` 备选，file wins——沿用该服务既有配置习惯。

### D2 denylist：keys.json `"revoked_scopes": []` + 文件 mtime 重载

单文件服务不引 DB。每次校验前 `statSync` keys.json，mtime 变即重读（现状 keys.json 只在启动读一次；denylist 要求热生效，顺带让 tokens 增删也热生效——迁移期加令牌不用再滚动 relay）。stat 开销每请求一次，量级可忽略（relay 有 per-token 日配额上限，QPS 极低）。

### D3 host 侧派生点：writeMcpPatch 的 envRefs 解析处

`toMcpClientEntry` stdio 分支解析 `SEARCH_RELAY_TOKEN` 时，若进程 env 存在 `SEARCH_RELAY_SCOPED_MASTER`，则改为按 `SEARCH_RELAY_SCOPE_ID`（cell 上下文已有）派生并注入派生值；master 未设则维持现状注入共享值 + 一次性 warn（spec 的降级场景）。派生函数放 `lib/`，relay 与 host 各持一份相同实现（两处 ~10 行，同步注释互相指认；不引共享包——relay 刻意零依赖单文件）。

### D4 patch 0600：`writeViaTemp` 加 mode 参数

`atomicWriteTextSync(file, text, { mode = 0o600 })`——默认 0600 对该仓库的调用者几乎全是收紧（配置/patch/凭据文件）；唯一需要 0644 的调用者显式传。tmp 文件先 chmod 再 rename（rename 保留 tmp 的 mode），属主不变。

### D5 preflight：探活不阻断、结果进 store、只读端点暴露

- 触发点：writeMcpPatch 尾部（同函数已知全部 server+解析后凭据，探活成本 N×initialize 超时上限），**异步执行**（不阻塞 patch 写出与响应）。
- 探测：MCP `initialize`（与 §4.7 排障同法），按结果归类 ok / unreachable / auth-rejected(401) / server-error(5xx/503) / unknown(探活自身异常)。
- 存储：extension store 新表或既有键值（server→{state, checkedAt, detail}），ttl 视为缓存。
- 暴露：`/api/diagnostics/mcp`（auth 同其他 /api）返回各 server 态；UI 侧后续消费（本 change 只交付端点+store，控制台展示记为后续）。
- stdio server 不探活（本地命令，失败模式不同，dsh 侧可见性已足够）。

## Risks / Trade-offs

- **派生值仍在 cell patch 里**（D3 明示）：残留接受面 = "本 cell 作用域秘密躺本 cell"，与用户自有 key 同级。真正根除需 dsh 侧凭据代理或 ref 机制——上游包改动，单独立项。
- **denylist 热重载把 keys.json 变成每请求 stat**：低 QPS 下无害；若未来 relay 上量，改 fs.watch。
- **preflight 探活会给上游制造周期性 initialize 流量**：daas-mcp 曾因会话池撞顶 503（2026-10-13，后随 v4.0.11 自愈）——initialize 后必须立即发带 session 终止的 cleanup/DELETE，且探测间隔取组合事件驱动而非定时轮询，避免成为会话泄漏源。
- **迁移顺序**：先 relay（接受静态+派生双通道，keys.json 加 scoped_master）→ 再 platform（env 加 master+scope-id，滚动后 cell 重写 patch 即带派生值）→ 静态 token 保留兜底，不设撤除截止期。
