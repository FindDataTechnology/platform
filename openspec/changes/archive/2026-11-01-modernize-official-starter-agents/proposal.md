# modernize-official-starter-agents

## Why

五支官方 starter 团队（客服班组/AI 公司/内容流水线/投研晨会/晨报情报站）是 gallery 门面、每个新用户的第一键 fork——但内容盘点实锤：**skills=0、mcpServers=0（除运行时注入外）、persona 均仅 115-163 字**。新版三桶规格书会把两个空桶直白渲染：门面示范「三桶模型」的三桶里两桶是空的，与「官方精选」的定位不符。

## What Changes

- **15 个岗位 persona 深化**（~420-560 字）：在 v6 节拍与报数槽位语义**逐字保留**的前提下，补【职责边界】【工作纪律】【输出契约】结构段——边界写清「什么不归我管」，契约写清 report_status 必含项。
- **skills 桶补实**：每支 2-3 条真实可执行的操作规范（分诊五步法/升级决策卡/选题立项卡/撰稿规范/审校清单/观点卡/情报五要素等），纯程序性内容，零编造工具名。
- **mcpServers 按实钉扎**：只钉真实在册且同域的 server（投研晨会→fd-daas-mcp+fd-quant、晨报情报站→fd-info、客服班组→chatwoot），allowTools=[]；工具由运行时注入的团队（AI 公司/内容流水线）**如实留空**——饱满服从诚实。
- 编队结构/cadence/kpiSlots/规格书 guide **一字不动**（结构已真机验证）。
- 发布 v7（原作者 aloadtree 身份，既有发布门），真机走查三桶饱满+fork 种子非空。

## Capabilities

### New Capabilities

- `official-starter-agents-content`：官方 starter 团队的内容质量基线——三桶非空（或如实留空的理由在案）、persona 结构化、槽位契约显式。

## Impact

- 市场 5 支包 v6→v7（内容变更，结构零变更）。
- 测试：starter-teams 文档侧钉不动（names/ids 不变）；新增内容基线断言（skills/mcp 非空或留空理由在案）。
- fork 深链种子、gallery 卡、详情规格书自动变饱满，零代码改动。
