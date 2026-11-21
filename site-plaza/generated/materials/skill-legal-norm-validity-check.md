# legal-norm-validity-check

## What this is

当AI智能体在法律推理过程中检索到具体法律条文后，需要对该法条进行效力验证时触发此技能。 触发条件包括但不限于： 1. 智能体引用任何法律条文作为推理依据前； 2. 用户提供法条要求分析其适用性时； 3. 多个法律规范可能存在冲突需要判断优先适用时； 4. 法律文件的时间效力存疑（可能已被修订、废止）时； 5. 需要确认某规范性文件是否具有法律约束力时； 6. 跨层级、跨区域法律规范适用产生疑问时。 本技能确保智能体引用的每一条法律规范均为现行有效、层级正确、与上位法及同位法无冲突， 从而保障法律推理结论的可靠性和权威性。

Triggers when the AI agent, having retrieved specific legal provisions during reasoning, needs to verify their validity. Trigger conditions include but are not limited to: 1. Before the agent cites any legal provision as a basis for reasoning; 2. When the user provides a provision and asks for an applicability analysis; 3. When multiple legal norms may conflict and the priority of application must be judged; 4. When a legal document's temporal validity is in doubt (it may have been amended or repealed); 5. When it must be confirmed whether a normative document is legally binding; 6. When applying legal norms across levels or regions raises questions. This skill ensures every legal norm the agent cites is currently effective, at the correct hierarchy level, and conflict-free with higher-level and same-level norms, thereby safeguarding the reliability and authority of the reasoning conclusions.

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
