# Proposal: add-port-collision-avoidance

## Why

分片机群已上线（add-runner-fleet-sharding），但每 agent 端口 = `hash(路径) mod 32`——同一 runner 上 7 个 agent 时撞名概率约一半（真实发生过，在册），撞了第二个 agent 永远起不来（EADDRINUSE 循环）。且部署侧写的注册 URL 与 runner 绑定端口必须永远一致，单端改判会造成 URL 指错端口。

## What Changes

- **改判即数据**：部署时检测目标 runner 切片内的端口占用（哈希位被占→向上探测首个空位），把改判端口写进 descriptor 的 `port_override`——两端（部署 URL 计算/runner 绑定）都按同一份数据算，不引入回写协议。
- **稳定性**：已带 `port_override` 的部署保持原值不漂移；无撞名部署零字段零行为变化（逐字节兼容）。
- **范围校验**：runner 只认落在自身 `[base, base+span)` 内的 override，垃圾数据回退哈希。
- **诚实失败**：端口段耗尽时部署显式报错（提示扩 span），不静默错位。
- 段宽不动（改 span 会改变全部存量哈希端口=断所有 URL）。

## Capabilities

### Modified Capabilities

- `a2a-agent-serving`：部署选址 requirement 增补端口防撞场景（探测+override+耗尽报错）。
- `agent-runner`：托管 requirement 增补 override 绑定场景（范围校验+回退）。
