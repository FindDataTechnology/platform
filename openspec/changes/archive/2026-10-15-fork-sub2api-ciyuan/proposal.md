# fork-sub2api-ciyuan

## Why

萬星·词元线至今只是一个命名挂账（polish-fusion「内置模型」归属待查），背后没有实体；
而 sub2api 以原版 v0.2.7 直跑（2026-09-19），已落后上游 9 版且中间夹着安全修复
（0.2.14 默认管理员可爆破、EasyPay 回调伪造）。同时词元线的新需求——语音（ASR+TTS）、
rerank、serpapi 式搜索中转——是**转售生意**（池化上游 key、外部调用者按量扣费），
与 sub2api 的拼车模型同型，但上游 roadmap 零交集（纯 chat 订阅池方向）。分层加薄网关
会迫使平台 reimplement sub2api 的 key/分组/窗口/账本机器；fork 则原生复用。加上
ADR-0011/0014/0022 已把计费面定死在 sub2api（「它管钱，不管生意」），fork 是唯一
既保单钱包又保跟上游能力的形态。

## What Changes

- **fork sub2api @ v0.2.16 起**：org 私有仓 `sub2api`，tag 编码上游基线（`ciyuan-v0.2.16-1`
  = 上游版本 + fork 补丁级），首刀即还清落后 9 版+安全修复的欠账。
- **三条增量车道**（全部新增包，不动上游核心）：
  - `lanes/audio`：ASR + TTS，对调用者说 OpenAI 事实标准形状（`/v1/audio/transcriptions`、`/v1/audio/speech`）。
  - `lanes/rerank`：`/v1/rerank`（Cohere/Jina 式事实标准形状）。
  - `lanes/websearch`：**自有统一协议**（类 SerpAPI：engine 选择器 + 统一响应信封），
    对上多上游适配器（v1 先接 1-2 家）。
- **计量写回原生账本**：三车道各自计量（音频按字/秒、搜索按次、rerank 按请求/token），
  写入 sub2api 原生用量账本——key/分组倍率/消费窗口/用量面板/充值全复用；上游已有
  非 token 计量先例（ClinePass/TypeSafe 积分计费）。
- **谱系治理**（与 ADR-0017 registry 冻谱系成对的姊妹决策，见 ADR-0024）：月度合并窗
  + 安全快车道（notes 见安全字样立即滚）+ 只增不改缝点纪律 + fork-diff 台账 +
  能上游则上游（#6421 按 key 用量查询、虚拟用量端点为首批 PR 候选）。
- **三个月度窗检查点**：merge 痛感超一天/次即 consciously 降级（冻谱系 ADR-0017 模式
  或车道外提），不硬扛到失控。

## Capabilities

### New Capabilities
- `ciyuan-gateway-lanes`: 词元三车道（audio/rerank/websearch）的对外协议契约、
  上游适配器插拔、计量单位与账本写回。
- `ciyuan-fork-lineage`: fork 谱系治理——tag 版本语义、月度合并窗与安全快车道、
  只增不改缝点纪律、fork-diff 台账、上游回馈（PR）策略。

### Modified Capabilities

（无——sub2api 本体与平台侧均不改需求级行为；壹座/萬星对词元的消费是后续增量。）

## Impact

- 新仓 org/`sub2api`（私有，LGPL-3.0 保留；SaaS 运行无公开义务）；出片走标准
  GHA→TCR 线，ArgoCD `app-sub2api` bump。
- token.finddatatech.cloud 门面不变，产品名=萬星·词元（对应 registry 的 fd- 谱系做法）。
- 部署侧唯一变更 = 镜像 tag 从 `finddata/sub2api:0.2.7` 换 `ciyuan-v0.2.16-1`；
  现有 key/余额/分组零迁移。
- 上游关系：零 PR 历史→建立 PR 线（需签 CLA）；bmai 先例证明独立仓分叉在生态内是常态。
- 平台侧不动：registry 预检、萬星门面验钥、adjustBalance 结算对 sub2api 的依赖面不变。
