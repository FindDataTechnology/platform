## Context

- 模型面的描述链：dsh 运行时 `dsh-mcp-client` 对生效 server 调 `tools/list` 取上游原文，`parseToolSchema` 原样透传；平台侧只做名字级裁剪（`writeToolFilterPatch` 生成 `tool-filter.json` allowlist/deny）与闭包闸对账（`lib/publish-tool-gate.js` 按名比对）。
- 既有 patch 通道先例：`tool-filter.json` 按 profile 组装写出、运行时消费、随组装再生——描述增强与它同节奏同机制，不发明第二通道。
- 数据上游：`add-mcp-annotation-overlay` 的 `canonical.brief`（可选字段）+ provenance；读面已透出。
- 用户裁定「双向都要」的智能体侧即本单；人读侧在 change ②。

## Goals / Non-Goals

**Goals**：模型面读到策展 brief；名字/schema/闭包闸零变化；publicFacing 防线不松动；开关可回原。

**Non-Goals**：运行时 LLM 改写；skill/persona 增强；描述热更承诺（下个组装周期生效）；人读渲染。

## Decisions

### D1: overlay 走既有 patch 通道（`tool-description-overlay.json`），与 tool-filter 同机制
profile 组装时由 `dsh-profile.js` 的 patch 写出序列追加生成；dsh-mcp-client 在 `tools/list` 消费点旁读它做追加/替换。
- **为什么**：tool-filter 已验证「组装期生成、运行期消费、再生刷新」的完整机制，复用即零新机制；平台代理改写（备选）要动 `tools/list` 链路，惊动面宽且破坏直连拓扑。
- **备选**：dsh-mcp-client 直读注释读面（拒：运行时跨服务依赖，组装期固化更可控）。

### D2: 追加默认、缺失替换
上游描述在前、brief 在后（标注分隔），上游空则替换。
- **为什么**：上游描述常含连接细节（鉴权提示、单位约定）策展者未必覆盖全，追加保底信息不丢；替换仅在无上游可保时发生。
- **备选**：brief 全量替换（拒：信息丢失风险，且策展负担升到必须复刻上游细节）。

### D3: publicFacing 生效面跳过增强
publicFacing 的内部词汇防线（删 server + deny 枚举）是 dsh-profile 注释里言明的唯一防线；brief 是人工策展内容，可能携带内部词汇。
- **为什么**：防线纪律优先于增强收益；publicFacing 面向终端用户，模型复述风险不可测。
- **备选**：策展侧保证 brief 无内部词汇后放开（拒：把安全判据押在内容自觉上，沿「安全判据落内容语义」教训先保结构）。

### D4: 快照附加可观测字段，不碰校验输入
工具面快照增 `enriched`（计数）与 `enrichment_source`（来源标注）；名字集合与校验结果零变化。
- **为什么**：增强是「面」的隐性行为，出问题时无观测即黑箱；快照是现成载体。

### D5: per-owner 开关存 owner 偏好面，默认开
沿既有 per-owner 偏好位（与资源微调同面），profile 组装读之。
- **为什么**：增强改变模型行为，owner 须有总闸；默认开让策展投入即刻兑现，关闭即回原保证可退出。

## Risks / Trade-offs

- [dsh 版本矩阵：overlay 消费是运行时新行为] → 按 `dsh-version-matrix` 纪律登记，旧 runtime 忽略 overlay 文件（天然向后兼容：不读即不生效）。
- [brief 与上游描述拼接超模型上下文压力] → brief 上限沿用注释层尺寸纪律（300 字符级），拼接截断策略＝保上游弃 brief 尾部并在快照标注。
- [追加策略使描述变长影响模型注意力] → 真机 A/B 观察工具调用成功率与 token 增量，入台账；劣化即翻转 D2 默认（单点改动）。
- [`add-mcp-annotation-overlay` 未上时本单空转] → 依赖声明明确：② 先行；② 无 canonical 时本单全部路径走「无 overlay」原状分支（测试覆盖该态）。

## Migration Plan

1. ② 的数据契约合入后：lib 读面 → overlay 生成（feature 可独立合，无 canonical 时生成空 overlay）→ dsh-mcp-client 消费 → 快照字段。
2. 出片走 dsh 版本矩阵：runtime 消费端与平台生成端可分班（旧 runtime 忽略 overlay）。
3. 回滚：per-owner 开关即时回原；镜像回滚无数据迁移。

## Open Questions

- 无。
