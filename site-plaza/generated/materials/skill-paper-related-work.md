# paper-related-work

## What this is

论文相关工作与相似文献（文本引擎·论文包）。当用户给出一段摘要/题目/研究想法，要求找相似论文、写相关工作段落、或做查重式比对（"有没有做过类似的"）时使用。按参考文本的语义向量找近邻，数据经 fd-text-core 引擎实时取。

Paper related-work and similar-literature search (text engine · papers pack). Use when the user provides an abstract/title/research idea and asks to find similar papers, write a related-work paragraph, or run a duplication-check-style comparison ('has anything similar been done?'). Finds nearest neighbors by semantic vectors of the reference text; data fetched in real time via the fd-text-core engine.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
