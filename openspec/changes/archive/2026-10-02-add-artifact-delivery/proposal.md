# Proposal: add-artifact-delivery

## Why

fd-prod 实证（2026-10-01，aloadtree@gmail.com 会话）：图表围栏其实已自动入藏、文件已写进正确的 cell 工作区、服务端 API 全部健康，但用户体感是"图表/文件没进资源库、拿不到下载链接"。根因不在管道，在三重感知断层——①入藏发生时对话内零反馈（两位真实用户的图表都入库了、感知为零）；②模型不认识平台的产物契约，自称"没法生成下载链接"、发明被浏览器拦截的 `data:` URI、指引用户去找一个不存在的"文件面板"；③网页端无兜底入口，文件交付完全依赖模型自觉挂相对路径链接。北极星决策（ADR-0009）：**对话即交付**——产物在对话内就该可拿到，资源库是归档不是取件柜台。

## What Changes

- **新增基线技能 `platform-output-contract`**（产物契约）：以 `skills/` 基线目录送达所有角色（含内置 `standard` 预设与远程 fork 的单行 system message），教模型：文件用工作区相对路径 markdown 链接引用、图表用 echarts 围栏、禁 `data:` URI 与虚构 UI 指引
- **镜像时功能性引用规范化**：assistant 镜像文本中的 `data:text/*` 链接剥离或替换为平台链接；指向工作区内的绝对路径链接改写为相对引用。叙述性内容（正文、内联代码）一字不改
- **图表入藏角标**：对话中的图表块常驻"已入资源库"标记（可点跳资源库页），按 `resources.message_id` 关联；重开旧会话同样渲染（计算即追补）
- **"本轮产物"条带**：回合末聚合展示本轮 tool 调用产出的文件 chip（路径提取、按路径去重、显示最新态），chip 呈未存/已存两态，提供预览与存入资源入口；纯展示层合成，永不持久化、不进模型历史
- **样本包去 Mermaid 化**：`china-macro-brief-workflow`、`legal-case-brief-workflow` 两个样本 SKILL.md 的图表引导从 Mermaid 改为 echarts 契约（消除教学层自相矛盾）
- 显式保存边界维持不变（露链不露库）；文件自动入藏明确否决（ADR-0009）

## Capabilities

### New Capabilities

- `artifact-contract`: 平台向所有角色（含内置预设与远程 fork）持续送达产物输出形态契约——图表以 echarts 围栏、文件以工作区相对路径链接出现；契约经基线技能注入，重启、切换预设、换包后仍然生效

### Modified Capabilities

- `chat-history`: 镜像行为变更——assistant 文本镜像落库前做功能性引用规范化（`data:` URI 链接处理、工作区内绝对路径链接改相对），叙述性内容不改写
- `chat-chart-rendering`: 图表块新增常驻入藏角标——已自动入藏的图表在对话块上持久可见"已入资源库"状态并可跳转资源库，旧会话重渲染时同样生效
- `resource-library-ui`: 新增回合末"本轮产物"文件条带与 chip 未存/已存两态——文件交付不再依赖模型自觉挂链接；条带从 tool 调用路径推导，展示层合成不持久化

## Impact

- **服务端**：`server/chat-history.js`（镜像规范化钩子）、`server/resources.js`（捕获广播已有，无需改）、`server/agent-session.js`（远程 fork 单行 system message 补契约行）
- **基线面**：`skills/platform-output-contract/SKILL.md` 新增（随镜像发版，全 cell 生效）；`docs/vertical-packs/skills/*/SKILL.md` 样本修订
- **网页端**：`web/src/components/EChart.tsx`（角标）、Markdown.tsx / 新条带组件、`web/src/components/preview/PreviewDrawer.tsx`（两态）；`packages/core`（规范化 helper 与 file-ref 共享规则）
- **小程序**：仅继承服务端规范化红利，UI 平权后补（本次不含）
- **验收基调**：契约教学验结构（注入存在且重启/换包后仍生效）；其余验确定性行为；主线 e2e 重放 aloadtree 场景断言 UI 链路而非模型话术
- 明确排除：文件自动入藏、`{{seconds}}` 渲染 bug（单独开票）、Mermaid 渲染支持
