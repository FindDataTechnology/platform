# curation-evidence Specification

## Purpose
供给条目的"过了什么审"是条目自身的一部分：证据字段可判定、可过期、可生成台账；缺证据的条目不能以可供给状态出现，出片与上架路径一律拒绝。

## Requirements

### Requirement: 条目携带结构化审校证据

供给目录的每条条目 SHALL 携带 `evidence` 对象，含：`axes`（逐轴结果，安全 / 许可证 / 质量，插件 species 另含 P1 / P2）、`pin`（上游仓库与 commit 或 tag）、`licence`（SPDX 标识）、`egress`（`none` / `allowlist(...)` / `open`）、`reviewedBy`、`reviewedAt`、`reviewValidUntil`（可空）。证据 SHALL 由人填写或由评审流水线写入，两种来源 SHALL 产出同一形状；SHALL NOT 存在只有流水线才能填、人或只有人才能填的字段。

`axes` 每一项 SHALL 带结论（通过 / 拒绝 / 需人工）与一句话理由；任一轴为"需人工"的条目 SHALL 视为证据不完整。

#### Scenario: 完整证据通过

- **WHEN** 一条 MCP server 条目带齐五轴结论、上游钉点、SPDX 许可证与出网决议
- **THEN** 该条目被判为证据完整，可呈现为可供给

#### Scenario: 缺轴即不完整

- **WHEN** 条目缺少出网决议，或某一轴为止于"需人工"
- **THEN** 该条目被判为证据不完整，错误点名缺失的轴

### Requirement: 缺证据不得呈现为可供给

出片前置与上架路径 SHALL 拒绝证据不完整的条目，SHALL 以非零退出码失败并点名条目与缺失项。读面 SHALL 把条目分为三态：`已审`（证据完整且在有效期内）、`待复审`（证据完整但已过 `reviewValidUntil`）、`缺证据`（不完整）。`缺证据` 与 `待复审` 的条目 SHALL NOT 以可供给状态呈现，SHALL NOT 被写入供给白名单。

#### Scenario: 缺证据条目阻断出片

- **WHEN** 供给目录里有一条缺出网决议的条目，且它被列入本次供给白名单
- **THEN** 出片前置失败，退出码非零，输出点名该条目与缺失项

#### Scenario: 过期转为待复审

- **WHEN** 某条目的 `reviewValidUntil` 早于当前日期且仍被列入白名单
- **THEN** 出片前置失败并要求复审；读面把该条目显示为 `待复审`

#### Scenario: 既有条目不清除

- **WHEN** 首次启用本规则时目录里的条目都没有证据字段
- **THEN** 这些条目被标为 `缺证据` 并保留在目录中，不被删除、不改其供给态以外的数据

### Requirement: 台账由条目生成

审校台账 SHALL 由供给目录条目生成，SHALL NOT 手工并列维护；生成物与条目不一致时 CI SHALL 失败（判据为生成物摘要，不依赖路径或时间戳）。生成物 SHALL 含每条条目的上游钉点、SPDX 许可证、出网决议、各轴结论与复审期限，SHALL NOT 含审校人之外的个人标识。

#### Scenario: 手改台账被拦

- **WHEN** 有人手工编辑台账条目然后跑 CI
- **THEN** CI 失败并指出生成物与目录不一致

#### Scenario: 新增条目自动进台账

- **WHEN** 目录里新增一条带完整证据的条目并重新生成
- **THEN** 台账出现该条目的完整记录，无需人工补写

### Requirement: 证据边界在 paas，采集在外部

paas SHALL 只定义与消费证据的形状和判定规则，SHALL NOT 实现许可证识别、依赖 adversary 扫描、出网分类或注入面启发式等采集器。采集器的实现与运行归属外部注册表仓的评审流水线；paas SHALL 接受人工填写的同形证据，SHALL NOT 因"未接流水线"而拒绝合法条目。

#### Scenario: 未接流水线仍可人工送审

- **WHEN** 某部署未接外部评审流水线，运营者按字段手工填写完整证据
- **THEN** 该条目判为证据完整，可进入供给

#### Scenario: 不因缺少采集器而放行

- **WHEN** 某条目声称"已由自动化审校"但没有逐轴结论字段
- **THEN** 仍判为证据不完整（声明不等于字段）
