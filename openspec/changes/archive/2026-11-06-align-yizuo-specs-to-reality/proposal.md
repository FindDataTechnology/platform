# align-yizuo-specs-to-reality

## Why

壹座 253 spec 首次体检（optimize-yizuo-module-audit，2026-11-06 归档）的 backlog 修复第一组：**纯 spec 文本批**。体检发现 C/D 级 5 条中 4 条是措辞/指针/枚举漂移（能力仍在、文字指向现实之外），另有一批 P1/P2 措辞陈旧——按 spec 操作的人会做反向工作或维护已降级文件。全部是文字修正，零产品代码改动。

修复清单（来源：backlog.md P0-1、P1-1/2/4/9/10/11/12/14 与 P2 措辞批，证据见 findings/cluster-*.md）：

- **P0-1 e2e-testing（D）**：app-shell 条款改写为现役 tab 集（nav-bots/nav-trace 必须不存在、nav-resources/nav-tasks 在位——与 e2e/app.spec.js:24-31 对齐）；删除「Ask the collection」RAG 条款（Q&A 面已按 document-management-ui 删除）。
- **P1-1/2 cron-module（C）**：interval 单位收敛为实装的 minute/hour/day/week（删 month/year 与 time-of-day phase 超claim）；补跑条款 "SHALL NOT catch up" 回改为现实口径（窗内一次补跑+窗外记账+告警——与 cell-gateway/cell-lifecycle 姊妹场景对齐）；update 目标重绑定补一句（代码已支持）。
- **P1-4 vertical-packs（C）**：spec.md:26 场景 "per registry-groups.json" 改为携带元数据权威、手工映射降兜底。
- **P1-9 web-search**：设置面措辞归位到 connections 卡+重定向。
- **P1-10 app-navigation / layout-configuration**：tab 集枚举同步现役面（补 fleets 智语面、fleet desktop-only；app-navigation Purpose 的 Bots 残留在 Purpose 层 chore 处理）。
- **P1-11 zhiyu-im-bridge**：REST 路径笔误 /api/zhiyu/im-bridge → /api/zhiyu-im-bridge。
- **P1-12 chat-streaming**：steer 场景措辞更新为现状（同会话二次 prompt=结构化拒绝）。
- **P1-14 agent-catalog / agent-delegation-a2a**：硬编码示例域名改 {registry} 占位。
- **P2 措辞批**：agent-delegation-tools 工具注册名注明；agent-preset-selection 流式拒绝门指针；agent-cluster-core lead fallback 语义；cell-gateway legacy 豁免 carve-out；scheduled-task-notifications WeChat 信封标 future-MAY；dsh-contracts 补合同⑱索引；official-starter-teams 第六支种子注记；chat-ui-shell 删已删文件引用；chat-composer-controls 主语更新。

## What Changes

- 上述 spec 的 MODIFIED/REMOVED Requirements delta（唯一动作面）；零代码、零 Purpose（Purpose 回填与跨仓归属注记走 chore 提交，不属 requirement 语义）。

## Capabilities

### Modified Capabilities

e2e-testing、cron-module、vertical-packs、web-search、app-navigation、layout-configuration、zhiyu-im-bridge、chat-streaming、agent-catalog、agent-delegation-a2a、agent-delegation-tools、agent-preset-selection、agent-cluster-core、cell-gateway、scheduled-task-notifications、dsh-contracts、official-starter-teams、chat-ui-shell、chat-composer-controls
