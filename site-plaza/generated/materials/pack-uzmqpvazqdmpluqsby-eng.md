# Lex · Criminal Defense Suite / 识律 · 刑事辩护套件

## What this is

刑事辩护套件：以总控流程技能为入口，串联认罪认罚/不起诉论证（审查起诉阶段）与庭审发问提纲（一审阶段），法条与指导案例走识律法律检索、法规效力走数据业务检索，类案与量刑参照走裁判文书检索。

Criminal defense suite: a master workflow chains plea/non-prosecution argumentation (review-for-prosecution) with examination outlines (first instance). Statutes and guiding cases via Lex legal search, validity via data-business search, similar cases via judgment search.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Lex · Criminal Defense Suite", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install UzMQPvaZqdmpluQsbY-eng

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (3):
- criminal-defense-workflow — 刑事辩护全流程总控（识律刑事辩护套件入口技能）。当用户提出刑事案件材料（起诉意见书/起诉书/卷宗/判决书）、要求刑事阅卷分析、辩点梳理、辩护策略路径选择、定性或量刑方向判断时使用。按审查起诉—一审的阶段推进（侦查阶段不在本技能主流程内，见阶
- criminal-plea-and-nonprosecution — 认罪认罚与不起诉论证（识律刑事辩护套件原子技能）。审查起诉阶段使用：当用户问"要不要认罪认罚""认罪认罚协商""量刑建议协商""能不能不起诉""法定/存疑/酌定不起诉"或由 criminal-defense-workflow 调度时使用。输
- criminal-trial-examination-outline — 庭审发问与举证质证提纲（识律刑事辩护套件原子技能）。一审阶段使用：当用户说"庭前会议""排非申请""非法证据排除""庭审发问""发问提纲""质证提纲""举证质证""交叉询问""逐份质证""辩方举证"或由 criminal-defense-w

MCP server references (2): fd-legal-search-mcp, fd-find-data-business-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
