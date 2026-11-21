# new-case

## What this is

将案件/咨询/商标/专利材料整理成标准化目录结构。支持诉讼案件（12目录）、潜在项目/咨询（2目录）、商标案件（按业务子类型选 2 个模板：注册 7 目录含独立商标注册证/异议复审无效 8 目录含独立商标注册证）、专利案件（按业务子类型选 3 个模板：申请 7 目录/复审无效 8 目录/检索其他 4 目录，目录顺序按项目进展）四种预设。本技能应在用户需要创建新案件、初始化案件目录结构、整理咨询材料、接收商标/专利新业务、或通过参数和自然语言指定案件编号、委托人、案件类型等信息快速创建案件时使用。不要用于：单独生成法律文书、进行法律研究、证据分析等非案件初始化任务。

Organizes case/consultation/trademark/patent materials into a standardized directory structure. Four presets: litigation cases (12 directories), prospective projects/consultations (2 directories), trademark cases (2 templates by business sub-type: registration, 7 directories including an independent trademark registration certificate; opposition/review/invalidation, 8 directories including an independent trademark registration certificate), and patent cases (3 templates by business sub-type: application, 7 directories; review/invalidation, 8 directories; search and others, 4 directories, with directory order following project progress). Use this skill when the user needs to create a new case, initialize a case directory structure, organize consultation materials, onboard new trademark/patent business, or quickly create a case by specifying case number, client, case type, etc. via parameters and natural language. Not for: standalone legal document generation, legal research, evidence analysis, or other non-initialization tasks.

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
