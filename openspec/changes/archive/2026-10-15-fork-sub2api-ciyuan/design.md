# fork-sub2api-ciyuan — design

## Context

上游 Wei-Shaw/sub2api：Go（Ent ORM + Gin）+ Vue3（pnpm），PostgreSQL 16 + Redis，
LGPL-3.0，CI 三套（backend-ci 单测+集成、security-scan govulncheck+gosec、release），
发版节奏约每周 2 版。平台侧现状：原版 v0.2.7 经 ArgoCD `app-sub2api` 直跑
（`finddata/sub2api:0.2.7`），计费面三 ADR（0011/0014/0022）+ registry 预检 +
萬星门面验钥 + adjustBalance 结算全部依赖其行为面，本 change 不动任何依赖方。
生态先例：bmai（bayma888/sub2api-bmai）= 独立仓分叉 + 自有品牌，上游收编其 DEV_GUIDE，
证明独立仓分叉是生态常态。

## Goals / Non-Goals

**Goals:**
- 词元成为实体：org 私有仓 `sub2api`，`ciyuan-vX.Y.Z-N` tag，token.finddatatech.cloud
  门面不变、key/余额零迁移。
- 三车道 v1 上线：audio（ASR+TTS）、rerank、websearch（自有统一协议）。
- 计量写回原生账本：复用 key/分组倍率/消费窗口/用量面板/充值。
- 谱系治理落地：月度窗 + 安全快车道 + 缝点纪律 + fork-diff 台账 + 首批上游 PR 候选。

**Non-Goals:**
- 不改 sub2api 上游核心（chat 订阅池/流式/协议转换/OAuth 适配）。
- 不动平台侧依赖面（registry 预检、門面验钥、结算通道、行数门）。
- 不做壹座/萬星对三车道的消费集成（后续增量 change）。
- 不做实时语音（v1 只做 ASR+TTS 请求-响应式）。
- 不自定义 audio/rerank 协议（用事实标准）；websearch 才是自有协议。
- 不在本 change 内推 PR 合入上游（候选列出，回馈是持续动作非门）。

## Decisions

### D1 fork 形态：增量谱系，tag 编码上游基线

- 仓：org 私有 `sub2api`（真独立仓非 GitHub-fork 关系，同 bmai 模式——保留自有
  CI/release 线自由度；上游以 remote `upstream` 挂着）。
- tag：`ciyuan-vX.Y.Z-N`（X.Y.Z=合并进来的上游 tag，N=fork 补丁级，从 1 起）。
  落后度一眼可见；每次月度窗产出一个新 tag。
- 首刀从 **v0.2.16** 起 fork（不是从 0.2.7 追），首窗即还安全欠账。
- 备选否决：①「上游加层薄网关」——转售模型要 reimplement 全套 key/窗口/账本机器；
  ②「冻谱系 ADR-0017 模式」——与「定期跟上游」诉求相反（那是三个月度窗痛感超标后的
  降级路径，不是起点）。

### D2 车道架构：只增不改，缝点白名单

```
backend/internal/lanes/           ← 全部新代码，单向依赖上游公共设施
  audio/    router + provider(火山/硅基…v1 选 1-2) + meter(字/秒)
  rerank/   router + provider(硅基/Jina…v1 选 1-2) + meter(请求/输入 token)
  websearch/router + provider(SerpAPI/博查…v1 选 1-2) + meter(次)
```

- 对调用者契约：audio/rerank 用事实标准（OpenAI `/v1/audio/*`、Cohere/Jina 式
  `/v1/rerank`）；websearch 用自有统一协议（D3）。
- 缝点（fork 唯一允许触碰的上游文件，进台账）：路由注册表、账号类型枚举（若上游
  账号模型收编非 chat 上游）、计量/账本写入钩子、前端导航与车道页、i18n 词条。
  v0.2.15 起平台清单已配置驱动——新「平台」尽量走清单而非改库表。
- 认证与鉴权：复用 sub2api 既有 API key 中间件，车道路由挂同一链——外部调用者
  拿词元 key 即用三车道，无需新身份体系。

### D3 websearch 统一协议（类 SerpAPI，自有形状）

- `POST /v1/search`：`{engine, q, num, ...engine 透传参数}`；engine ∈ v1 上游集。
- 统一响应信封：`{meta:{engine, latency_ms}, results:[...归一化条目], usage:{requests:1}}`；
  归一化条目 = `{title, url, snippet, position, raw?}`。
- 设计取向：调用者说一套协议，换 engine 零改造；上游差异吞在适配器里。透传模式
  （调用者直说 SerpAPI 协议）否决——多上游无法归一、计量口径分裂。

### D4 计量与账本：写回原生用量账本

- 单位映射：audio ASR 按音频秒、TTS 按字符；rerank 按请求（输入 token 计价则记
  token）；websearch 按次。上游积分计费（ClinePass/TypeSafe）已有非 token 先例，
  车道用量以「积分」位面进账本，分组倍率/消费窗口/面板自然生效。
- 价目表：车道独立价目（admin 后台配置），不与 chat 模型价目混表。

### D5 月度合并窗（仪式）与安全快车道

- 月度窗：读全部 release notes → merge 上游 tag → 仅缝点解冲突 → 跑上游三套 CI
  本地等价（单测+集成+lint+govulncheck）+ 车道测试 → GHA→TCR 出片 `ciyuan-vX.Y.Z-N`
  → ArgoCD bump → 探针（现有 sub2api 探针 + 车道冒烟）。
- 安全快车道：notes 含安全字样（默认管理员/支付回调/爆破/越权类）→ 不等月度，
  单独滚一窗。
- 产出物：每次窗后在 fork-diff 台账登记（上游 tag、冲突缝点、出片 sha、探针结论）。

### D6 上游回馈（能上游则上游）

- 首批 PR 候选：①按 key 自助用量查询端点（上游 issue #6421，ADR-0011 已等）；
  ②虚拟用量端点（ADR-0014 backlog，萬星门面结算切账本权威的前置）。
- patches 保持 cherry-pickable 单提交；需签上游 CLA。每合入一个，fork diff 永久缩小。

### D7 三个月度窗检查点（降级预案）

- 连续三个月度窗记录 merge 用时；单窗 >1 天 → 触发降级决策会：冻谱系（ADR-0017
  模式，安全单行道）或车道外提（独立服务）。consciously 降级，不硬扛。

## Risks / Trade-offs

- **Go 谱系维护是新领域**（团队栈 Node/TS+Python）：车道是无状态 Go、月度 merge
  机械，AI 辅助可控；D7 检查点兜底。
- **上游高_velocity 重构**（DB 迁移/前端改版会撞缝点）：缝点白名单把冲突面锁死；
  v0.2.15 平台清单化在降低此类摩擦。
- **LGPL-3.0**：SaaS 运行零公开义务；若将来随私有化交付分发词元，fork 源码须
  可得——薄车道架构使届时拆出（车道外提）仍是退路。
- **非 chat 计量进原生账本的阻抗**（token 位面 vs 次/字/秒）：若上游账本强绑
  token 语义，则车道以积分位面写入；极端不兼容时车道本地记账+adjustBalance 结算
  回账本（复用 settlement v2 通道）作为 fallback。
- **0.2.7→0.2.16 一步跨 9 版**：上游含破坏性变更（0.2.14 自动安装行为）；现网
  已装实例不受影响，但升级窗需按上游升级指南逐项核对 env 与 DB 迁移。
