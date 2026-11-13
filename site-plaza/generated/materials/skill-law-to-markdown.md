# law-to-markdown

## What this is

将法条/规范文件（.txt/.docx/.pdf）转为 Markdown。适用于用户要求“法条转 markdown”“pdf/docx 转 markdown”。处理 .pdf/.docx 时先检查是否已安装 mineru-ocr skill；未安装先引导安装，安装后优先用 mineru-ocr；仅在用户明确同意时再用本地回退方案。

Converts statutes/regulatory documents (.txt/.docx/.pdf) to Markdown. Applies when the user asks for 'statutes to markdown' or 'pdf/docx to markdown'. When processing .pdf/.docx, first check whether the mineru-ocr skill is installed; if not installed, guide installation first, and after installation prefer mineru-ocr; use the local fallback only with the user's explicit consent.

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
