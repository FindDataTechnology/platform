# design — fix-agent-serving-stability

## Context

探索核查（2026-10-12）坐实的三个病灶与生产实况：

- **③ 幂等缓存**：`gateway/wanxing/core.js` `idempotentSend` 对 done/error 行一律重放（L133），error 行以 `{error:{code:-32032,…}}` 落台账（L153）并被 200 原样重放；重放判定只看 (caller, slug, idemKey)+24h 窗，与请求体零绑定。`a2a.js:33` contextId 直接从 idemKey 派生——键碰撞不仅劫持缓存，新尝试还会接上旧 dsh 会话。store 侧 `requestFinish` 是无条件 UPDATE、`requestStart` ON CONFLICT DO NOTHING，同键覆写天然可行。
- **② 冷启动残余**：驱逐修复（1eb2ae8）已上线 cheap-1（镜像 sha-68a30f9，00:27 起容器）。但 `child.js` start() 的 initialize 失败路径丢弃局部 `client` 引用而不 close——`client.start()` 已 spawn 的 dsh 进程成为孤儿（实测单个 100-200MB，runner 限额 1.5G）；且 INIT_RETRIES（20×500ms≈10s）烧尽后只抛错一次，没有整进程重建的二次机会。
- **① 物化属主**：生产 runner（cheap-1）昨夜起以 uid 1000 跑，全树一致；但仓库 `agent-runner/docker-compose.yml:31` 仍钉 `user: "0:0"`，`materializeAgentHome`（compose.js）对属主零约束。root 世代卷、运维 `docker exec -u root` 写入、按仓库文件重建的 runner 都会重新制造混合属主，agent EACCES 变砖后才被发现。

## Goals / Non-Goals

**Goals:**

- 幂等缓存：错误答可同键重试重执行；成功答重放需请求体指纹匹配；键重用显式 409。
- 冷启动：失败路径零孤儿进程；烧尽重试后有带退避的整进程重建升级；永久失败可辨识且不 wedge。
- 物化：home 树属主始终等于运行身份；仓库默认形状对齐生产（uid 1000）；外部属主可修则修、不可修则响亮报错。

**Non-Goals:**

- 不改 dsh 内部的 adapter 注册顺序（在 harness 侧，不可达）。
- 不改 contextId 的 idemKey 派生（体异请求已在执行前被 409 挡下，派生无需加盐；重放场景同体同 contextId 正是续话语义）。
- 不动 message/stream（本就无重放面）。
- 不做 runner 卷的一次性迁移工具（属主守卫在物化时自愈；迁移配方记入 fleet 接入文档）。
- 不改 24h 窗口默认值（指纹绑定后窗口长度不再承载正确性）。

## Decisions

### D1 ③ 错误答：不重放，同键重执行并覆写

`idempotentSend` 里 `existing.state === "error"` 视同不存在：跳过重放、直接进 flight；`requestStart` 会因行已存在返回 false（现有注释已允许），flight 的 `requestFinish` 无条件覆写该行。`idempotencyState` 同步把 error 行报为 `new`（重试要过 rate+slot 正常准入）。

*备选*：错误答短 TTL 重放。否——重试语义就是「再来一次」，任何 TTL 内的旧错误答都是错答重放；单飞（flights）已覆盖并发去重。

*计费互查*：重执行的 turn 成功则正常记账结算（replayed=false 路径），错误则 waived——现状语义自然保持。

### D2 ③ 成功答：请求体指纹绑定，同键异体 409

指纹 = sha256(rpcBody)（即透传给 agent 路由的完整 JSON-RPC 体，含 method+message）。`wanxing_requests` 增列 `request_hash TEXT`（SQLite `ALTER TABLE … ADD COLUMN`，IF NOT EXISTS 式守卫；旧行 NULL=无指纹，首遇视作匹配并回填）。重放 done 行时：行有指纹且与本次不符 → 409 `{error:{code:"IDEMPOTENCY_KEY_REUSE", message:…}}`（HTTP 409，非 JSON-RPC 200 包装——这是准入层拒绝，与 TURN_IN_FLIGHT 同层同款）。

