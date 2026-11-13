# Proposal: add-fleet-scheduler

## Why

机群已多机化（用户：现有十几台机器），两项刻意后置的能力必须现在落地：①**容灾**——runner 挂了它上面的 agent 就停（条目仍指死机器）；②**自动调度**——放哪台机靠人指定。多机越多，这两个手工点越不可持续。

## What Changes

- **调度器（facet 常驻）**：`gateway/fleet-scheduler.js`，30s 一拍读 observer board 心跳；**陈旧判定**（>90s 无心跳）→ 把该 runner 名下条目（含默认 runner 的未标注条目）**改点**到最空闲健康 runner（预算余量优先、同分少 child 优先、目标切片端口段须有空位——复用防撞探测）；注册处 GET→改 url/metadata→PUT 回写。**滞回**：迁走不回迁，旧机回归只接新活。
- **部署自动选址**：deploy 不带 runnerId 且机群表多行时 → 自动选最空闲健康机并显式打标；单行=旧行为（未标注归默认）；board 不可达=优雅回退旧行为。
- **第三分片 runner-c**（cheap-7，8891+32）：配方化第三台，证明加机是纯加法；llm 供应商库改 Secret+subPath 挂载（新机接入去手工化）。
- 降级语义明示：容迁=冷重建（pack/persona 从注册处重建），丢热会话不丢服务——记录在 spec。
- 不做：热迁移、跨机会话搬运、去中心化选举（单写者=facet 一个副本）。

## Capabilities

- `a2a-agent-serving`：部署选址 requirement 增补自动选址场景。
- `agent-runner`：新增 requirement——runner 失联后其 agent 自动改点到健康机（含默认 runner 未标注条目、滞回、容量门）。
