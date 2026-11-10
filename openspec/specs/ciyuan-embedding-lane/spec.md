# ciyuan-embedding-lane Specification

## Purpose
萬星·词元的嵌入（embedding）能力契约：经既有 OpenAI 兼容 `/v1/embeddings`
入口供给向量化，规定其入口形状、模型与维度契约、上游池与失败转移、计费与上游
provider 钉扎口径、以及上游故障时的错误面，使内部消费方（文本引擎、法条检索）
共用同一契约模型与同一把内部密钥按量消费向量，并在上游波动时获得与其它能力
一致的可用性语义。

> 实现归属：sub2api fork 仓——本 spec 为跨仓行为契约，审计时按文件间一致性核对。

## Requirements

### Requirement: 嵌入能力经既有 OpenAI 兼容入口暴露

词元 SHALL 经既有 `POST /v1/embeddings` 入口供给嵌入能力，入口形状与调用方
已有 OpenAI SDK 零改造（换 `base_url` + key 即用）。嵌入 SHALL 复用 chat 入口
的鉴权链与账本（同 key 同身份同余额），SHALL NOT 引入独立的凭据体系或第二套
计量口径。调用方请求体中的 `model` 之外字段（含 `dimensions`）SHALL 原样
下发上游，除词元主动改写/剥除的字段外不得丢弃。

#### Scenario: 既有 SDK 换 base_url 即用

- **WHEN** 调用方把 OpenAI SDK 的 `base_url` 指向词元网关并使用词元 key 请求嵌入
- **THEN** 请求成功并返回 OpenAI 嵌入形状应答（`data[].embedding` + `usage`），
  该笔用量出现在该 key 的用量记录与余额扣减中

#### Scenario: 无效 key 拒绝口径一致

- **WHEN** 以无效/吊销 key 请求嵌入入口
- **THEN** 拒绝状态码与错误体形状与 chat 入口对无效 key 的应答一致

#### Scenario: 余额硬顶对嵌入生效

- **WHEN** key 余额或消费窗口已耗尽时请求嵌入
- **THEN** 请求被拒（口径同 chat 入口），上游供应商不被触达

### Requirement: 嵌入模型与维度为显式契约

词元对内供给的嵌入契约 SHALL 为单一模型 `Qwen/Qwen3-Embedding-8B`，其向量维度由调用方请求体的 `dimensions` 字段决定：显式传入 `dimensions=N`（如 1024 截断）时 SHALL 返回 N 维向量；未传时 SHALL 返回账号钉扎 provider 的原生维度（当前 Nebius 钉扎下生产实证为 4096），跨 provider 的向量空间一致性由账号级 provider 钉扎保证。词元 SHALL 拒绝维度不符的响应而不向调用方返回：请求声明了 `dimensions=N` 而任一响应向量不是 N 维、或同一批次内向量长度不一致时，SHALL 按上游异常口径处理并如实标注，不写入「长度正确的假向量」冒充成功；`encoding_format=base64` 的字符串向量与不含 `data` 数组的错误形状不在本守卫判定范围内。上游账号的模型名白名单 SHALL 放行该契约模型；SHALL NOT 因白名单过窄而使契约模型在生产不可达。本 capability 的范围 SHALL 限于经词元入口消费嵌入的调用方；不要求既有的非词元直连消费方改换上游或模型（其契约由各自 capability 规定）。

#### Scenario: 契约模型可路由且维度正确

- **WHEN** 调用方以契约模型名请求嵌入，显式带 `dimensions=1024`
- **THEN** 返回 1024 维向量，且该请求在词元侧可路由到至少一个已配置的上游账号
- **AND** 未传 `dimensions` 时返回钉扎 provider 的原生维度向量，SHALL NOT 被误判为漂移

#### Scenario: 维度不符被拒绝而非静默返回

- **WHEN** 上游返回的向量维度与请求声明的 `dimensions` 不符，或同批次向量长度不一致
- **THEN** 词元不向调用方返回该向量，按上游异常口径处理并如实标注，不写入「长度正确的假向量」冒充成功
- **AND** 该笔 SHALL NOT 计入调用方用量

#### Scenario: 同文本重复调用向量一致

- **WHEN** 对同一文本连续多次请求嵌入
- **THEN** 返回向量一致（词元 SHALL 保证该契约模型的候选不会落在不同向量空间
  的上游之间——多 provider 聚合渠道时由账号级 provider 钉扎实现，见
  「上游 provider 钉扎由词元侧账号级收口」）

### Requirement: 嵌入上游池可插拔且支持多账号轮转

嵌入能力 SHALL 由词元上游账号池供给（`openai` 兼容平台账号），池内多账号
SHALL 按调度优先级稳定序遍历，单账号上游失败时自动换下一个候选重试，全池
候选耗尽才返回嵌入级 5xx。账号失败 SHALL 按性质分级冷却并落持久层（跨重启
有效、管理面可见）：额度耗尽/鉴权失效类长时窗冷却，瞬态类短时窗冷却。更换
或新增上游供应商时，调用方 SHALL 零改造（模型名、入口形状、计量口径不变）。

#### Scenario: 单账号上游失败换下一候选

- **WHEN** 嵌入池内优先账号上游返回失败且池内存在次优先账号
- **THEN** 该请求由次优先账号完成，调用方收到正常应答；优先账号按失败性质进入
  分级冷却，管理面可见其冷却状态与原因

