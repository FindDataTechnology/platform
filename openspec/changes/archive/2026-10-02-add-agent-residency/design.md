# Design: add-agent-residency

## Context

runner 今天的生命周期是 `agent-runner/manager.js` 的 idle-reap（config `idleMs` 默认 30min）+ 冷启动；deployment descriptor 已在 registry agent 条目 metadata 里（`lib/agent-serving.js` composeDescriptor）；serving 契约校验在 `lib/pack-manifest.js`。探察定数：空闲 child 实测 18–54MB（macOS），规划按 96MB/agent、4GB host ≈ 50 resident。承 ADR-0010。

## Goals / Non-Goals

Goals: 温区状态机替换 idle-reap；节奏→自主回合全链（manifest → descriptor → runner 调度注入）；每日滚动+昨日纪要+归档；pause/resume + 急停；计量点。

Non-Goals: 计费结算（③）、跨 agent 委派（②）、多 host 调度器、cron 全语法（v1 只做两种节奏形状）、自由循环（永不做）。

## Decisions

**D1 — 温区状态机（manager.js 重构）**: child 状态 `resident | warm | starting | paused`。删除 idleMs 定时回收；预算 = 各 resident child 实测 RSS 之和（30s 采样）+ starting 预留（固定 `AGENT_RUNNER_AGENT_COST_MB`，默认 96）。超 `AGENT_RUNNER_RESIDENT_BUDGET_MB` → 逐出 lastUsedAt 最旧的 resident 进温区（杀进程、DSH_HOME/会话留盘）；触达即热起（秒级，状态全在盘上）。防抖：被热起 10 分钟内的 child 不再作为逐出候选（除非硬超预算 120%）。health 端点报告五态。

**D2 — 节奏的 v1 形状（两种条目，不引 cron 库）**: `serving.rhythm = [{ every: "1h" } | { daily: "09:30", do?: "巡检数据源并汇总异常" }]`——间隔（最小 5m）与每日定点（时区随 runner 配置，默认 Asia/Shanghai）；`do` 是该到点回合的工作提示（声明性文本，≤2000 字符，缺省用平台默认提示「按你的角色职责，执行本轮节奏工作」）。入口校验：每条恰含 every|daily 之一 + 可选 do，禁区字段同契约。事件源字段 v1 不开（spec 已留话「later versions」）。

**D3 — 自主回合即内部 A2A 消息**: 调度器（runner index 内 tick，30s 粒度）算各 agent 下一 due；到点走 `manager` 的同一 acquire/queue 面，以内部系统调用方身份注入一条 message（prompt = 条目的 `do` 或默认提示）。错过即跳过（重启/温区/暂停不补跑）——due 时间持久化不需要，重启后按当前时刻重算。可观测：回合带 `origin: "rhythm"` 标记进日志与计量。

**D4 — 每日滚动与昨日纪要（digest 本身是一个自主回合）**: 每 child 有日界（配置时区的 00:00）。滚动流程：在**旧会话**上注入一条 digest 自主回合（固定提示「总结今日会话要点为明日纪要」）→ 纪要文本存 child 目录 → 旧会话归档（拷贝至 `AGENT_RUNNER_ARCHIVE_DIR`，默认容器内 /data/agent-archive，可挂 NFS/对象卷）→ 新会话首条注入纪要。温区 agent 的滚动推迟到下次热起时补做（paused 跳过）。纪要回合烧部署者配额（③ 前无结算），提示词带长度上限（512 字）控成本。

**D5 — pause 走 registry 传播，与 deploy 同一列车**: gateway 增 `POST /api/packs/:id/versions/:v/deployments/:agentId/pause|resume`（deployer/admin 门）+ 平台急停端点（admin 门）——都只是写 registry agent 条目 metadata `paused`（复用 deployToRegistry 的 registry 客户端）。runner 轮询（≤5min 生效，与部署同面）看到 paused → manager 进 paused 态（杀进程留态、停调度、A2A 适配器对来话回显式 JSON-RPC 错误 `agent paused`，绝不冷启）。resume 同路径。registry 是 pause 的单一事实源（重启不丢）。

**D6 — 计量点先行**: 每回合一条 jsonl（agent、kind: `message|self|digest`、tokens、时长、at）落 runner 计量文件；token 数来自 adapter 既有 usage 上报。③ 的 sub2api 结算直接消费此文件，本片不建账本。

**D7 — descriptor 增 effective_rhythm 字段**: 部署请求可带 rhythm 覆盖（同 D2 形状）；agent-serving 组装 descriptor 时记录 `effective_rhythm`（覆盖优先于 manifest 默认）。registry metadata 体积上限已知小，rhythm 序列化后数十字节级，不撞 cap。

## Risks / Trade-offs

- [RSS 采样漂移（Linux 未实测）] → 预算采样 + 固定成本下限双保险；上线后按 Linux 实测复调常量，DEPLOY.md 记录复调步骤。
- [纪要回合烧部署者配额] → 512 字上限 + 每日至多一次；③ 上线后转入按 key 结算。
- [runner 单点重启丢调度进度] → due 重算 + 错过跳过（spec 已锁），无追赶风暴。
- [registry metadata 更新 API 形状未核] → 实现期核对 deployToRegistry 所用客户端的 update 路径；不改本设计结构，只可能换调用形状。

## Migration Plan

滚动上线即改变默认行为：现存已部署 agent 从「闲置回收」变「驻留」。当前 runner（cheap1 staging，1 个演示 agent）内存余量充足，预算默认值保守（host 内存 × 60%）。回滚 = 旧镜像（idle-reap 行为回来），盘上状态无 schema 变更。

## Open Questions

- 时区配置项名与默认值（AGENT_RUNNER_TZ vs 复用 TZ）——实现期定，不影响结构。
- registry agent 条目 metadata 的部分更新端点（PATCH 形状）——实现期核对，仅影响 D5 的调用代码。
