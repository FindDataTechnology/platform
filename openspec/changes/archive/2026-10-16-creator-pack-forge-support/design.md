# creator-pack-forge-support 设计

## Context

见 proposal（Why）。现状事实：facet 发布路由 `gateway/packs.js:799` 的门序列为
auth → creators 组 → manifest-required → 结构限额 → files 门（PACK_FILES_ENABLED，
按请求读 env）→ 工具声明门（registry 快照对拍，registry 不可达即 503 fail-closed）→
限流（**只计通过校验的发布**）→ 落库。各门错误形状已刻意统一（`lib/publish-tool-gate.js:49`
注释：errors 形状与 `validatePackManifest` 对齐以便编辑器同渲染）。壹座对 `/api/packs`
全前缀代理，新子路由零前端改动可达。

## Goals / Non-Goals

- Goals：dry-run 与 publish 的判词**逐字一致**且**靠构造保证**；validate 零副作用；
  非创作者可用（资格以 finding 报）。
- Non-Goals（设计层）：不做草稿落盘、不做 license 字段、不把 visibility/curation 下放；
  facet-market-mcp 的 `market_pack_validate` 工具与「谦面工坊」pack 内容属 finddata 侧
  独立 change，本设计只保证路由契约可被其直接转发。

## Decisions

### D1 门序列收敛为单一 verdict 收集器（本设计的核心）

把 publish 路由内联的门检查抽成共享函数 `collectPublishVerdict(manifest, { shortCircuit })`，
纯读：结构限额、files 门、工具声明门，**两个路由消费同一函数**。
publish 按原顺序回放判词、保持既有 status code 与响应体**逐字节不变**；validate 全量收集。
一致性由构造保证，不靠双实现同步。

实施期细化（对原文的两处修正，均由既有测试与注释逼出）：

1. **`shortCircuit` 开关**：publish 传 `true`，在任一更早的门失败后**不再继续**——
   保住既有注释承诺的性质"invalid attempts store nothing and cost only a
   pure-function validation"（被结构限额拒掉的发布不做 registry 往返，更不触发 live
   probe）。validate 传默认 `false`，跑满全部门再汇总。
2. **packId 续版检查不进收集器**：它在 publish 里位于**限流之后**，若并入收集器会改变
   "限流先于 404/403" 的既有顺序。改为 validate 路由内独立的只读检查（两行），
   判词直接复用 publish 的字符串。
3. **谓词形状容错**：validate 全量模式会带着结构上已非法的 manifest 走到 files 门与工具门
   （publish 不会），故 `declaresFiles` / `declaredToolsByServer` 改为容忍任意畸形形状
   （非数组、混合条目）而不抛——结构错误只报一次（structural 项），不升级成 500。
4. 顺手修正 `lib/publish-tool-gate.js:106` 的既有日志 bug：`missing.length - stillMissing`
   漏了 `.length`，日志里 "N name(s) confirmed by live probe" 恒为 NaN（只影响注记文本，
   不影响判词）。

替代方案（否决）：validate 里复制一份门逻辑——parity 从第一天起就是测试债。

### D2 validate 响应是信封而非状态码镜像

`POST /api/packs/validate` 恒 200（除匿名 401），体为
`{ valid: bool, errors: [...], caller: { publishEligible: bool, reason?: string } }`。
`errors` 为**全量收集**（publish 是早退，validate 一次给全——对创作者迭代是纯增益），
每项即 publish 对应拒绝响应的完整体（含 `code: "pack-files-disabled"`、`toolGate: true`
等标记，措辞逐字保留）。`caller` 独立于 `errors`：资格问题永不混入 manifest 错误，
"逐字一致"承诺因此可精确成立。

替代方案（否决）：状态码镜像（400/503 原样透传）——MCP 工具转发时要拆两种形态，
信封统一且不损措辞。

### D3 匿名与资格

沿用 publish 同一 auth 链（匿名 401 同形）；**不**做 creators 组拒绝，改为 `caller` finding
（`publishEligible: false, reason: "Creator group required"`——复用 publish 403 的原文）。

### D4 限流分离

validate 不触碰 `publishAllowed` 预算（与"只计成功发布"的既有注释精神同源）；
另设独立 per-caller 软上限（进程内，`createPublishRateLimiter` 同款实现，
默认 120 次/小时，`PACK_VALIDATE_RATE_MAX` / `PACK_VALIDATE_RATE_WINDOW_MS`
env 可调以便测试与运维），超限 429 且文案指明是 validation 桶。存在理由：工具声明门
带每 server 一次的 live-probe 回退，validate 若被 agent 循环滥用会成为探测放大器。

### D5 工具声明门直接复用

`runPublishToolGate` 已按可复用形状存在（快照对拍 + 单次 probe 回退 + commercial 闭合），
validate 原样调用；无声明工具的 manifest 零 registry 往返（与 publish 同语义）。

### D6 packId 续版只读检查

带 packId 时按 pack-store 既有读路径比对作者与存在性（publish 的 404/403 判词转为
errors 项）；无现成只读入口则补 4 行查询 helper，不写任何东西。

## Risks / Trade-offs

- [将来 publish 加新门，validate 漏跟] → D1 单收集器 + 双路由同源；另加一条 parity
  单测：同一批非法 manifest 双端对拍，publish 400 体 ⊆ validate errors。
- [validate 触发 tool-gate probe 放大] → D4 独立限流封顶；probe 每请求每 server 至多一次。
- [信封体被误当"发布成功"] → `valid` 仅表示判词；`caller.publishEligible=false` 时
  MCP 工具/技能文案必须同时呈现资格项（finddata 侧技能责任）。
- [jsonLimit/中间件漂移] → validate 与 publish 挂同一 `express.json({ limit: jsonLimit })`。

## Migration Plan

纯新增路由 + publish 内部等价重构（行为逐字节不变，既有路由测试为护栏）。无开关、
无数据迁移；回滚 = 移除路由。验证：单测（parity 语料 + 副作用断言）+ 相邻 packs
路由回归；生产眼见 = 匿名 401、创作者 200 信封、非创作者 200 + finding。
