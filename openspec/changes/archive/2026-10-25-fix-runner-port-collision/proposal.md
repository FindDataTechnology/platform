# fix-runner-port-collision

## Why

2026-10-25 生产实录（台账 §15.33）：寻数门面 reception 部署后与 daas-analyst 哈希同落 8809，serving runner 因 `EADDRINUSE` 无守护直接 crash loop（0/1×5 重启，全体 agent 下线）；修复靠手工 registry entry 打 `port_override`。取证坐实两层缺陷：①deploy 侧端口占用图构建在 try/catch 里**静默吞掉 registry 列表失败**（部署时 registry 正抖动，占用图全空→碰撞检测失效）；②runner 侧监听 listen 无 error 处理（unhandled 'error' = 进程崩，一个坏端口带走全部 agent）。

## What Changes

- **runner 侧**：per-agent 监听绑定失败（`EADDRINUSE` 及其他 listen error）改为 skip+loud warn（指名 agent/端口/修复指引），不崩进程、其余 agent 照常服务；监听失败按 key 节流（5 分钟）防日志轰炸，后续 reconcile 周期自动重试绑定（runner 恢复自愈入口保持）。
- **deploy 侧**：端口占用图的 registry 列表失败从静默降级改为 loud warn（降级行为本身保持——registry 瞬断不应拒绝部署），让「碰撞检测已退化」可见。
- 单测钉住两侧行为。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `agent-runner`: 新增 requirement——单个 agent 的监听绑定失败 SHALL NOT 危及其他 agent 的服务；SHALL 指名告警且可自愈重试。
- `a2a-agent-serving`: 新增 requirement——部署端口占用图的 registry 列表失败 SHALL 指名告警（碰撞检测退化为纯哈希必须可见），降级行为不变。

## Impact

- `agent-runner/manager.js`（#ensureListener error 处理 + warn 节流）、`lib/agent-serving.js`（占用图 catch 加 warn）；部署面=platform 镜像三面 + runner deployments（agent-runner-serving/b/c 同镜像）。
- 风险极低：均为防御性分支，正常路径逐字节不变。