*备选*：TTL 缩短（5-10min）。不足以修「重置工单立刻重试」的场景（碰撞发生在秒级）；且长窗重放对真网络重试有价值。指纹是正确性修复，TTL 只是缓解。

### D3 ② initialize 失败：close-on-fail + manager 级退避重建

`child.js` start() 的 catch 里对局部 `client` 调 `close()`（EOF→SIGTERM→SIGKILL 阶梯已在 SDK）再重抛。manager 的 `#spawnChild` catch（现有驱逐点）之上加重建升级：spawn 失败按指数退避（初始 2s，上限 3 次）重试整个 spawn——每次都是全新 dsh 进程；烧尽后抛带 `code: -32004`（新冷启动永久失败码）的结构化错误，下次消息照常再试（不 wedge）。退避计数按 agentKey 记录，成功 spawn 即清零。

*备选*：把 INIT_RETRIES 窗口加大（20→60 次）。只治慢注册不治永久失败，且 30s 白等劣化所有真失败的时延；重建升级两者兼顾。

*码位*：-32004 避开已占用的 -32000（draining）/-32001（预算）/-32002（运行时退出）/-32003（LLM 失败）与門面侧 -32032/-32033。

### D4 ① 属主守卫：物化时检测 home 根属主，root 可修则修

`materializeAgentHome` 开头 stat home 根：属主 uid ≠ 进程 euid（且 ≠ 目标 uid）即为外部属主。root 进程 → `fs.chownSync` 递归（用 `child_process` 一次性 `chown -R` 免手写递归，注意不跟随 node_modules 符号链接——`chown` 默认不跟随）到 `AGENT_RUNNER_HOME_UID`（默认 1000），日志一行 `[agent-runner] home ownership repaired`；非 root → 抛结构化错误指明路径与修复指令（`docker run --rm -v … chown -R 1000:1000 …` 或重建按新 compose）。写完后的新文件天然进程属主，无需事后二次 chown。

*备选*：物化进程整体降权到 uid 1000 跑。改动面大（卷各子目录属主、meter/spool 写入权限全要核），且生产已是 1000 形状，守卫只需兜住 root 世代与运维误写。

### D5 ① compose 默认翻到 uid 1000 + 迁移注记

`agent-runner/docker-compose.yml` 的 `user: "0:0"` 改 `user: "1000:1000"`，注释改写为迁移指引（现有 root 卷先 `docker run --rm -v agent-runner-data:/data alpine chown -R 1000:1000 /data` 再起）。fleet 接入配方文档同步。与生产现实（cheap-1 已 1000）对齐，消除「按仓库文件重建即回陷阱」。

## Risks / Trade-offs

- **409 对现有调用方是行为变化**：若有调用方故意同键异体（当作「同会话续话」用），会从 200-旧答变 409。柏讯巡检器属事故元凶方，语义修正正是所需；探针/文档同步更新。
- **错误不重放放大上游故障重试流量**：原先错误答被缓存「吸收」的重试现在真执行。有 RPM+slot 双闸兜底；且「重试被假成功吸收」正是要修的 bug。
- **respawn 升级拉长最坏冷启动时延**：3 次退避（2s/4s/8s）+ 每轮最长 10s initialize ≈ 45s 上界。可接受——此前这条路是「永久 wedge 直到人工重启」。
- **chown -R 大 home 的时延**：home 树只有技能/yaml/凭据（node_modules 是符号链接不跟随），毫秒级。
- **SQLite 增列迁移**：wanxing_requests 已存在于生产；`ALTER TABLE ADD COLUMN` 幂等守卫（PRAGMA table_info 检查）必须先落，否则二启崩。
