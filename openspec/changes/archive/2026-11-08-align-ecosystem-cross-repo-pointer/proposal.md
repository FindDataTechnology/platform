# ecosystem-access / ecosystem-curation 跨仓权威指针（N-22）

## Why

审计 N-22：这两个能力的需求主体**不在本仓**——开放注册、`wgk-` 键签发/吊销、组到
scope 的映射、过审流程、许可证裁决、出网白名单、容器托管与货架注册，全部实现在
注册表服务里（gitee `FindDataTechnology/mcp-gateway-registry`，OSS
`agentic-community/mcp-gateway-registry` 的 fork，cheap-1 docker compose 栈，网关
`mcp.finddatatech.cloud`）。paas 仓只有消费端缝。

现状的害处不是「写得不准」，而是**读者不知道去哪验收**：照 spec 在 paas 里找实现会
一无所获，写测试也只能测到消费侧；下一个人很容易把它当成本仓能力去改，或者反过来说
「这 spec 没实现」。

同族已有先例：`agent-memory-foundation` 的 Purpose 就写明「实现权威在 fd-memory 服务
仓……本 spec 是跨仓契约真源，paas 侧只有消费端缝」。

## What Changes

- `ecosystem-access` Purpose 补跨仓权威指针：权威仓、部署形态、paas 侧只剩什么缝、
  场景按哪一侧验收。
- `ecosystem-curation` Purpose 同上（并点明 `MCP-REGISTRY.md` 台账先行）。

**为什么走 `skip_specs` 而不是 delta**：OpenSpec 的 delta 只认 requirement，Purpose
只能在能力**首次创建**时由 delta 带入，事后修改的唯一通道是直接编辑主 spec（CLI 明确
允许这个例外；AGENTS.md「specs 只经 archive 改」不适用于 Purpose —— 见既有
`openspec-purpose-backfill` 处置记录）。把跨仓指针硬塞进某条 requirement 会伪造一条
没有行为含义的需求，比现在更糟。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无 requirement 变更）两组 spec 的 Purpose 已按上述例外直接更新，两侧
`openspec validate <cap> --type spec --strict` 均 exit 0。

## Impact

- 零代码改动；两处 Purpose 文本（`openspec/specs/ecosystem-access/spec.md:4`、
  `openspec/specs/ecosystem-curation/spec.md:4`）。
- 遗留：注册表仓自身的 spec 是否也需对称指针，属外仓事项，不在本单。
