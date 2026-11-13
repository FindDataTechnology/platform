# Design: add-artifact-delivery

北极星与领域边界见 proposal 与 ADR-0009（对话即交付；展示层合成永不持久化；露链不露库）。本文只写"怎么落"。

## Context

- 链路事实（2026-10-01 fd-prod 实证）：`resources.captureFromMessage` 自动捕获、`/api/files` 三根服务、`resources_changed` 广播全部健康；断的是模型契约认知与对话内可见性。
- 契约注入面（已勘察）：`repoRoot("skills")` 基线目录在所有资源模式（full/focused/custom）下恒为 `customSkillDirs` 首位（`dsh-profile.js:662-758`，6d7f7d1 已 cell-safe），随镜像发版即达全部 cell；唯一能覆盖内置 `standard` 预设的注入面。人设尾巴路径（`composeAgentPreset`）够不着 `standard`，不采用。远程 fork 走 `server/agent-session.js:491-498` 的单行 system message。
- 现成零件：tool 事件（含输入/输出）已全量转发到客户端（tool-use-rendering 契约）；`findFilePath` 路径扫描器已在 `web/src/lib/file-preview.ts`；`useResourcesStore` 已订阅 `resources_changed`。

## Goals / Non-Goals

**Goals**：四个交付面（契约教学/镜像规范化/入藏角标/本轮产物条带）全部落地，旧会话免费追补，服务端修复双端受益。

**Non-Goals**：小程序 UI 平权（仅继承服务端规范化）；Mermaid 渲染支持；文件自动入藏；网页工作区文件浏览面板（条带已覆盖兜底需求）。

## Decisions

### D1. 契约以基线技能送达，SKILL.md 摘要行自足
`skills/platform-output-contract/SKILL.md`。关键假设待核验：dsh 技能可能按需加载（仅 name+description 进 system prompt，正文按需展开）。因此 **frontmatter description 必须一行写全三条硬规则**（echarts 围栏 / 相对路径链接 / 禁 data: URI 与"没能力"话术），正文做展开说明与正反例。这样无论加载语义是启动全文还是按需，契约核心都必然在场。
- 核验即任务 §1.1（go/no-go）：若按需模型下 description 行仍不可靠（e2e 观察模型行为异常率），升级路径是照 `platform-chart-bind-bridge` 模式做 `systemPrompt` 段注入的 bridge 插件——决策已预置，届时切换不回头改 spec。
- 技能正文控制在 ~40 行内，防 token 膨胀。

### D2. 规范化是 `recordMessage` 漏斗里的纯函数
`normalizeFunctionalRefs(text, workspaceRoot)`：只动 markdown 链接目标。`data:text/*` → 解码 payload 求 sha256，在有界工作区遍历（跳过 `node_modules`/`.git`，单文件 ≤ `RESOURCE_MAX_FILE_BYTES`，文件数上限 500）中找同内容文件，命中改写为相对链接；未命中降级为纯链接文字。绝对路径目标 `realpath` 落在工作区内才改写相对。幂等（改写产物再过一遍不变）。单一漏斗覆盖本地/远程/cron 全部镜像路径。
- 备选否决：渲染层改写（小程序不受益，且与 D4"永不持久化"的分层混乱）；内联代码改写（伪造模型陈述，ADR-0009 红线）。

### D3. 角标按内容哈希关联，规范化函数进 packages/core
捕获哈希（服务端）与角标判定（客户端）必须同源，否则解析器漂移会让角标静默失配——重演"两个解析器一份契约"的旧纪律：围栏→规范 JSON→sha256 的规范化函数放 `packages/core`，服务端捕获与网页角标共用同一实现。角标判定 = 渲染围栏的哈希 ∈ 资源库行集合；不依赖 message_id（流式期间客户端无 DB id，哈希匹配同时覆盖实时与历史会话）。实时性搭 `useResourcesStore` 现有 `resources_changed` 订阅便车。

### D4. 条带客户端合成，存量态查询走批量 lookup 端点
条带数据源 = 该回合 tool 事件的路径提取（`findFilePath` 从 web 私有提升到 `packages/core`，小程序日后复用），客户端按路径去重、末次事件为准，纯渲染层合成——不写消息、不进模型历史，历史会话重放自然生效。
"已存/未存"判定：客户端没有文件字节，新增 `POST /api/resources/lookup`（body: `{sessionId, paths[]}`），服务端在会话工作区下读文件求哈希、与库内 `content_hash` 比对，批量返回每路径状态。条带路径仅来自 tool 提取，量级有界。查不到/读失败按未存处理，保存路径上现有的内容去重与"已在库"报告兜底（spec 既有行为）。

### D5. 样本包 Mermaid→echarts 就地改文
`docs/vertical-packs/skills/china-macro-brief-workflow/SKILL.md` 与 `legal-case-workflow/SKILL.md` 中 Mermaid 引导段落改为 echarts JSON 围栏示例，与基线契约同口径。纯文档修订，无运行时影响。

### D6. Sidebar welcome 陷阱修复（实现中发现，范围新增）
e2e 重放暴露的真实缺陷：live 会话==目标会话且客户端视图为空（新开标签页到 /chat/、无 URL 参数的重载）时，侧栏行点击被 `s.id !== currentSessionId` guard 吞掉、深链效果对相同 id 不触发、transcript 永不可达——用户面对 welcome 空转。修复：空视图（`turns` 空且无 pending switch）时点击当前行也发 `switch_session`；服务端 `switchToSession` 的同 id 分支本就返回 transcript（`agent-session.js`），客户端补上这条恢复路径即可。状态读取用 `getState()` 命令式读，不订阅 turns（避免逐 token 重渲染侧栏）。

## Risks / Trade-offs

- [技能加载语义不确定] → D1 的 description 自足设计 + §1.1 go/no-go 核验 + bridge 升级路径预置；验收本就是结构性的（注入在场），不赌模型话术。
- [工作区遍历成本/大工作区] → 有界遍历（目录跳过+大小+数量上限），超限即走"降级为纯文本"分支，永不阻塞镜像。
- [规范化误伤] → 只动链接目标；绝对路径必须 realpath 落在工作区内；纯函数 + 单测覆盖幂等与边界。
- [content_hash 双端漂移] → D3 单一共享实现根除；测试断言服务端捕获行哈希与客户端角标判定用同一函数产出。
- [lookup 端点被滥用做目录枚举] → 仅接受 tool 提取形态的路径、限会话工作区、realpath 收容（沿用 `saveFile` 的 containment 纪律）。

## Migration Plan

全量随镜像发版（GHA→TCR→GitOps，canonical 路径）：基线技能与样本修订是静态文件；规范化只作用于**新镜像**消息，历史存量不动（旧会话的角标/条带按渲染层追补，不受影响）；无 DB migration、无回填脚本。回滚 = revert 镜像 tag；规范化非幂等风险不存在（只写一次）。

## Open Questions

无。（技能加载语义的核验已内化为 §1.1 的 go/no-go 任务，升级路径已定，不影响 spec 与任务分解。）
