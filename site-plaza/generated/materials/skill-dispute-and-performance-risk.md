# dispute-and-performance-risk

## What this is

当用户提交合同文本、交易安排、商业协议或法律关系描述，需要评估其中可能产生法律纠纷或违约风险时触发此技能。 典型触发场景包括但不限于： - 用户要求审查合同并指出潜在风险 - 用户询问某项交易安排是否存在履约障碍 - 用户描述合同执行中的困难，需要判断是否构成违约 - 用户要求对合同条款进行风险评级 - 用户提供两方或多方之间的协议，要求识别可能的争议焦点 - 用户描述已发生的履约偏差，需要评估法律后果 - 合同审查、尽职调查、交易谈判等场景中需要前瞻性风险识别 此技能聚焦于"是否会产生法律纠纷"和"是否存在违约风险"两大核心问题， 输出结构化的风险清单与应对建议。

Triggers when the user submits contract texts, transaction arrangements, commercial agreements, or descriptions of legal relations and needs to assess potential legal disputes or breach risks within them. Typical trigger scenarios include but are not limited to: the user asks to review a contract and flag potential risks; asks whether a transaction arrangement faces performance obstacles; describes difficulties in contract execution and needs to determine whether it constitutes breach; asks for risk ratings of contract clauses; provides an agreement between two or more parties and asks to identify possible disputed points; describes performance deviations that have occurred and needs the legal consequences assessed; forward-looking risk identification in contract review, due diligence, or deal negotiation. The skill focuses on two core questions — "will a legal dispute arise" and "is there breach risk" — and outputs a structured risk list with response recommendations.

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
