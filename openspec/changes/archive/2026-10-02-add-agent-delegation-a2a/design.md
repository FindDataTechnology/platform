# Design: add-agent-delegation-a2a

## Context

委派链今天止于本 cell persona（`server/delegation-mcp.js` target={persona}，POST `/api/delegation/tasks` → 任务引擎 → 人格槽）。A2A 客户端机器已在 `server/agent-session.js` streamA2aChat（message/stream + 双凭证 + SSE→text/done 契约）。上游事实（探察 2026-10-02）：invoke 门=scope 规则；M2M 建户=`POST /api/management/iam/users/m2m`（admin）；X-Authorization 专用。承 ADR-0013。

## Goals / Non-Goals

Goals: cell 调用身份自动开通；a2a 目标全链（工具→任务→远端执行→聚合）；深度/并发断环；两级发现。

Non-Goals: 结算（③）、全局环检测、agent 主动发现订阅面、A2A 文件类产物、MC/console 面。

## Decisions

**D1 — 调用身份 = 部署级服务凭证（方案 A，2026-10-02 实测改道）**: 出站委派调用沿用与人类 a2a 聊天相同的部署级 registry 服务凭证（`AGENT_SERVING_REGISTRY_TOKEN || MARKET_REGISTRY_TOKEN`），无每 cell 开通。**改道原因（三条原路实测全死）**：`POST /api/management/iam/users/m2m` 需 IAM provider（本部署无，返回 IAM provider error）；静态 token 面关闭且 env 加 key 需重启；用户 token 是引用型 JWT（claims 无 scope/groups，鉴权时服务端查组）而 Logto 用户在 registry 侧无组——invoke scope 映射不到。每 cell invoke-only 身份（归属/吊销粒度）延至 ③ 凭证加固（届时在静态 key 与 Logto 组桥两案中选）；已建好的 `paas-agent-callers` scope 留置待用、当前不授任何身份。凭证缺失 → 任务结构化失败（不回落其他 token）。

**D2 — 远端槽 = 执行器分支，不碰槽模型**: 引擎执行路径在 dispatch 处按 target.type 分叉：persona 走既有槽；a2a 调 `runA2aTask(entry, prompt, {depth})`——从 streamA2aChat 提出的可复用函数（`server/a2a-client.js` 新模块）：fetch entry.url、X-Authorization=cell caller 凭证、Authorization=AGENT_SERVING_BACKEND_TOKEN、`X-Delegation-Depth` 头、SSE 聚合为完整文本；输出写任务专属会话（与人格执行同一落点，聚合器零改动）。排队纪律：a2a 执行在引擎的串行策略内照常排队（远端执行本身不占人格槽、不切 runtime）。超时复用 turnTimeout 面（300s）。

**D3 — 深度计算 = 会话级传播**: cell 的入站深度来源=HTTP 头，但委派发生在 WS 回合内——平台在 **turn 上下文**携带深度：人聊 a2a 条目=0；被委派任务执行时若其 prompt 来自远端（depth≥1 入站），该会话的再委派出站 depth=入站+1。实现：任务执行请求头读入站 depth 存进任务执行上下文；delegation-mcp 发任务时把「当前会话深度」写进任务元数据；远端执行时出站头=该值+1。人发起会话基线 0 → 出站 1。v1 简化：cell 侧入站深度只从 a2a 任务的执行上下文继承（人聊不设头=0），不做 WS 会话级深度表。

**D4 — runner 侧拒绝在 a2a 适配器**: `agent-runner/a2a.js` POST 入口：`const depth = Number(req.headers["x-delegation-depth"] || 0)`；depth≥3 → jsonRpcError(-32011, "delegation depth bound (3) reached")（不 acquire 不 spawn）。并发上限：manager 增 per-agent 委派在飞计数（depth≥1 的 turn），超 `AGENT_RUNNER_DELEGATION_MAX`（默认 2）时排队——复用既有 waiting 面（新等待条件），不失败不清占。

**D5 — 发现的数据面 = catalog 即真相**: `search_agents` 读 `catalog` 的 a2a 条目（名/描述/分类/tag，内存过滤+简单打分，N=8）；delegate 描述里的分类摘要由同一视图聚合（条目按 category 计数）。不建独立发现存储、不另拉 registry——catalog 的既有周期刷新即新鲜度。

**D6 — 权限与 UI**: delegate 工具既有权限门原样覆盖 a2a 目标（echo 先问）。任务卡/进度工具对 a2a 目标显示市场徽标（ref 即 catalog 名）；web/MP 任务卡组件加一个 type 徽标，不动布局。

## Risks / Trade-offs

- [M2M 凭证泄漏半径] → scope 仅 invoke_agent；轮换=删户重建（DEPLOY.md 记步骤）。
- [远端执行超时/挂起] → 300s 超时 + 任务引擎既有 interrupted 语义兜底（可重跑）。
- [catalog 刷新滞后导致 ref 失效] → 创建时校验在场；执行时 404/离线 → 任务失败带结构化错误（可重跑）。
- [深度头被伪造绕过] → 威胁模型内：调用方必须先过网关 invoke 门（M2M/admin），伪造深度只会让自己更早被断；跨诚实方的环由诚实 +1 保证。

## Migration Plan

纯增量：新工具/新目标类型/新执行分支，persona 委派零改动。ops 前置（scope+组）先行验证后部署；回滚=部署旧镜像+（可选）删 paas-agent-callers scope。

## Open Questions

- M2M 账户名稳定性（cellId 变更/重建时旧户清理）——实现期定命名与幂等重建策略，不影响结构。
- search_agents 的 N 与打分细节——实现期微调，不进 spec。
