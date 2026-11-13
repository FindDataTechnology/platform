# add-doc-studio — Design

## Context

见 proposal.md「Why」。落点事实（本轮侦察修正与确认）：

- **运行时镜像无 python3**：`Dockerfile` 的 python3 只在 builder 阶段（原生插件编译用）；runtime 阶段（`FROM node:25-bookworm-slim AS runtime`）是纯 Node 面。执行层需在 runtime 阶段新装——探索期"python3 已在镜像"的说法只对 builder 成立，此为修正。
- 资料库 in-process MCP server 在 `server/library-mcp.js`（三工具），加第四工具的改动面集中于此 + 原件字节读取路径。
- 基线技能目录 `skills/` 已有 `platform-output-contract`（产物契约技能）——契约技能进基线有先例；但文档工坊内容层**不进基线**，走功能集。
- 功能集内容源惯例：`docs/vertical-packs/skills/`（`legal-contract-workflow` 已在此——第二批合同场景有现成联动点）；发布走创作者线（自建预设一键流或手工组装，见 docs/pack-marketplace.md）。
- 原件字节已按 `chat-attachments` 持久化于预览 `uploads/` 根——`fetch_document_file` 有现成数据源。

## Goals / Non-Goals

**Goals:**

- cell 与 Agent 服务运行时具备 office 执行层（写/摄取），文件生在工作区、沿产物契约交付
- 内容层以官方功能集分发，可独立于镜像节奏迭代版本
- 读轨地基（`fetch_document_file`）就位

**Non-Goals:**

- a2a file parts（出/入向文件协议）——v2 独立 change
- Gotenberg/格式转换共享服务（`fd-office-mcp` 预留名）、LibreOffice 进任何 cell 镜像
- sub2api 按 office 调用计量；服务端硬性限额面（v1 无独立服务面可挂）
- 长文档问答、合同/红头场景（第二批）、镜像 CJK 字体

## Decisions

### D1 执行层落点：runtime 阶段新装 python3 + 钉版 pip 库（B 瘦身定案 2026-10-08）

runtime 阶段 `apt-get install python3 python3-pip`（沿用既有 aliyun 源 sed 惯例）+ `pip install --no-cache-dir -r requirements-office.txt`（pypi 走国内镜像）。`requirements-office.txt` 置仓根、钉死版本：`python-docx` / `openpyxl` / `python-pptx` / `mammoth`。

- **markitdown 出局（实测推翻原估算后的用户定案）**：其核心硬依赖 magika→onnxruntime（80MB）、xlsx 转换硬依赖 pandas+numpy（105MB），干净 venv 实测 site-packages 258MB vs 瘦身栈 58MB；而它对 v1 三格式的转换与瘦瘦身栈完全同源（docx=mammoth、xlsx=openpyxl/pandas 读表、pptx=python-pptx），零质量加成。文档摄取用 mammoth(docx→HTML/MD) + openpyxl/python-pptx 直读（自有 ~60 行转换代码）。格式广度（PDF 摄取等）归 v2 fd-office-mcp 共享容器——markitdown 届时进那个容器，不进 cell 镜像。
- 实测体积：python3 apt ~60MB + site-packages 58MB ≈ **+110–120MB**，落在原估算带内；全部 cell 背负（含不装文档工坊者）——接受：执行层定位为公共地力。
- 备选否决：①共享 MCP 服务承载执行层——跨机文件流（base64 上下文炸弹），重依赖集中化抬高故障面；②纯 Node 库（docx/exceljs）——xlsx/pptx 生态弱于 python 系，mammoth 无对等物；③保 markitdown——+320MB 由全租户共担换零质量加成，击穿体积阈值（用户已裁决）。

### D2 内容层结构：单技能自含（v1 管线约束下的修正 2026-10-08）

**管线事实**：pack 技能经 `installPack → addCustomSkill({content}) → writeSkill` 落盘，一个技能 = 一个 `<name>/SKILL.md`，**没有辅文件通道**——routes/scenes/references/scripts 分文件布局无法随包分发（实施期发现，替代原计划）。

