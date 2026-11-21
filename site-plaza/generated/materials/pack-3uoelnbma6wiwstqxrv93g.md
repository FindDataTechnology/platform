# Lex · Litigation Documents Suite / 识律 · 诉讼文书套件

## What this is

民商事诉讼文书起草与立案材料整理：起诉状/答辩状/证据目录生成，配套证据卡片与材料清单整理；v2 新增**要素式格式转换**（传统文书→最高院 67 类示范文本，逐要素来源标注，事实保真）。法条锚定、效力校验、类案与指导案例参照全部走识律法律检索数据源，案号与条文一律来自真实检索返回。

Civil/commercial litigation drafting and filing prep: complaints, defenses and evidence lists, with evidence cards and checklists; v2 adds element-based format conversion (traditional documents → 67 SPC model templates, per-element source tags, facts preserved). Statute anchoring, validity checks and similar/guiding-case references run on Lex legal search; case numbers and provision text come from real search returns.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Lex · Litigation Documents Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install 3uOELnBMA6WiWSTQxrV93g

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- litigation-drafting — 民商事诉讼文书起草（起诉状/答辩状/证据目录）。当用户提供案情或案件材料，要求写起诉状、答辩状、上诉状要点、证据目录或立案配套文书时使用。法条锚定与类案参照均走真实检索数据源，律师确认要点后才生成成稿。
- evidence-card-organizer — 证据卡片提取与材料清单整理（立案材料整理技能）。当用户提交一批案件材料（合同、转账记录、聊天记录、票据、送达回证等），要求提取证据、编证据目录、整理材料清单或做证据关系与矛盾排查时使用。输出双视图证据卡片库与待补强清单，供起诉状/答辩状起草
- format-conversion-elementized — 要素式格式转换。当用户上传或粘贴一份传统式法律文书（起诉状、答辩状等），希望转换为法院推广的要素式示范文本格式时使用。识别案由并匹配最高院示范文本，逐要素从原文提取填充，逐要素标注来源（取自原文/原文缺失/需补充），原文事实保真不改写；案由

MCP server references (2): fd-legal-search-mcp, fd-find-data-business-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
