# Design: publish-tool-gate-probe-degradation

## Context

`add-mcp-tool-scoping` 的发布门把 registry 条目 `tool_list` 当工具名真值，并以一次活探测兜底快照滞后。生产实测（2026-10-11）：三条已上牌 server 的公网 MCP 端点一律 `503 BILLING_UNAVAILABLE`——registry 预检（preflight）为 **fail-closed**，计费面不可达时公网路由整体拒绝，无论凭据如何。于是探测恒失败，快照滞后的合法名字被误报为「不存在」。

关键判断：**发布正确性不能依赖计费面的可用性**。计费面是运营状态，与「作者声明的工具是否存在」无关；把两者耦合会让发布门在计费故障时给出错误的事实断言。

## Goals / Non-Goals

**Goals**
- 探测不可达 ≠ 工具不存在：区分「确认不存在」与「无法确认」，两者都拒绝但给出不同且可执行的文案
- 让「刷新条目快照」成为一等、文档化、脚本化的运营动作

**Non-Goals**
- 不改商业集闭合逻辑（与探测无关）
- 不去修计费面 / 预检（运营域，且不是本门的职责）
- 不为发布门开内部通道：发布门跑在 facet（云端进程），拿不到 cheap-1 容器内的内部令牌，那条路对发布门不可行

## Decisions

### D1 失败分类进探测函数，文案分叉在门

`probeMcpToolNames` 把失败原因分类后留在 `lastError`（HTTP 状态 + registry 错误码，如 `BILLING_UNAVAILABLE`；401/403 归为「端点要自己的凭据」）。门自身只在两种形态间分叉：probe 返回名单 → 照旧判定；probe 不可用 → 输出 unresolved 文案。**分类信息不进面向用户的校验错误**（避免泄漏内部错误码），只进 note/日志与运维脚本。

### D2 快照刷新脚本化

`scripts/refresh-registry-tool-list.mjs`：读（运行时 tools/list，或 `--from-json` 已抓结果）→ 写（控制台会话 PATCH `tool_list`/`num_tools`）。配方登记进 `docs/registry-maintenance.md`，与台账对账同一入口。上游直连通常要上游自己的凭据（实测 401），registry token 不通——脚本对此给了明确指引。

### D3 拒绝不变，语义变

探测不可用时**仍然拒绝**（声明必须可验证），变的是断言强度：从「工具不存在」降为「无法确认 + 下一步」。这样既不静默放行，也不在计费故障时撒一个错误的谎。

## Risks / Trade-offs

- [计费面长期不可用时，快照滞后的合法发布会被持续挡住] → 缓解：拒绝文案直指刷新快照的脚本；快照一旦刷新即通过，无需等计费面恢复
- [`lastError` 挂在函数对象上（跨调用共享）] → 仅用于运维脚本与日志，不参与判定逻辑；并发调用下可能互相覆盖，但门不读它做决策
- [把 PATCH 凭据带进脚本] → 只从环境变量/参数读，不落盘、不进仓（脚本本身不含任何凭据）

## Migration Plan

纯实现延续，无数据迁移。`lib/publish-tool-gate.js` 的错误文案变化会影响发布拒绝的显示文本（编辑器/发布端仅透传），无形状变化。

## Open Questions

- 计费面当前不可达是临时故障还是常态（未验——需从 registry 容器内查 sub2api，本机不可达不构成证据）。若是临时故障，探测兜底本身无需改动，本 change 的分类与文案仍保有价值（下次故障时的行为更诚实）。
