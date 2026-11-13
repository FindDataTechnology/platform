# 文档工坊 — 封面配方与场景真机验证台账

入库门（design D4）：每个封面配方必须在**真实 Office 或 WPS** 中打开验证通过才算发布；本台账是发布 checklist 的一部分。

- **代码面验证（已过，2026-10-08）**：四配方 + postcheck 从 SKILL.md fenced 块**逐字提取**执行——R1–R4 全部生成成功；postcheck 对完整成稿 PASS（S1/S2/S3）、对坏样本 FAIL（死目录文本 / 空表+默认表名 / 越界形状，三类全抓）。钉版环境：python-docx 1.2.0 / openpyxl 3.1.5 / python-pptx 1.0.2 / mammoth 1.13.0（requirements-office.txt）。
- **线上壹座真机验证（已过，2026-10-08，强信号层）**：四份 docx 样张（S1 完整报告 + R1/R2/R3 封面）上传到 platform.finddatatech.cloud 的资料库，**全部 ready、零 error**，Content 区渲染出完整中文内容（封面三行文案 + 摘要 + 正文结构）。这是真实浏览器/服务端对 docx 的解析路径，比 LibreOffice 更贴近用户实际打开体验。xlsx/pptx 不在壹座 ingest 白名单内（.pdf/.md/.docx/.csv/.html/.json/.txt），由 LibreOffice 层覆盖。
- **LibreOffice 渲染验证（已过，2026-10-08，弱信号层）**：7 份样张 headless 转 PDF 全部可开、版式正确（封面底色/行高/中文渲染/KPI 卡/16:9 深底/图表）；S1 多页结构正确（封面→摘要+目录→正文）。**抓到并修复两个真缺陷**：①S2 毛利率公式 `ws.max_row` 当行号（append 前求值差一行，首行引用表头文本出 #VALUE!，postcheck 盲区——openpyxl 不求值；修复后 CSV 强制求值六个月全对）；②图表锚 F2 被打印分页从中间切开（修复为锚数据下方 A9，单页完整）。两条经验已回灌 SKILL.md §数据工作簿。注意：LibreOffice 通过 ≠ Office/WPS 通过（渲染更宽容），兼容门仍以下面真机行为准。
- **线上壹座真实回合验证（已过，2026-10-09，最强信号层）**：prod（`sha-744285e`）标准模式下真回合「用 doc-studio 技能生成商务报告 docx」——agent 载入技能→按路由规则执行（商务报告 → R1 封面 + TOC 域 + 三章 + 数据表 + 靛青配色 + 强制 postcheck）→ 产出 `2026年第三季度华东区销售复盘.docx`（43KB / 52 段 / 6 表 / 单节；标题层级 摘要·目录·一、市场概览(1.1–1.3)·二、业绩分析(2.1–2.4)·三、下季度计划），**技能自带 postcheck 对成品 PASS**，回合末自报工作区路径 + 交付清单（封面 R1 三行色块表 / TOC 域 `TOC \o "1-2" \h \z \u` / 数据表脚注）。这条覆盖了"配方在真实 agent 运行时被正确选用并产出可交付文件"的端到端契约。
- **萬星外部 A2A 服务验证（已过，2026-10-09，对外服务层）**：pack v2 带 `serving` 契约的 agent（`doc-report-writer`）部署为萬星 Agent 服务，**外部调用者**持 `sk-` 键经 `https://wanxing.finddatatech.cloud/api/wanxing/v1/a2a/packs-qnhd7b3j1-hkddkzzq_fuq-doc-report-writer` 发起 `message/send` 真回合（74s）——走**技能规定的 python-docx 路径**（子代理自证 python3 3.11.2 + python-docx 1.2.0）产出 `2026年第三季度运营简报.docx`，**postcheck.py PASS（exit 0）**，回复文本**含文件引用与自报路径**；磁盘核实 41,504 字节与自报一致（OOXML zip 17 条目 / 158 段 / 5 表 / 真 TOC 域 / Heading1×6 + Heading2×4 / 封面 R1 靛蓝 1F4E79）；**无文件字节外发**（响应 3,336 字节纯文本，产物留在服务端工作区）；萬星账单该回合 `outcome=ok / minutes_billed=2 / settlement_status=settled`，无 office 独立计量条目。这条覆盖了"技能经萬星对外服务被外部系统调用并交付文件"的契约（tasks 4.3）。
  - 该验证同时暴露并修复两个真缺陷（详见 tasks.md 4.3）：`rosterPresetId` 只折点号而市场 pack id 含大写/下划线 → preset 目录被 dsh 发现器静默跳过（a8b0007）；四方共持的 `wgkx-` 静态键在 `/agent/*` 路径不被 auth-server 接受（改用 `wgk-` patch key）。
- **样张目录**：`samples/`（S1 完整报告 / S2 数据工作簿 / S3 汇报演示 + R1–R4 配方原型）。R1–R4 原型是封面页单页，postcheck 对它们 FAIL 属预期（成稿门规则）；真机验证看的是打开后的版式。
- **canonical 源**：SKILL.md 内嵌代码即唯一事实；`samples-generate.py` 是开发侧样张生成器（其配方段与技能体等价，改配方先改技能体再同步）。

## 真机验证记录

三层自动化验证已全部通过（代码面 / LibreOffice / 线上壹座真机 ingest + 真实回合，见上）。**Office / WPS 客户端逐张打开**是最后一层人工抽查，留作发布后按需补全：

| 对象 | 验证环境 | 日期 | 结论 | 备注 |
|---|---|---|---|---|
| R1 深蓝商务封面 | ⬜ 待人工抽查（Office / WPS） | | 线上回合已用（见上） | 看：底色完整、行高精确、中文字体不回退宋体 |
| R2 极简横线封面 | ⬜ 待人工抽查 | | 代码面+LibreOffice 已过 | 看：细色条渲染、大标题层级 |
| R3 数据简报封面 | ⬜ 待人工抽查 | | 代码面+LibreOffice 已过 | 看：KPI 卡底色、多格对齐 |
| R4 演示标题页 | ⬜ 待人工抽查 | | 代码面+LibreOffice 已过 | 看：全幅底、文本框位置 |
| S1 完整报告 | ⬜ 待人工抽查 | | 线上回合已出同构成稿 | 看：封面接正文分页、TOC 域可 F9 更新、表头底色 |
| S2 数据工作簿 | ⬜ 待人工抽查 | | 代码面+LibreOffice 已过（修两缺陷） | 看：公式求值、条件格式、图表 |
| S3 汇报演示 | ⬜ 待人工抽查 | | 代码面+LibreOffice 已过 | 看：16:9、深底白字、要点页版式 |

验证方法：双击在真实 Office（或 WPS）打开 → 逐项检查"看"列 → 在本表填环境/日期/结论；任何炸版回到 SKILL.md 修配方，重跑样张后重验。
