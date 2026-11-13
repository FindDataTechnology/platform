# Text Engine · Paper Research Suite / 文本引擎 · 论文研究套件

## What this is

学术论文的检索与研究：文献综述（方向定位与脉络梳理）、方法追踪（提出/变体/应用谱系）、相关工作（语义相似文献与对比矩阵）。语料覆盖 arXiv q-fin 与 cs.CL 等八个类目的千级样本（元数据 + 摘要，CC0 元数据）；外部开放检索（arXiv/OpenAlex/Semantic Scholar）编排补充。**版权红线**：只返回元数据、摘要、切块引用与指回 arXiv.org 的原文链接，本服务不提供也不外发论文全文。检索走 fd-text-core 引擎的混合通道（关键词 ⊕ 语义向量 Qwen3-Embedding-8B）。

Retrieval and research over academic papers: literature review (framing the direction and mapping the thread), method tracking (lineage of proposals/variants/applications), and related work (semantically similar papers and comparison matrices). The corpus covers thousand-scale samples across eight arXiv categories including q-fin and cs.CL (metadata + abstracts, CC0 metadata); external open search (arXiv/OpenAlex/Semantic Scholar) is orchestrated as a supplement. **Copyright red line**: only metadata, abstracts, chunked quotes, and links pointing back to arXiv.org are returned — this service neither provides nor sends out full paper texts. Retrieval runs through the fd-text-core engine's hybrid channel (keywords ⊕ semantic vectors via Qwen3-Embedding-8B).

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Text Engine · Paper Research Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 1OQ93FLBzzVGcn2js31ADA

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- paper-literature-search — 论文文献检索（文本引擎·论文包入口技能）。当用户想查某个研究方向的论文、做文献综述、了解某领域有哪些工作、或要求"找找关于 XX 的论文""这个方向的研究现状"时使用。驱动从方向定位到文献梳理的流程，数据经 fd-text-core 引擎的
- paper-method-tracking — 论文方法追踪（文本引擎·论文包）。当用户想查某个方法/技术（如 transformer、对比学习、GARCH）在学术论文里怎么用、有哪些变体、谁提出的，或要求"追一下 XX 方法的发展"时使用。按方法名驱动检索与脉络梳理，数据经 fd-te
- paper-related-work — 论文相关工作与相似文献（文本引擎·论文包）。当用户给出一段摘要/题目/研究想法，要求找相似论文、写相关工作段落、或做查重式比对（"有没有做过类似的"）时使用。按参考文本的语义向量找近邻，数据经 fd-text-core 引擎实时取。

MCP server references (1): fd-text-core

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
