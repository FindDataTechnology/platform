# Wire · Policy Transmission / 柏讯 · 政策传导

## What this is

柏讯政策传导四件套：政策识别（部委条目 source_type=ministry，读正文抽发布机关/文号/政策工具/适用范围/生效时间/执行期限/量化目标七件套，每项要素附 item_id、as_of 与经 locate_evidence 核对的逐字片段）、行业映射（政策要素→受影响行业/区域→可检验变量三段映射，变量必须在年鉴/城市/公司面板真实检索到，两档置信度：政策明示/语义推断，无变量环节进未验证清单）、区域与企业传导（事件窗与政策强度序列两条路线逐环检验，相关系数、时滞扫描、样本量与窗口随行；结论三档——已验证/不显著/未验证环节，未验证环节必须显式标注，相关系数与样本量随每条结论输出；历史统计关系非因果证明）、政策跟踪（部委条目流计数与期间对比、健康度水位、已验证链路命中登记只转引不新增结论）。核心纪律：健康度前置（引用前先查 stream_health，lag 超阈值声明信息可能不完整）、区分已验证与未验证环节（无数据的一环明示未验证，绝不默认政策必然传导）、相关系数与样本量随结论输出、不因果表述不预测。不构成投资建议。

Wire Policy Transmission four-skill set: policy identification (ministry items with source_type=ministry; read the body and extract the seven policy elements — issuing agency, document number, policy instrument, scope of application, effective date, enforcement horizon, quantified targets — each element with item_id, as_of and a verbatim quote verified through locate_evidence), industry mapping (three-stage mapping policy elements → affected industries/regions → testable variables; variables must be genuinely retrieved from the yearbook / city / firm panels, two confidence tiers — stated in the policy / inferred semantically — and any link without a variable enters the unverified list), regional and firm-level transmission testing (two routes — event windows and policy-intensity series — checked link by link, with correlation coefficients, lag scans, sample sizes and windows printed on each row; conclusions in three tiers — verified / not significant / unverified links, the latter explicitly labeled, correlation and sample size accompany every conclusion; historical statistical relations are not causal proof), and policy tracking (ministry stream counts and period comparison, health watermark, and a hit-register that merely cross-references verified chains without adding conclusions). Core discipline: health first (check stream_health before citing; over-threshold lag means declaring 'information may be incomplete'), separate verified from unverified links (a link with no data is explicitly unverified — never assume a policy must transmit), correlation and sample size accompany every conclusion, no causal wording, no forecasts. Not investment advice.

- Species: pack (plaza category enum v1)
- Official: yes — curated by FindData



## How to obtain

Three paths, all landing the same frozen version snapshot:

1. In 壹座 (Yizuo): open the market tab, search "Wire · Policy Transmission", subscribe and install.
2. In a CLI-capable editor (Claude Code, Cursor, Codex, Gemini CLI, ZCode):

       npx @finddatatechnology/facet install ceuUUWYFYH_HiYnJ6UYqSg

3. From the market page: https://agent.finddatatech.cloud/#/packs

## What it contains

Skills (4):
- policy-detection — 柏讯政策传导 · 政策识别。当用户要求"最近有什么新政策""把某部委近一月的发布理一下""这条政策文件说了什么"时使用。先查来源健康度，再取部委条目（source_type=ministry），读正文抽取政策要素（发布机关/文号/政策工具/
- policy-mapping — 柏讯政策传导 · 行业映射。当用户要求"这条政策影响哪些行业""政策落到哪些可检验的指标上""给我政策—行业—变量的映射表"时使用。把政策要素映射到受影响行业/区域维度，并逐一检索真实在册的检验变量（年鉴/城市面板/公司面板），两档置信度（
- policy-transmission — 柏讯政策传导 · 区域与企业传导检验。当用户要求"这条政策到底传没传到行业/区域数据""政策发布后地方指标变了吗""政策与公司科目有没有统计关系"时使用。对映射交来的每条"政策→变量"假设逐环检验：相关系数、时滞扫描、样本量与窗口；结论三档
- policy-watch — 柏讯政策传导 · 政策跟踪。当用户要求"帮我盯着部委发布""每旬把新政策理一遍""跟踪表里标一下哪些撞上了已验证链路"时使用。按部委来源与政策工具类型筛条目流，输出条目清单、来源计数、期间对比与健康度水位；对映射/传导已登记的政策标"同一事

MCP server references (4): fd-info, fd-find-data-business-mcp, fd-quant, wire-build-mcp

## As of

Provenance: https://facet.finddatatech.cloud · As of: 2026-11-05
