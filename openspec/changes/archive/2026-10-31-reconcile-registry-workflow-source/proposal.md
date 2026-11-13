## Why

官方 Registry 发布打通当天（2026-10-31），workflow 的两份副本已**双向分叉**：首发后新增的
`retire` 通道与默认 skip 名单只落在执行仓 `FindDataTechnology/mcp-registry-publish`（实际
运行的那份），主仓源里却只剩一行孤立的 `environment: mcp-registry`。指南
`docs/ecosystem/mcp-registry-publishing.md` §5「源在主仓、改完同步过去」的规则已被打破
一次；不消解的话，下一次照指南同步会抹掉 retire/skip、并带入执行仓从未建过的
Environment 引用——最坏的失败形态。

裁决（2026-10-31，用户委托代理）：**主仓是唯一真源**，执行仓退回纯镜像；
`environment` 门**不回灌**——空引用 = 假装有门，与指南 §3 拒绝伪造 `1.0.0` 的诚实论证
同构；真要加门按指南 §5.1.3 一步到位（补一行 + 执行仓建同名 Environment）。

## What Changes

- 把执行仓现役 `.github/workflows/mcp-registry-publish.yml`（dry-run + publish + retire
  通道 + 默认 skip 名单，无 environment 引用）整体回灌主仓源；
- 移除主仓源里的 `environment: mcp-registry` 孤行（随文件替换自然发生；生产从未生效过）；
- 回灌后两仓该文件逐字节一致，执行仓恢复纯镜像地位，无需改动；
- 消解 `docs/ecosystem/mcp-registry-publishing.md` §5 双副本分叉表与 §5.1.3 的分叉表述。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——纯运维调和 + 文档收口，不改任何 spec 级行为；投影需求
（`openspec/specs/ecosystem-access`）原样不动。按 `skip_specs: true` 走。）

## Impact

- `.github/workflows/mcp-registry-publish.yml`：内容替换为执行仓现役版（含 retire/skip，
  去 environment 行）
- `docs/ecosystem/mcp-registry-publishing.md`：消解分叉表 + §5.1.3 表述
- **运行时行为零变化**：retire/skip 在生产已生效，environment 门维持「无」的现状
- `FindDataTechnology/mcp-registry-publish`：无需改动（它已是目标形状）
