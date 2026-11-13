# structured-element-extraction

## What this is

当AI智能体需要对一个法律问题、案件事实、法律条文或法律关系进行系统性分析时，首先必须将其分解为结构化的要素清单。该技能在以下场景触发： - 接收到一段案件事实描述，需要提取全部法律要素后再进行分析 - 需要判断某一法律关系是否成立（如合同成立、侵权构成、犯罪构成） - 需要对比两个或多个法律事实/条文的异同 - 在进入法律推理、法律适用、法律建议等下游任务之前，作为前置质量关卡 - 用户明确要求"列出要素""逐项分析""检查是否遗漏" 本技能的核心目标是：确保要素提取完整、无遗漏，形成可追溯、可验证的结构化清单，然后才允许进入下一阶段推理。它是法律分析链条中的"质量闸门"。

When the AI agent needs to systematically analyze a legal issue, case facts, a legal provision, or a legal relation, it must first decompose it into a structured checklist of elements. This skill triggers in the following scenarios: receiving a description of case facts that requires extracting all legal elements before analysis; determining whether a legal relation is established (e.g., formation of a contract, the elements of a tort, the elements of a crime); comparing two or more legal facts/provisions for similarities and differences; serving as a preliminary quality gate before downstream tasks such as legal reasoning, application of law, and legal advice; the user explicitly asks to "list the elements", "analyze item by item", or "check for omissions". The core goal of this skill: ensure element extraction is complete and without omissions, producing a traceable, verifiable structured checklist before the next reasoning stage is allowed. It is the "quality gate" in the chain of legal analysis.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/THUYRan/Legal-Skills-Chinese


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
