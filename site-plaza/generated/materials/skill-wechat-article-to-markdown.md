# wechat-article-to-markdown

## What this is

将法律文本（法律条文或法律案例）转换为规范的 Markdown 格式，删除推广冗余信息。本技能应在用户需要处理法律条文（如民法典、刑法等）、整理法律案例（如最高法典型案例、裁判文书等）、或从粘贴文本中格式化法律文档时使用。注意：本技能只负责格式化和内容清理，不包含内容抓取能力。内容获取应由其他 skill（如 wechat-article-fetch）完成，AI 会自动判断技能协作顺序。

Converts legal texts (statutes or cases) into well-formed Markdown and removes promotional redundant content. Use this skill when the user needs to process statutes (e.g., the Civil Code, the Criminal Law), organize cases (e.g., Supreme People's Court typical cases, judgment documents), or format legal documents from pasted text. Note: this skill only handles formatting and content cleanup; it has no content-scraping capability. Content fetching should be done by other skills (e.g., wechat-article-fetch), and the AI will automatically determine the collaboration order. Includes a built-in archive mechanism; all results are self-contained and stored within the skill directory.

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
