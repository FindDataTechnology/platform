# add-doc-studio

## Why

平台的对话交付物至今只有文本与图表（产物契约：echarts 围栏 + 工作区文件链接），真实商务交付物——Word 报告、Excel 表、汇报 PPT——缺位，而 agent 生成文档恰是对外演示与商务场景里最直观的价值形态。开源界已把 office 能力的**执行层**做成熟（markitdown ~73k star、MIT；python-docx/openpyxl/python-pptx 全开源；Gotenberg 转 PDF），但决定产出质量的**技能内容层**（封面配方、设计系统、场景模板、postcheck 质检）没有可商用的开源答案——Anthropic 文档技能是 source-available 禁商用，Z.AI 技能专有——这一层正好落在谦面"护城河=垂直内容"的位置上。三家拓扑现成：能力打包为官方功能集，谦面商店分发、壹座装包即得、萬星随包部署，执行层共享件走基线镜像。

## What Changes

按三切片推进：

- **切片① 执行层 + 读轨地基**：基础镜像预装 office 执行库（python-docx / openpyxl / python-pptx / markitdown；python3 已在镜像，只差 pip 层）；资料库工具面新增第四个工具 `fetch_document_file`——按文档 id 把原件字节落进 agent 工作区，是读/编辑场景（收 docx → 改 → 还 docx、表格结构化提取）的地基。
- **切片② 内容层三件套**：设计系统 + 封面配方 + 场景模板 + postcheck，覆盖第一批三场景——商务报告（docx）、数据表格（xlsx）、汇报演示（pptx）；第二批（合同/红头文书）联动 legal 垂直包另批。内容生产 AI 辅助 + 人工验收，**入库门**：每个封面配方必须在真实 Office/WPS 打开验证（free-form 封面代码在 MS Office 必炸兼容性），postcheck 全绿才算入库。骨架借鉴业界验证过的分层结构（routes/scenes/design-system/postcheck），**合规红线：文案、代码、配方数值、场景文件零搬运**（Anthropic source-available、Z.AI 专有）。
- **切片③ 发布与出场**：官方功能集 `fd-doc-studio`（中文名全平台唯一：「文档工坊」）经创作者线发布谦面；壹座 cell dogfood 先行 → 谦面商店亮出 → 萬星部署演示殿后。

**v1 边界**：a2A 响应只回文本 + 文件引用（file parts 出/入向是 v2 独立 change）；格式转换（Gotenberg 共享服务，预留名 `fd-office-mcp`，容器补 CJK 字体）v2 再上；office 能力对萬星调用者**回合内免费 + 资源限额**（文件大小上限、处理时限），不进 sub2api 计量（同 websearch 基线立场）；长文档问答不做（资料库检索已有）。镜像 CJK 字体 v1 不需要（docx/xlsx/pptx 存字体名，由用户侧 Office/WPS 解析渲染）。

## Capabilities

### New Capabilities

- `doc-studio`: 文档工坊能力契约——装载分层（执行层=基线镜像依赖、内容层=官方功能集技能，包不承担 pip 依赖）、内容层结构（场景/封面配方/设计系统/postcheck）与真机验证入库门、资源限额立场、命名唯一性（「文档工坊」/ fd-doc-studio / fd-office-mcp 预留）。

### Modified Capabilities

- `document-library-tools`: 工具面从三个扩到四个——新增 `fetch_document_file`，按文档 id 返回原件字节落 agent 工作区（既有三工具语义不变）。

## Impact

- **代码**：`Dockerfile`（pip 执行层，全部 cell 背负 ~110–120MB）、`server/`（in-process 资料库 MCP server 加第四工具 + 原件字节的读取路径）、内容源目录（设计系统/场景文件，发布走既有官方功能集创作者线）。谦面、萬星零代码改动（既有 pack 安装与部署机制承载）。
- **部署**：执行层随镜像重建滚动；内容层随 pack 版本走，不锁镜像节奏。
- **依赖**：python-docx（MIT）、openpyxl（MIT）、python-pptx（MIT）、mammoth（BSD-2）——全部真开源，许可干净。（markitdown 经实测出局：核心拖 onnxruntime+pandas 共 185MB 而对 v1 三格式零质量加成；归 v2 转换容器再评估。）
- **风险**：许可证红线（只借鉴分层结构概念，零搬运专有内容）；封面配方兼容性（以真机验证门挡）；镜像体积膨胀 +110–120MB 由全部 cell 共担（瘦身后实测，v2 转换广度走共享容器不进 cell 镜像）。
- **不做**：a2a file parts、Gotenberg 转换、sub2api 计量、长文档问答、合同/红头场景、镜像 CJK 字体——全部显式推迟，各自有归属（v2 change 或后续批次）。
