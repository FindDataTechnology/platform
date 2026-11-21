# criminal-defense-workflow

## What this is

刑事辩护全流程。当用户要为刑事案件辩护、分析罪名构成与量刑、梳理证据与程序瑕疵、准备辩护意见或庭审发问提纲时使用。走裁判文书库 + 指导案例库 + 法规库检索，逐条溯源。

End-to-end controller for the criminal defense process (entry skill of the 识律 criminal defense suite). Use when the user provides criminal case materials (police prosecution recommendation/indictment/case file/judgment) or asks for case-file analysis, mapping of defense arguments, choice of defense strategy paths, or judgment on offense characterization or sentencing direction. Progresses through stages from review-for-prosecution to first instance (the investigation stage is outside this skill's main flow — see the stage 1 notes), dispatches the suite's two atomic skills, 'plea leniency / non-prosecution argumentation' and 'court examination outline', and centrally handles statute anchoring, similar-case retrieval, and red-line checks.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
