## Why

每次新部署 Agent 服务，registry 的 `toggle?enabled=true` 健康探针在 runner 尚未拾取起服时失败（fresh/unknown 视为不健康），nginx `/agent/` 路由块只为健康条目生成且无周期修复循环——门面调用报 -32033 (405)，直到人工重发 toggle 才愈。部署路径现有的「upsert 后立即 toggle」（`lib/agent-serving.js:371`，2026-09-30 为安全扫描竞态所加）只覆盖了当刻，覆盖不了 runner ≤5min 的轮询拾取窗。每个新部署都会踩一次。

## What Changes

- `deployToRegistry` 成功后调度有界延迟重探梯（+90s / +210s / +330s，覆盖 ≤5min 拾取窗）：每档重发 `toggle?enabled=true`（重发即重探），条目已健康则早退；失败只记日志不抛、不影响部署响应。
- 前置一步只读诊断：在 cheap-1 上按 `docs/registry-maintenance.md` §6 写通道实锤 toggle 探针语义与响应形状（健康字段名、早退判据），修法参数据此微调。
- 不触 registry fork（周期修复循环方案明确排除）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `a2a-agent-serving`: 修改「Deployment propagates by polling within five minutes」——部署到达可调用状态 SHALL 全程无需人工干预：传播窗口内平台自动重探健康，直至条目健康、路由可生成为止。

## Impact

- 代码：`lib/agent-serving.js`（deployToRegistry 尾部加重探梯，约 :371 附近）；网关/部署进程内存中的定时器，进程重启即失（best-effort，可接受——重新部署或手动 toggle 仍是兜底）。
- 测试：`agent-serving` 相关单测（仓内 lib 侧测试形态）新增重探梯用例（伪 fetch 断言时序与早退）。
- 台账：验收后 finddata `MCP-REGISTRY.md` §3 销对应挂账行。
