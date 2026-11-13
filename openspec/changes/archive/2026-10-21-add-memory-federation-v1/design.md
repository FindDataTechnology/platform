## Context

切片 4 前置 spike 已实证（fd-memory `docs/spike-hook-wire.md`）：ai-memory hooks 投递= `POST /hook?event&agent&cwd&ingest_key` + Bearer + body 原文，且 hook 恒先 spool、`recover` 排空。切片 2 的 fd-memory 已有人令牌族与 capture 内部管线；本设计只加协议门面与 cell 挂载。壹座 cell 侧约束：组合走 paas `dsh-profile.js`/`compose.js` 同族管线（cell 版），凭据注入走「凭据引用」纪律（值永不落明文配置）。

## Goals / Non-Goals

**Goals:** /hook 兼容端点（幂等）；platform 铸造面；NodePort（tailnet）；cell 挂载 v1（u/<owner>/p/cell、可关、降级开放）；本地接入配方 + 本机首批。

**Non-Goals:** stock 冷导入（迁移工具后续）；per-project cell namespace 拆分；公网暴露/Logto 自助；团队共享。

## Decisions

**D1 /hook 端点=纯协议门面，内部复用 capture 管线。**
query 四参（event/agent/cwd/ingest_key）+ body 原文 → 组装成既有 CaptureEvent 形状 → 同一 ingest（含脱敏）；namespace=人令牌 owner 的 `u/<owner>/p/<basename(cwd)>`（basename 为空回落 `p/cell`）。幂等表 `hook_dedupe(ingest_key, session_id, event, ts) PRIMARY KEY` INSERT OR IGNORE。备选「独立事件管道」被否：两套管线=两套脱敏/检索语义。

**D2 platform 族=第四令牌族，铸造面扩展现有 /admin/mint。**
`/admin/mint` 现有 runner-only → 改为 `runner|platform` 白名单分权：runner 铸 deployment（d/ 校验不变）；platform 铸 person（u/ 校验）。platform 族数据面全拒在 route 层一次拦（复用 runner 拒 MCP 的先例）。cell 后端持 platform 令牌（部署 secret 注入 paas 平台侧）。

**D3 cell 挂载点=cell 组合的 MCP 行注入 + persona 纪律同款追加。**
壹座 cell 的 dsh profile 物化在平台侧（与 runner 的 compose 同族但独立实现）：注入 `fd-memory` MCP 行（streamable-http + 人令牌 header）到 cell 的 MCP 组合；MEMORY_DISCIPLINE 文案复用 runner 侧同源常量（v1 壳层照抄，不引共享包——两仓独立交付纪律）。人令牌：cell 后端按 owner email 查缓存 → 无则 platform 代铸（label=cell:<owner>）→ 缓存（DB 持久化，重启不重铸）。开关：`CELL_MEMORY_ENABLED`（默认 0=字节零变化）。

**D4 namespace v1=每用户单项目 `p/cell`。**
cell 内会话没有稳定 per-project cwd 语义；v1 单项目保真（不造假拆分），per-project 拆分等 cell 侧项目概念成形再议。本地节点的 per-project 由 /hook 的 cwd basename 天然获得——两类消费者不同粒度，如实记录。

**D5 NodePort 暴露 + 鉴权即边界。**
fd-memory svc 增 NodePort（fd-prod 现有端口几何选号，PORTS.md 对账）；无公网。本地节点可选项：直投 NodePort（内网机）或经 observer 同款未来网关（v2）。

## Risks / Trade-offs

- [/hook 兼容随上游演进漂移] → 钉 3.0.0 实测行为（spike 在案）；上游变更=新 spike+显式迁移。
- [cell 挂载全平台面] → 默认关 + 灰度（先内部账号）；字节零变化纪律同 runner 侧先例。
- [人令牌经 header 入 cell MCP 行] → 与既有凭据引用纪律同源；泄露面=cell 组合文件，纪律同现状。
- [platform 令牌集中铸造权] → 部署 secret 单点、可吊销、审计行（label 带 owner）；不与计费键复用。

## Migration Plan

fd-memory：/hook+幂等+platform 族+单测 → 出片滚版（NodePort 同车）→ 本机 profile 接入实测。paas：cell 注入+代铸客户端+开关 → 出片滚平台镜像 → 灰度开 → 真机 cell 会话验收（三消费者互见 + 令牌矩阵）。回滚：CELL_MEMORY_ENABLED=0；NodePort 撤销无状态影响。

## Open Questions

- cell 的 owner 键用 email 还是 Logto sub（v1 用 email——与现有 ownerEmail 语义同源；sub 迁移留待 Logto 铸币统一案）。
- NodePort 端口号按部署时 PORTS.md 空位定。
