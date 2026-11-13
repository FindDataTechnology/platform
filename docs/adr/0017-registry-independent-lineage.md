# The registry runs an independent fork lineage with a security-only upstream lane

ADR-0015 把自部署 mcp-gateway-registry 归屋为谦面组件时，采用了「软件不重写（继续 OSS + fork 补丁模式）」——隐含持续追平上游。2026-10-05 grill 定案放弃这一隐含条款：上游三个版本滚 238 个提交而我们 16 个，消费面只是目录+鉴权+转发的一角；我方差异化能力（per-user 长命 key、sub2api 额度预检）上游没有对应物（已核 1.32.0 全树）也不会收；生产谱系已裂成三条漂移线（registry-1=上游 1.30.0 预构建、auth-server=1.29 基线+补丁、mcpgw=`latest`）。**决定：最后收敛到上游 1.32.0 一次付清，自 `fd-1.0.0` 起转入独立迭代谱系，功能上永久停止追平。**完整决策过程与任务分解见 openspec change `hard-fork-registry`。

## Considered Options

- **持续追平**（周期性 catch-up merge + 补丁重放）：追平税与消费量不成比例，且我们的「补丁」已是产品功能（wgk 铸造、计费预检），重放之舞不可持续——弃。
- **立刻切断**（在 fork main 1.29 或生产 parity 1.30 上）：把上游公开记录的已知安全缺口焊进自有谱系（读面越权过滤、url_guard 修复尽失），控制台可见降级，wire 3.2 仍是开发题——弃。
- **最终收敛到 1.32.0 再切**（本决策）：一次性付清拿到全部安全修复与 1.31 按调用者读面过滤（wire 3.2 从写代码变配 org+scope），完整测试套随新鲜支线回来，安全单行道自此有可行的低成本轨道。
- **重写为谦面原生服务**：维持 ADR-0015 的推迟结论不变；独立谱系降低了未来重写的比较成本，但不改变触发条件。

## Consequences

- **安全责任完全内化**：上游安全修复断供转为「安全单行道」——发版 notes 一周内评估、仅安全提交摘取（cherry-pick + 全量 pytest + 钉版换镜像），台账在 `docs/registry-fork-patches/`（谱系账本）。保守瘦身收窄自有攻击面（6 个未用 IdP provider、多云面、metrics-service）；激进瘦身（skills/ARD/federation）暂缓，因其为上游安全修复高频落点。
- **版本身份换轴**：`fd-x.y.z` 自有版本线，上游数字不再是比较轴；控制台横幅打 fd 标；栈内镜像全钉版（含 mcpgw）。
- **生态漂移被接受**：MCP 语义冻结在 1.32 时代——可接受，因为六个注册 server 皆我方自有、随自家 agent 演进；若未来对外生态互操作收紧，重估。
- **对冲**：patch ①（per-user 长命 key）PR 上游以缩小分歧面、降低未来安全摘取成本；PR #1791（logto）继续养。
- **supersede**：取代 ADR-0015「继续 OSS + fork 补丁模式」条款；归屋结论与 runtime-source / 消费契约不变。wire-platform-v1 的 3.2/4.4 随收敛落地解堵。
- **CI 门槛（2026-10-05 修订原「不建 CI」决定）**：GitHub 侧归 **FindDataTechnology/mcp-gateway-registry**（私有仓，自 law-ai-official 转移而来，默认分支 fd-1.0.0）；GitHub Actions 保留两个测试套 workflow（auth-server / registry，`fd-*` 分支 push 自动触发），换镜像前以两套绿为门槛，本地全量运行为可选项。上游其余 CI（release/build/helm/terraform/metrics/docs/dependabot）随瘦身删除。

## 修订（2026-10-07）：「生态互操作收紧」条款首次触发，复核通过

add-ecosystem-bridge 入向开源 MCP server 首次触发本 ADR 的重估条款。复核结论（证据链见 `docs/registry-fork-patches/2026-10-07-ecosystem-bridge-compat-audit.md`）：

- 「MCP 语义冻结在 1.32 时代」比当初假设的**窄**：冻结的是注册处自身 API 代码；传输栈依赖 `mcp>=1.9.3` 浮动下限，随镜像构建前进（fd-1.0.0 的 SDK 已支持 2025-06-18 协议族）。线上实证：wire 客户真回合（2026-10-05）与 401 探针（2026-10-07）均过。
- **决定：谱系不变。** 精选开源 server 按现有接入机器进注册处（注册→探测→代理），stdio-only server 由托管层包 HTTP 壳（1.4 决议），**不为生态兼容在注册处侧写定制协议代码**——上游 server 要求注册处不支持的传输扩展时该 server 出局（出局规则原文见台账）。
- 已知缺口随 5.1 修：401 双 WWW-Authenticate 头；探测-注册竞态写进 1.4 操作步骤。
