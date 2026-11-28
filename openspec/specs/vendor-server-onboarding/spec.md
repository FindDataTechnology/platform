# vendor-server-onboarding Specification

## Purpose

供方上牌闸：供应商自有 MCP server 经准入审查、工具面声明与 selfcheck 后，由平台 workflow 代客写入 registry 的准入通道——对上沿用 anatomy（manifest/selfcheck/台账），对下保持 registry 为内部资源、供应商永不直触 registry。



## Requirements

### Requirement: 供方上牌准入审查

供应商为上牌提交的准入材料 SHALL 覆盖：主体信息（vendor-identity）、server 元信息（名称、版本、上游仓与许可证、托管形态）、工具面声明与商业集声明。准入审查 SHALL 逐轴记录结论（准入/拒绝+拒绝轴）；许可证不合、材料不全、主体名下配额超限 SHALL 各自如实分类拒绝，SHALL NOT 静默放行。审查通过的 server 才进入登记轨。

#### Scenario: 材料不齐如实拒

- **WHEN** 供应商提交的准入材料缺少许可证或上游来源字段
- **THEN** 审查以「材料不全」分类拒绝并指明缺失轴，registry 不发生写入

#### Scenario: 配额超限拒在准入

- **WHEN** 供应商名下在册 server 数已达其配额档上限时再提交新牌
- **THEN** 审查以「配额过闸」分类拒绝，并呈现当前用量与配额档

### Requirement: 工具面声明与自检

上牌 server SHALL 声明完整 tool-surface manifest（每个工具的输入/输出形与商业集归属，沿用 registry-bridge 的 `metadata.surface.commercial_tools` 语义），且 SHALL 通过平台 selfcheck（协议握手连通、声明工具逐一可列举、商业集声明与实得工具集闭包一致）。声明缺失、自检失败、闭包超集 SHALL 各自如实分类拒绝，SHALL NOT 降级放行。

#### Scenario: 闭包超集被挡

- **WHEN** server 声明的商业集工具与其 selfcheck 实得工具集不一致（声明为超集）
- **THEN** 上牌闸以「声明不全/商业集挡」分类拒绝并列出差异工具名

#### Scenario: 声明完好的 server 通过自检

- **WHEN** 工具面声明完整且 selfcheck 全部通过
- **THEN** server 进入登记轨并携带其工具面声明

### Requirement: 平台代客写入 registry

上牌 server SHALL 经平台 workflow 以平台凭据写入 registry（register + toggle 启停），供应商 SHALL NOT 持有 registry 写凭据、亦不设任何供应商直触的 registry 公开端点。registry fork 保持内部使用；接入形态 SHALL 同时支持 vendor-hosted（供方自托管，平台按访问姿态通车）与 platform-hosted（平台托管，沿用 ecosystem-curation 的 per-server egress posture），为未来外部 MCP 接入预留同一 workflow 车道。上牌完成 SHALL 落台账（主体、server、版本、时间、操作轨迹）。

#### Scenario: 上牌成功落台账

- **WHEN** 审查与自检通过的 server 完成 registry 登记
- **THEN** registry 中该 server 启用可查，台账记录供应商主体、来源与登记时间

#### Scenario: 供应商无 registry 直写面

- **WHEN** 供应商尝试直接调用 registry 的 register/toggle 端点
- **THEN** 请求被 registry 现有的运维鉴权拒绝，平台 workflow 是唯一写入路径

### Requirement: 上牌状态对供应商可见

供应商 SHALL 可在平台看到自己名下各 server 的上牌状态（审查中/在册/被拒+拒绝轴/已停），状态与台账一致、不虚构。上牌完成的 server SHALL 可被 pack 以 `registryName` 引用，引用与在册校验语义维持既有四闸逐字节一致。

#### Scenario: 被拒状态如实呈现

- **WHEN** 供应商查看一张被拒上牌单
- **THEN** 状态为被拒且带审查记录的拒绝轴，重新提交入口可用

#### Scenario: 在册 server 可被引用

- **WHEN** pack manifest 以 `registryName` 引用一张在册供应商 server
- **THEN** 发布门与安装链按既有语义处理该引用，与平台自有 server 无差别
