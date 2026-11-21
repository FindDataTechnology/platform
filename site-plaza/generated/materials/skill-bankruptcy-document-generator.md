# bankruptcy-document-generator

## What this is

基于《破产程序法律文书样式》中的165份文书模板（106份法院文书+59份管理人文书），按需生成各类破产程序文书。本Skill作为破产文书的统一生成工具，供其他破产Skill调用。当用户发送客户编号并提及"破产文书"/"生成XX通知"/"生成XX报告"/"生成XX裁定"等指令时触发使用。

Generates all kinds of bankruptcy-procedure documents on demand based on the 165 document templates in the 'Model Styles of Legal Documents for Bankruptcy Proceedings' (106 court documents + 59 administrator documents). This skill serves as the unified generation tool for bankruptcy documents and is called by other bankruptcy skills. Triggered when the user sends a client number and mentions commands such as 'bankruptcy documents', 'generate XX notice', 'generate XX report', or 'generate XX ruling'.

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