v1 结构：**一个自含技能 `doc-studio`**（源码 `docs/vertical-packs/skills/doc-studio/SKILL.md`），内部以章节承担原分层职责：

```
SKILL.md
├── 路由段（场景判别 → 章节分发 + 硬规则：原件保护/字体/工作区落盘/postcheck 门）
├── 设计系统（配色×3 / 版式基线 / 图表色序）
├── 封面配方 R1–R4（每配方一段完整 python-docx 函数 + 参数表）
├── 场景章节（商务报告 docx / 数据表格 xlsx / 汇报演示 pptx / 编辑上传件）
└── postcheck（fenced python 代码块：agent 落盘工作区执行；技能体嵌代码是管线
    明文支持的形状，packs.js "bodies legally embed code" 注释）
```

- postcheck.py 不作为文件随包分发——技能指令让 agent 把 fenced 代码写到工作区再运行；VERIFICATION.md 是内容过程文件，放 `docs/vertical-packs/`（技能外，非 agent 内容）。
- 单文件体量上限即设计约束：四配方 + 三场景写得紧凑（目标 ≤1200 行）；配方代码必须实跑验证（瘦身 venv 生成样张）。
- **多文件技能分发**（manifest 携带 aux files）是管线增强的候选 change，惠及所有内容包——不进本 change。
- 骨架分层（路由/设计系统/配方/postcheck）为**结构性借鉴**：文案、代码、配方数值零搬运（Anthropic 文档技能 source-available、Z.AI 技能专有——合规红线）。
- 封面配方以编号配方呈现（wrapper 结构/背景/边距由配方给定，禁止自由发挥封面代码）——直接吸收"free-form 封面代码在 MS Office 必炸"的业界教训。
- 一个功能集三个场景（非三个功能集）：共享设计系统与 postcheck，交付物常为三形态组合（报告=docx+xlsx+pptx）。

### D3 fetch_document_file：第四工具，原件直落工作区

`server/library-mcp.js` 加 `fetch_document_file(document_id)`：从预览 `uploads/` 根取原件字节 → 沿既有工作区写路径落文件（保留原文件名）→ 返回工作区相对路径。原件缺失（URL 摄取源、原件未留存）返回显式 error 命名文档，**不回退**为写抽取文本文件；未知 id 同 `read_document` 的错误形态。

### D4 入库门：真机验证台账 + postcheck 双门

- **配方门（人工）**：新封面配方必须在真实 Office/WPS 打开验证（版式/兼容性），结果记 `VERIFICATION.md`（配方号、验证环境、日期、结论）；发布 checklist 含"台账覆盖本版全部配方"。
- **生成门（自动）**：`postcheck.py` 校验产物结构（目录占位、图片引用、表格越界、文件可打开性），SKILL.md 路由强制"生成即跑、失败必修"；失败项报告给 agent 促成修复，不静默交付。
- 验收流程：内容层每版本发布前抽查真机渲染（抽样配方在 Office/WPS 复验）。

### D5 资源限额：v1 软限 + 配额兜底

无独立服务面可挂硬限，v1 限额=技能层约束（提示词声明单文件大小上限与处理时长上限，超限显式报错不重试）+ cell 既有工作区磁盘配额兜底。v2 若上转换服务，在服务面挂硬限。

## Risks / Trade-offs

- **镜像膨胀 +110–120MB（实测）由全部租户共担**——执行层公共地力定位所接受；markitdown 已出局（185MB 重依赖、零质量加成），构建后仍实测留档。
- **runtime 增 python 攻击面**——无监听端口、仅工作区脚本调用；不接受任何 pip 运行时安装（D1 钉版 + D2 禁装红线）。
- **postcheck 是软门**（agent 理论上可跳过）——SKILL.md 强制路由措辞 + 发布验收抽查缓解；残余风险接受（v1 目标是可用性优先）。
- **内容层质量依赖人工验收带宽**——三件套首发范围刻意收窄（三场景），第二批（合同/红头联动 legal-contract-workflow）在首批真机反馈后再排。
- markitdown 大文件截断为其上游已知 issue——已随瘦身定案出局（工作区侧自有转换不受影响）。
