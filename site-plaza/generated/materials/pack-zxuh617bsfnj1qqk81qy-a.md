# Lex · Legal Research Suite / 识律 · 法律检索套件

## What this is

法律检索研究五件套：法条与效力核查、类案检索报告、法律概念图解、五源语料检索与口径对照（规章/条约/纪检监察/案例库/党内法规）、法规效力生命周期追踪。数据来自识律 lex 线法规库（32,296 部）、裁判文书库（3,700 万篇）、指导案例库（278+15）与五源语料（47,261 篇），逐结果溯源。注：文书库不支持聚合统计，类案类产出为「检索式证据」口径而非统计结论。

A five-tool legal research set: statute and validity checks, similar-case retrieval reports, legal concept maps, five-corpus search with caliber comparison (departmental rules / treaties / discipline-inspection / case libraries / Party regulations), and validity lifecycle tracking. Data from the Lex law library (32,296), judgment library (37M), guiding cases (278+15) and five-corpus (47,261), with per-result provenance. Note: the judgment library supports no aggregate statistics — similar-case outputs are retrieval-based evidence, not statistical conclusions.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Lex · Legal Research Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install zxuH617BsFnj1QQk81QY-A

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (5):
- statute-validity-check — 法条检索与效力核查。当用户要查某法条原文、核对某条文是否现行有效、确认条号是否因修订变动、查某法律问题的法律依据（"能不能""是否有效""如何认定""依据哪一条"）时使用。语义召回候选条文后逐条锚定效力状态，输出带效力状态与 provena
- case-retrieval-report — 类案检索与裁判规则报告。当用户要检索类案、出案例检索报告、查某类纠纷的裁判规则或裁判倾向、做同案同判分析、找支持某主张的判例时使用。走裁判文书库 + 指导案例库多组关键词换搜，输出含真实案号、法院、裁判日期与 provenance 的检索报
- legal-concept-map — 法律概念结构化图解。当用户要解释某个法律概念/制度（"什么是善意取得""表见代理怎么认定""情势变更的适用条件"）、要拆构成要件与例外、要找关联条文与权威解读时使用。以条级引用解析锚定条文，以五源语料补权威解读，输出要件—例外—关联条文的结
- legal-corpus-explorer — 五源法律语料检索与口径对照。当用户要查部门规章/地方规章、条约、纪检监察法规、人民法院案例库案例、党内法规，或要在多个语料源之间对照同一问题的规范口径、找某领域除法律外的细化规定（"部门规章怎么规定的""有没有条约""党内法规怎么要求""案
- statute-lifecycle-tracker — 法规效力生命周期追踪与所在层级查证。当用户要了解某部法规的效力状态（有效/已修改/已废止/尚未生效/未知）、核对一部法规是否被后续修法改动、盘点某一领域的现行有效法规存量、或要判断"某个规定还有效吗""这部法改过几版"时使用。以效力状态为权

MCP server references (2): fd-legal-search-mcp, fd-find-data-business-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
