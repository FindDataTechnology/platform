# tencent-ima-copilot-legal-consultation

## What this is

以资深律师分阶段办案思维，结合 RAG 法律知识库检索，为用户提供法律问题初步诊断与行动策略。当用户描述法律纠纷、咨询"怎么办""能不能告""会不会坐牢"、询问欠钱不还/被起诉/打官司/维权/赔偿/工伤/交通事故/租房纠纷/遗产继承/离婚/合同纠纷/消费者权益/公司劳动争议等场景，或要求分析合同/侵权/劳动/家事/行政/公司股权问题，或上传法律文件时触发。不适用于出具正式法律意见书、代写文书或替代律师出庭。支持分层精读策略、多轮换词搜索、结构化引用清单（含效力状态标注）、快速/专家双模式。内置反幻觉保障机制（绝对溯源+时效性验证+幻觉自检清单），确保法条引用可溯源、案例裁判经核验、失效法条自动标注。

Provides preliminary diagnosis and action strategies for legal questions in the staged case-handling mindset of a senior lawyer, combined with RAG retrieval from a legal knowledge base. Triggered when the user describes a legal dispute, asks 'what to do', 'can I sue', 'will I go to jail', asks about unpaid debts / being sued / going to court / rights protection / compensation / work injury / traffic accidents / rental disputes / inheritance / divorce / contract disputes / consumer rights / company labor disputes, requests analysis of contract / tort / labor / family / administrative / company equity issues, or uploads legal documents. Not suitable for issuing formal legal opinions, ghostwriting documents, or substituting for a lawyer in court. Supports a layered close-reading strategy, multi-round synonym search, structured citation lists (with validity status annotations), and quick/expert dual modes. Built-in anti-hallucination safeguards (absolute source tracing + timeliness verification + hallucination self-check checklist) ensure statute citations are traceable, case rulings are verified, and repealed provisions are automatically flagged.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.
Source repository: https://github.com/legalskill/legalskill


## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
