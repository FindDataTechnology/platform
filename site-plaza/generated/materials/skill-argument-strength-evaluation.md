# argument-strength-evaluation

## What this is

当AI智能体完成一段法律推理或论证后，需要对该推理结论进行自我评估，判断论证的整体强度与置信度，识别并标注推理链条中的薄弱环节。 触发条件包括但不限于： - 完成法律分析后需要给出结论可靠性评级 - 用户明确要求评估某一论证的说服力或可靠性 - 存在多个竞争性法律解释需要比较论证强度 - 推理过程中涉及不确定因素（事实不明、法律空白、争议观点）需要标注 - 为决策者提供风险提示，说明结论的局限性 - 对己方或对方的法律论证进行攻防强度评估 - 在法律意见书、备忘录等文书中需要附加置信度说明

Triggers after the AI agent completes a piece of legal reasoning or argumentation and needs to self-assess the reasoning conclusion, gauge the overall strength and confidence of the argument, and identify and flag weak links in the reasoning chain. Trigger conditions include but are not limited to: assigning a reliability rating to a conclusion after legal analysis; the user explicitly asking to evaluate the persuasiveness or reliability of an argument; multiple competing legal interpretations whose argument strength must be compared; uncertainties in the reasoning (unclear facts, legal gaps, disputed views) that need flagging; providing decision-makers with risk warnings about a conclusion's limitations; assessing the offensive/defensive strength of one's own or the opponent's legal arguments; attaching a confidence statement in documents such as legal opinions and memoranda.

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
