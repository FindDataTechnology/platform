# paper-literature-search

## What this is

论文文献检索（文本引擎·论文包入口技能）。当用户想查某个研究方向的论文、做文献综述、了解某领域有哪些工作、或要求"找找关于 XX 的论文""这个方向的研究现状"时使用。驱动从方向定位到文献梳理的流程，数据经 fd-text-core 引擎的论文语料与外部开放检索（arXiv/OpenAlex/S2）实时获取。

Academic literature search (text engine · papers pack entry skill). Use when the user wants to find papers on a research direction, build a literature review, learn what work exists in a field, or asks 'find papers about XX' or 'what is the state of research in this direction'. Drives the workflow from direction scoping to literature mapping; data comes from the fd-text-core engine's paper corpus plus external open search (arXiv/OpenAlex/S2), fetched in real time.

- Species: skill (plaza category enum v1)
- Official: no



## How to obtain

1. In 壹座 (Yizuo): Extensions → Skills — subscribe from the skills face.
2. Inside editors: skills reach your editor bundled with a pack that references them — install that pack with:

       npx @finddatatechnology/facet install <packId>

3. Deployed agent services receive registry skills through the registry supply channel.

## As of

Provenance: https://facet.finddatatech.cloud/api/skills-catalog · As of: 2026-11-05
