## Why

2026-10-30 对外产品介绍团队的**外部视角走查**（`docs/product-intro-walkthrough-2026-10-30.md`，
生产 pack `v8rZ8F7E92MrssZ92ygnXQ`「壹座产品介绍（官方种子）」，队伍 `fleet_1793319839709_2tgix6`）
暴露出四条平台面缺陷。走查的六问里，前台的分诊纪律与红线纪律在**文本层**质量很高
（跨线自答、法律→识律、部署位置零泄露），但团队形态的核心价值（前台问、专家答）
**在生产 web chat 车道尚未成立**。

| 编号 | 缺陷 | 走查实证 | 级别 |
|---|---|---|---|
| **B1** | 对外岗位的 chat 车道**不注入 `{{fleetContext}}`** → 前台不知道本队成员是谁，派发打不中本队 | 前台调 `mcp__fleet__dispatch_post` 时 `to` 填了**另一支旧队伍**的成员 id（`m_1792885292851_pb3g4x`），被「同集群」闸拒；全程 `GET /api/fleets/:id/turns` 恒为 **0** | 阻断级 |
| **B3** | 对外团队的 pack persona **MCP/工具面未收敛** → 内部车道名与内部产品面随工具描述泄漏 | 答案里出现 `wire-ops`、`facet-market`（内部车道/模块名）与「需求单/数据市场订阅」（`lib/board-adapters.js:323` 的柏讯 demands 面）；且该车道有 glob/grep/read/bash，模型会翻本机项目文件 | 高 |
| **B5** | 推理痕迹经 **web text 信道**外泄 | 访客可见 `<thinking>Let me check what wire-ops tools are available…</thinking>` 原样出现在 text delta（WeCom 车道已有 `stripReasoningLeak()`，web 文本路径未见同等剥离） | 中 |
| **B6** | pack persona 首启期返回 **`Agent is still initializing` 错误**而非排队等待 | 新装 pack 的 `intro-lex` 首启连试三次均得该错误；数分钟后同一 preset 正常应答 | 中（对外即第一句话报错） |

B1 的影响面不止本团队：**任何「对外多岗团队 + 访客直聊前台」的形态都受影响**——前台拿不到队友名单，
团队退化成独角戏。

## What Changes

- **B1 注入缝**：chat 车道为**已归属某队岗位**的 preset（`resolveAttribution` 能归到 persona 成员时）
  注入该队的巡视上下文：本队成员 ref/id 名单、编导边（可派发目标）、以及本队标识——
  与任务车道 `{{fleetContext}}` 同源（复用渲染器，不另造格式）。
  未归属任何队伍的 preset 不注入（保持普通 preset 行为不变）。
- **B1 派发寻址**：`POST /api/fleets/dispatch` 的 `to` SHALL 接受**成员 ref 或 title**（本队内解析），
  不再只认 member id——模型拿到的是名单与 ref，不是数据库 id。
- **B3 工具面收敛**：pack manifest MAY 声明 `publicFacing: true`（对外团队）；该声明下
  persona 聚焦时**只保留公开面**（默认：`fleet` 桥 + 市场公开面）与**关闭工作区文件工具**
  （glob/grep/read/bash 之外的文件读取默认不挂）。未声明的 pack 行为不变（既有官方种子零回归）。
  「哪些 MCP 面算公开面」需要产品拍板：默认名单 = `fleet` + 市场/目录公开面，
  `wire-ops`/`lex-ops`/`paper-trading`/`facet-market`/`facet-ops`/`fd-*` 等内部业务面默认剔除。
- **B5 推理痕迹剥离**：web 文本输出路径复用 `stripReasoningLeak()`（WeCom 已有），
  未闭合的 `<thinking>` 段一并剥到结尾，剥空时回兜底文本——访客永不可见推理痕迹。
- **B6 首启排队**：pack persona 首启期（运行时就绪等待窗内）SHALL 排队等待而非返回错误；
  等待耗尽才以结构化错误收场（与任务车道「有界等待 + skipped」语义对齐）。

## Capabilities

### New Capabilities
（无）

### Modified Capabilities
- `agent-fleet-core`：B1（chat 车道归属岗位注入本队上下文 + 派发按 ref/title 寻址）、B6（首启排队语义）
- `pack-authoring`：B3（对外 pack 的 `publicFacing` 声明与工具面收敛）
- `agent-runner`：B5（web 文本信道推理痕迹剥离）

## Impact

- 影响面：**对外多岗团队**（chat 车道归属岗位）。普通 preset（不归属任何队伍）零影响。
- 既有官方种子与在产舰队零回归：注入仅在归因成立时发生，工具面收敛仅在 `publicFacing` 声明时生效。
- 不改：不改 `{{fleetContext}}` 占位符契约、不改任务车道注入、不改编导边语义、不改 dispatch 的同集群闸与限流。

## 风险与缓解

- **注入面泄漏**：注入段含成员名单与编导（岗位级信息，不是内部运营信息）——对外团队的本队名单属于
  对外可用信息（团队成员角色名本就该对访客可见）；但**不含**节点、凭据、成本等运营面。
- **工具面收敛误伤**：官方种子若将来要声明 `publicFacing` 需逐个评估；本变更默认不声明，零影响。
- **排队语义变更**：首启排队的等待窗沿用任务车道默认 120 秒（部署可配），与既有 skipped 口径对齐。

## 走查证据链

- 走查实录：`docs/product-intro-walkthrough-2026-10-30.md`
- 铸造/上架：pack `v8rZ8F7E92MrssZ92ygnXQ` v3（manifest 1.0.2）
- 队伍：`fleet_1793319839709_2tgix6`「壹座产品介绍」（六岗全自载）
- 生产镜像：platform sha-eb4c93c（paas 4587726f）
