# criminal-defense-coordinator

## What this is

刑事辩护专业流程编排 Skill，负责根据刑事诉讼阶段和特殊标签进行专业路由、 阶段转换提示、关键期限提示和下一步工作建议。当用户提及"刑事案件"、 "刑事辩护"、"刑辩"等关键词，或需要跨阶段协调刑事辩护工作时触发。 事项建档、路径、文件读取、来源披露、OCR 校正和缺口归档由「法律工作总控」统一处理。

A criminal-defense workflow orchestration Skill that performs professional routing based on criminal-procedure stages and special tags, stage-transition prompts, key-deadline reminders, and next-step recommendations. Triggered when the user mentions keywords such as "criminal case", "criminal defense", or "xingbian (criminal defense)", or needs to coordinate criminal-defense work across stages. Case filing, routing, file reading, source disclosure, OCR correction, and gap archiving are handled centrally by the "Legal Work Master Control".

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
