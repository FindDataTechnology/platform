# analogical-reasoning

## What this is

当AI智能体需要处理以下情形时触发本技能： 1. 当前案件/问题在现行法律中没有直接、明确的规定（法律漏洞）； 2. 需要参考已有判例、相似案件或相近法律规范来推导当前问题的处理方案； 3. 用户明确要求"参照""比照""类推适用"某一规范或案例； 4. 在法律论证中需要以"相似案件相似处理"（Like cases should be treated alike）原则支撑结论； 5. 需要评估两个或多个案件/规范之间的相似性与差异性，以判断能否进行类比； 6. 在合同解释、侵权责任认定、行政处罚裁量等场景中，需要借助类似情形的处理经验形成论证。 本技能的核心是：识别相似性基础（tertium comparationis），论证类比的正当性，并在此基础上得出合理的法律结论。

Triggers when the AI agent needs to handle the following situations: 1. The current case/issue has no direct, explicit provision in existing law (a legal gap); 2. Existing precedents, similar cases, or related legal norms must be consulted to derive a solution for the current issue; 3. The user explicitly requests "referring to", "applying by correspondence", or "analogical application of" a norm or case; 4. A legal argument needs the principle that "like cases should be treated alike" to support its conclusion; 5. The similarity and differences between two or more cases/norms must be assessed to judge whether an analogy can be drawn; 6. In contract interpretation, tort liability determination, administrative penalty discretion, and similar scenarios, experience from analogous situations is needed to build the argument. The core of this skill is to identify the basis of similarity (tertium comparationis), justify the analogy, and on that basis reach a sound legal conclusion.

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