#### Scenario: 全池耗尽如实 5xx

- **WHEN** 嵌入池内所有账号均处于冷却或不可调度状态
- **THEN** 调用方收到嵌入级 5xx 统一错误体，不外泄上游细节，不计费

#### Scenario: 换上游供应商调用方零改造

- **WHEN** 契约模型的上游供应商发生变更（池内账号调整）
- **THEN** 对外入口形状、模型名与计量口径不变，调用方无需改动配置

### Requirement: 嵌入价目显式配置且无价可循时失败封闭

嵌入计费 SHALL 走既有 token 计费链路（按 prompt token 计，无 output token）。
因价格表默认不含嵌入条目，运营 SHALL 为契约模型配置分组或渠道自定义价目；
未配置时嵌入请求 SHALL 以「无价可循」失败（fail-closed），SHALL NOT 静默
按 $0 落账——静默零价会让上游成本无从对账。

#### Scenario: 已配价目按 token 计费

- **WHEN** 嵌入请求成功且契约模型已配置价目
- **THEN** 按上游回传 usage 的 prompt token 数与配置价目计费，余额扣减与
  用量行可在面板按模型区分

#### Scenario: 未配价目失败而非零价落账

- **WHEN** 嵌入请求成功但契约模型无任何价目来源
- **THEN** 该请求按「无价可循」处理并如实告警留存用量归因，SHALL NOT 视为
  一次正常的零成本成功

### Requirement: 上游 provider 钉扎由词元侧账号级收口

当上游为多 provider 聚合渠道（如 OpenRouter 同一 slug 下挂多个 provider）时，
契约模型的 provider 选择 SHALL 在词元侧账号级固化，请求体中的 `provider`
选择器 SHALL 由词元侧统一下发，调用方请求体自带的 `provider` 字段 SHALL 被
覆盖而非透传。词元 SHALL NOT 因上游渠道内部路由而在不同向量空间的上游之间
漂移；更换 provider 时 SHALL 保持对外模型名与维度契约不变。

#### Scenario: 同一模型多 provider 时钉扎单一 provider

- **WHEN** 上游渠道对同一契约模型提供多个 provider 且各 provider 向量空间不同
- **THEN** 词元按账号级固化的 provider 下发，全部请求落在同一向量空间，调用方
  无需感知也不得自带 `provider` 覆盖

#### Scenario: 调用方自带 provider 被覆盖

- **WHEN** 调用方请求体携带 `provider` 字段（如 `{"only":["X"]}`）请求嵌入
- **THEN** 词元以账号级固化值覆盖该字段后下发，不采用调用方所填值

#### Scenario: 换 provider 调用方零改造

- **WHEN** 账号级固化的 provider 需要更换（成本、可用性、向量一致性原因）
- **THEN** 对外模型名、入口形状、计量口径与维度契约均不变，调用方无感

### Requirement: 契约模型变更 SHALL 走显式全量重嵌且禁新旧向量混存

内部消费方的既有向量库 SHALL NOT 混存不同嵌入模型的向量——不同模型属不同
向量空间，混存会使检索静默返回错误排序且无人能发现。故消费方的嵌入模型发生
变更时，SHALL 走显式迁移流程：备份 → 清空旧向量 → 重建自检锚点 → 全量重嵌 →
复验锚点余弦与真实查询命中。重嵌过程 SHALL 幂等可续跑，失败即中断不静默跳过。
消费者 SHALL NOT 以「保留旧向量、仅新文档用新模型」的混合态上线。

#### Scenario: 模型变更后全量重嵌而非续跑

- **WHEN** 某消费方的嵌入模型由旧模型切换到契约模型
- **THEN** 该消费方的向量库存量点全部以契约模型重建，库内不残留旧模型向量

#### Scenario: 重嵌后自检门与真实查询双验

- **WHEN** 重嵌完成
- **THEN** 自检锚点余弦达到该消费方既有门槛（文本引擎 ≥0.999），且真实查询
  的语义检索返回带完整溯源信息的结果（非空、非降级）

### Requirement: 契约模型的候选池 SHALL NOT 混入不同向量空间的上游

承载同一契约模型的上游候选 SHALL 属同一向量空间：账号池内 SHALL NOT 同时存在
两个对同一模型名返回不同空间向量的上游账号（如不同量化/实现的同名模型）。
上游为多 provider 聚合渠道时，SHALL 由账号级 provider 钉扎收口（见上一条需求）；
未固化钉扎而该渠道确有多空间 provider 时，该状态 SHALL 视为不满足向量一致性。

#### Scenario: 未配 provider 钉扎时不静默轮换

- **WHEN** 上游渠道对契约模型提供多个向量空间不同的 provider 且账号级未固化
  provider 选择
- **THEN** 该状态 SHALL 被视为不满足向量一致性要求（按「同文本重复调用向量
  一致」Scenario 判定失败），运维 SHALL 先固化 provider 再宣称契约达成

#### Scenario: 一致性由池拓扑保证

- **WHEN** 对同一文本连续多次请求嵌入且池内存在多个候选
- **THEN** 各次响应来自同一向量空间的上游（契约模型的候选池 SHALL NOT 混入
  不同向量空间的上游），向量一致
