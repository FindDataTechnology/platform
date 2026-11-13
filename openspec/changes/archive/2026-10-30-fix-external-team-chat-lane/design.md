# 设计：对外团队 chat 车道（fix-external-team-chat-lane）

## 1. 背景与边界

走查实录见 `docs/product-intro-walkthrough-2026-10-30.md`。本设计只处理四条平台面缺陷
（B1/B3/B5/B6），不处理走查中已在本仓修掉的两条文案缺陷（B2 前台不知开源、B4 persona 文案越界）。

**车道命名**：本文的「chat 车道」= 用户在 web chat 里与某个 **preset** 对话的那条运行时车道
（`POST /api/chat` 家族 → WS `prompt` → 运行时子进程起轮）。任务车道（cron/补跑/手动戳发）
是另一条，已有 `applyFleetContext` 与 `fix-fleet-context-injection-seam` 在治理，本变更不碰。

## 2. B1：归属岗位的 chat 车道注入本队上下文

### 现状
- 归因能力已存在：`resolveAttribution({currentPreset, runningTasks, personaMembers, rosterPresetId})`
  （server/routes/fleets.js:920 的 dispatch 路由与 fleet 桥共用）——它能把「当前 preset」归到
  某队的 persona 成员。
- 注入能力已存在：任务车道的 `applyFleetContext` 把 `{{fleetContext}}` 渲染成巡视上下文段。
- 缺口：chat 车道**从不调用**它。模型侧拿不到本队成员名单/ref、也拿不到编导边。

### 决策
**注入点**：与任务车道同源——在 chat 车道的起轮处（运行时收到 prompt 之前）组合最终 prompt，
而不是在入队处写 promptOverride。理由与 `fix-fleet-context-injection-seam` 一致：
入队路径不止一条，缝设在唯一汇合点才不漏。

**注入范围（收窄）**：仅当该 preset **归因到某队的 persona 成员**时注入。归因失败/不唯一/
未归属 → 不注入（普通 preset 行为零变化）。

**注入内容**：本队标识、成员清单（ref + title + 目标 preset id，**不含** member id 这类数据库
内部标识）、编导边（可派发目标集合）。用**同一渲染器**产出（`applyFleetContext` 的段），
不另造格式——任务车道与 chat 车道的上下文段因此一致。

**安全边界**：注入段只含**岗位级**信息（本队有哪些角色、能派给谁）。不含节点/凭据/成本/
拓扑等运营面——对外团队的本队名单本就该对访客可见。

### 派发寻址（配套）
`POST /api/fleets/dispatch` 的 `to` 目前只接受 member id（`db.getMember(toRef)`）。模型拿到的是
ref/title 名单，于是它去猜数据库 id（走查实证：猜了**另一支队**的 id）。
**决策**：`to` 接受本队成员的 **title**（大小写不敏感、限本队内解析），member id 继续支持；
歧义（同名多个）时 400 并列出候选。
**实施注**：成员行只存 id 与 title（模板的 ref 在建队时被映射成 member id，不落库），
所以寻址面是「title + member id」两形；注入给模型的名单也据此给 title（人/模型读得懂的），
并标注哪个可派发。

## 3. B3：对外 pack 的工具面收敛

### 现状
pack persona 的 MCP 聚焦由 `dsh-profile` 决定（生产日志实证）：
`focused on pack "壹座产品介绍（官方种子）" persona "intro-guide": keeping [facet-market,
paper-trading, wire-ops, actions, fleet, playwright]`。内部业务面（wire-ops/lex-ops/
paper-trading/facet-market/facet-ops/fd-*）的工具名与描述会进模型上下文，于是：
- 内部车道名被复述（`wire-ops`/`facet-market`）；
- 内部产品面被复述（柏讯「需求单」面来自 `lib/board-adapters.js:323` 的 demands 台账）；
- 工作区文件工具（glob/grep/read/bash）让模型去翻本机项目文件。

