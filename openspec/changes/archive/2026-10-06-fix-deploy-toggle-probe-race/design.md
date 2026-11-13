## Context

竞态时序：deployToRegistry upsert 条目 → 立即 `toggle?enabled=true`（为压过注册安全扫描的禁用）→ 但此刻 runner 尚未轮询到新条目（≤5min 窗）、监听器未起 → toggle 的健康探针失败（fresh=unknown 视为不健康）→ nginx 只为健康条目生成 `/agent/` 路由 → 门面调用 -32033 (405)。registry 侧无周期修复循环；人工重发 toggle 即愈（重发触发重探）。现场时间线见 finddata `MCP-REGISTRY.md` §3 与 facet-mcp-foundation-v1 closeout report。

## Goals / Non-Goals

**Goals:**

- 新部署零人工干预，≤5min 窗口内门面 a2a 调用直接成功
- 改动全部落在 paas 部署路径侧

**Non-Goals:**

- registry fork 侧健康修复循环（触 fork，明确排除）
- 改变 runner 轮询周期或引入推送

## Decisions

### D1 重探梯而非注册后单次延迟

+90s / +210s / +330s 三档各重发一次 `toggle?enabled=true`（重发即重探）。单次 60s/120s 延迟覆盖不了 runner 拾取窗的方差；周期循环又过重。三档定界：第一档压常见的秒级拾取，末档 +330s 兜住接近 5min 的最慢拾取。

**诊断结论（2026-10-06，直接读 fork 源码，比预案更强）**：registry 的 toggle 路由对**每次调用**都执行 `_refresh_agent_health`（`agent_routes.py:363`：探针=GET 后端卡片期望 200，持久化 `health_status`+`last_health_check`）+ `nginx_reload_scheduler.mark_dirty()`；`enable_agent`（`agent_service.py:365`）在已在启用态时早退，但路由层的探针不随早退跳过。周期健康循环只覆盖 MCP servers（该函数 docstring 明说 "the periodic health loop only covers MCP servers"）——所以重发 toggle 就是**唯一**的自愈路径，即人工 manual toggle 的自动化。**早退判据不需要**：重发无副作用（state 早退、探针幂等、reload 幂等），盲重发梯即正解，实测以「重发是否恰为三档」为准。

### D2 best-effort 定时器，失败静默记日志

定时器活在部署进程（网关）内存里：进程重启即失——可接受，重新部署或手动 toggle 仍是兜底路径，与现状语义不劣化。任一档失败不抛、不影响 deploy API 响应形状。

### D3 前置只读诊断（已执行）

原计划在 cheap-1 实锤 toggle 探针语义；实际做到更强的零副作用版本：本地即存 registry fork 源码（`~/code/mcp-gateway-registry`），直接读 `agent_routes.py` 的 toggle 路由、`agent_service.py` 的 enable 早退、`constants.py` 的 `HealthStatus` 枚举（fresh 条目为 "unknown"，`is_healthy` 只认 healthy/healthy-auth-expired）与 nginx 生成器（`nginx_service.py:2356` 六道门槛：enabled/card/proxy url/a2a 协议/健康/后端可解析）。探针语义、幂等性、健康字段名全部实锤，未触碰任何线上条目。

## Risks / Trade-offs

- [诊断发现 toggle 重发有非幂等副作用（如重复通知/审计噪音）] → 降级为「GET 查健康 + 仅不健康时重发」，梯形不变
- [网关进程在梯完成前重启导致重探丢失] → 接受（D2）；不引入持久化队列
- [runner 拾取慢于 5min 的极端情况] → 超出传播契约（spec 本就以 5min 为界），梯末档后记一条 warn 即止

## Migration Plan

常规平台镜像滚动（lib/ 已在镜像内），无迁移步骤；与 Change A 的镜像可同滚可分滚。

## Open Questions

（无——诊断只影响参数，不影响形状）
