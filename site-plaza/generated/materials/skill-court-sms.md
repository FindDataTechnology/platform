# court-sms

## What this is

本技能应在用户收到法院短信（文书送达、立案通知、开庭提醒等）时使用，自动提取案号、当事人、下载链接，下载文书并归档到对应案件目录。会落盘敏感诉讼数据到本地，请确认目标位置私密。

Use this skill when the user receives court SMS messages (document service, filing notifications, hearing reminders, etc.); it automatically extracts case numbers, parties, and download links, downloads the documents, and archives them into the corresponding case directory. It writes sensitive litigation data to local disk, so confirm the target location is private.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/cat-xierluo/legal-skills


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
