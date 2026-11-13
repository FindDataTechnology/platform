# legal-doc-templates-export

## What this is

统一处理法律工作中最终需要输出本地 Word（.docx）的文书、报告、清单、笔录、意见书、函件、合同和正式交付文件。由法律工作总控强制路由调用；业务 Skill 负责正文和法律判断，本 Skill 负责选择格式 profile、接收语义 HTML 或要素式填充数据、导出 DOCX、结构体检和兜底模板。

Uniformly handles documents, reports, checklists, transcripts, opinions, letters, contracts, and formal deliverables in legal work that ultimately need to be output as local Word (.docx) files. Invoked by mandatory routing from the legal work controller; business skills are responsible for the body text and legal judgments, while this skill selects the format profile, receives semantic HTML or element-based fill data, exports the DOCX, performs structural checks, and applies fallback templates.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/pa1nrui1/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