### 决策
manifest MAY 声明 `publicFacing: true`。声明后：
1. **MCP 面**：只保留 `fleet` 桥 + 市场/目录公开面；内部业务面默认剔除。
   **默认名单**（用户 2026-10-30 拍板）：`fleet` + 市场/目录类前缀（`market*`、`market-catalog`、
   `fd-official-web`）+ `websearch`；**默认剔除**：`wire-ops`、`lex-ops`、`paper-trading`、
   `facet-market`、`facet-ops`、`fd-*`（内部分析面）、`pack-author`、`blueprint-author`。
   名单以 `PACK_PUBLIC_FACE_MCP` 环境变量可配（不配即默认）。
2. **工作区文件工具 + 名册枚举工具**：`publicFacing` 下禁用
   `glob`/`grep`/`read`/`bash`（读本机项目文件）与
   `list_agents`/`list_mcp_resources`/`tool_search`（**枚举内部工具名——走查里 wire-ops 就是这么被发现的**）。
   这两类不是 MCP 服务器，工具面闸管不到它们；闸在 **tool-scope 桥的 deny 通道**
   （`tool-filter.json` 的 `denyTools` 段 → 桥的 guard 拒调 + restrict 移出名册）。
3. 未声明的 pack **行为完全不变**——既有五枚官方种子、在产舰队零回归（`denyTools` 段缺省即不拒）。

### 文案侧兜底（已在 v1.0.2 落）
六岗 persona 均已加「不得提及内部车道名/模块名/工具名」「不要为回答访客而检索本机项目文件」的
硬指令，并钉进红线测试（`scripts/test-product-intro-seed.mjs` 7/7）。**实证：文案硬化不足以替代
工具面收敛**（走查复测里 persona 已删净仍复现「需求单」）——文案是缓解，工具面才是根治。

## 4. B5：web 文本信道推理痕迹剥离

`server/bots.js` 已有 `stripReasoningLeak()`（REASONING_BLOCK_RE + 未闭合剥到结尾 + 剥空回兜底），
用于 WeCom 出站。web 文本路径未见同等剥离——访客可见 `<thinking>…</thinking>`。
**决策**：把该剥离做成共享工具，web 文本输出路径与 bot 出站路径共用；剥空时回兜底文本，
绝不输出空回答。

## 5. B6：pack persona 首启排队

现状：新装 pack 的 preset 首次使用时，运行时未就绪 → 直接回 `Agent is still initializing` 错误。
任务车道已有「有界等待 120 秒 → 耗尽记 skipped」的语义。
**决策**：chat 车道对齐任务车道——等待窗内排队等待（可配），耗尽才以结构化错误收场。
排队期间 UI/WS 侧按既有 queued 语义呈现（不新增前端状态机）。

## 6. 风险

| 风险 | 缓解 |
|---|---|
| 注入面泄漏内部信息 | 注入段只含岗位级信息；渲染器复用既有 `applyFleetContext`（其内容已被既有红线治理） |
| 工具面收敛误伤在产官方种子 | 仅 `publicFacing: true` 生效；既有种子不声明 → 零影响 |
| dispatch 寻址放宽引入歧义 | 同名歧义 400 + 列候选；跨队成员仍 400 |
| 排队语义变更影响前端 | 复用既有 queued 语义，不新增前端状态机 |

## 7. 未决（**2026-10-30 用户拍板定案**）

1. **公开面名单**：采纳默认名单——**只留 `fleet` 桥 + 市场/目录公开面**；
   **默认剔除**内部业务面：`wire-ops`、`lex-ops`、`paper-trading`、`facet-market`、`facet-ops`、
   `fd-*`（内部分析面）、`pack-author`、`blueprint-author`。名单以配置为准，单测钉住。
2. **`publicFacing` 显式声明**：采纳——manifest 里写 `publicFacing: true` 才收敛；
   未声明的包行为完全不变（既有五枚官方种子与在产团队零回归）。不按类目/作者自动推断。
3. **注入粒度**：采纳**裁剪版**——chat 车道只注入「本队成员清单（ref + title + 目标）+ 可派发目标集合」，
   **不带**报数/拍板/自己近轮等任务语义（任务语义在对话里无用且占 token）。
   注入段用独立渲染函数（与任务车道的 `applyFleetContext` **同源数据、不同裁剪**）。
