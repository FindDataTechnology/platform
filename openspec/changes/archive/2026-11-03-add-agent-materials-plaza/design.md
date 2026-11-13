## Context

底稿 `docs/plaza-explore.md`（探索全记录：事实底座、五裁定、IA、管线、风险）。前置：`rename-agent-materials-plaza` 提供 v5 品牌终词（已 apply 6/7）。三个关键家世：①生产注释层 `market-annotations.json` 已有 canonical+human 五语+provenance 形状（AI 面零新增词汇的依据）；②官网部署配方在册（site-zhiyu 纯静态 + 雷池 WAF → 本机 Caddy file_server，台账 §15.59 yongyi/memory 双域名先例）；③facet `loadListedPacks` 是唯一上市判据（wire-marketplace-json-curation 疤——第二套上架规则已经出过一次事故）。

**v2 现状（2026-11-03）**：agent.finddatatech.cloud 已上产（雷池 site 31 并域 cert 59，台账 §9）。v2 的增量裁定来自用户批评：核心=素材清单本身，而 v1 只接入 1/3（packs）；skills（197）与 MCP（13 服务/649 工具）有现成匿名端点未暴露；三域（agent/skills/mcp）都该通向此站。

## Goals / Non-Goals

- Goals：让外部人与 AI 在零协助下理解"提供什么基础设施 / 怎么提供 / 现有什么素材"；**三类素材全量在场**；清单真源单一；新鲜度可见；AI 面可被门守；三域一门。
- Non-Goals：不改 facet 三端点行为（只读）；不做登录/发布/订阅（动作全部跳转壹座与 facet 既有面）；不做服务端渲染或新进程；MCP 工具不拆独立页（随服务页内嵌）；本 change 不含 DNS 操作（skills DNS 已生效，外部件）。

## Decisions

1. **纯静态 + 构建期导出，不建服务**（D3 裁定落地）。备选"边缘函数实时代理市场 API"被否：多一个进程多一条运维面，而快照+客户端刷新已满足新鲜度；site-zhiyu 同配方零服务先例。
2. **catalog.json 复用注释层形状，零新词汇**（D4）。备选"自造 schema.org 全套"被否：生产注释层已是双向注释的家法，跨源不可混排（official-adopted-agents 律），AI 面与运行时面用同一形状才谈得上"平台内外的 AI 读到同一套素材"。
3. **各自注册表的公开面=各自唯一的准入判据**：packs 走 `loadListedPacks` 镜像，skills/mcp 走注册表可见性规则（无 requiredGroups=公开；组门条目匿名永不出场）。备选"导出端重写过滤"被否——判据漂移即假上架。逐源数目对账门（packs 对 marketplace.json 权威，skills/mcp 各对其源计数）。
4. **AI 面三件套分层**：llms.txt（索引面，en 主 zh 镜）→ catalog.json（数据面）→ materials/*.md（叙事面）。llms.txt 生态尚在形成期，故自足 Markdown + JSON-LD 是主承载（D5 风险裁决）；根路径 /llms.txt + /robots.txt 已补（AI 冷读走查揪出的摩擦）。
5. **六条 ai_readable lint 做成门而非守则**（星研纪律的家世：规则写了没人查就等于没有；星研把 ai_readable_check 做成了第 4 道机检，广场同法）。
6. **slug 稳定性 + species 前缀**：pack-（packId 派生）/ skill-（技能 name 派生）/ mcp-（服务 name 派生）——三注册表同名不碰撞；内容更新不动地址；类目枚举带版本字段。
7. **域名 agent.finddatatech.cloud**：一产品一域名家族（yongyi/memory/zhiyu/wanxing/facet/mcp）。备选"挂 www 子路径"被否：www 是另仓另班，互链即可不强绑。
8. **v2 skills 五语：zh 直通为先**。197 条技能无注释层，四语槽位暂同文（provenance 如实标注源与日期），翻译批后续。备选"先攒翻译再上"被否：素材在场比译齐更要紧；AI 面读 canonical 不受损。
9. **v2 mcp. 根跳转：Caddy 层 cookie 感知定向**。匿名根 302 → 广场（MCP 类预选）；带注册表会话 cookie 者照旧进控制台（registry-product-home spec「已登录根路径=控制台」场景保持）；`/<server>/mcp`、`/api/*`、/static 永不跳——13 个 MCP 服务的实际协议端点住在此域。备选"改 registry 应用根页"被否：跨仓改代码，而边缘层一个 matcher 就够；备选"整域跳转"被否：直接砍断 13 个服务端点。
10. **v2 MCP 工具不拆页**：649 个工具随 13 个服务素材页内嵌（tool 名+描述+toolCount+license+provider）。备选"每工具一页"被否：检索需求未出现，649 页是维护税；服务页已自足。
11. **v2 hero 重定心**：三类素材活计数（智能体/技能/MCP 服务/工具数）为主数据，机制链叙事退居其后。备选"保持叙事 hero"被否：用户裁定核心是素材清单。
12. **v2 三域接线走既证流程**：skills. 域 DNS 已生效 → Caddy 新块（同 site root + hostname 感知由站内 JS 读 location.hostname）→ 雷池 site 31 并域 17→18（GET 活体→全字段 PUT→读回核验）→ **证书重签 18-SAN**（`-d` 清单逐个核对——zhengxin 被挤出的事故律）→ push-cert。

## Risks / Trade-offs

- 快照新鲜度：静态面天然滞后；缓解=客户端实时刷新+快照日期永远可见（走查班验证两态）。
- skills 四语同文是已知债：provenance 如实 + 翻译批记挂；catalog 形状不因暂缺而变形（五语槽位在）。
- mcp. cookie 感知跳转依赖会话 cookie 名的稳定性：registry 会话机制若改名，跳转 matcher 需同步——回归断言「带会话根路径不跳」入部署验单。
- 18-SAN 重签的挤出风险：真事故先例（zhiyu cert 57）——`-d` 清单 17 旧域逐个核对后再加 skills，签完 SAN 计数=18 才推。
- 冷读三问断言依赖模型判定，非确定性——lint 里做成"三问结构字段齐全"的确定性检查 + 走查班抽真机冷读双保险（已跑过一轮全过）。
- facet 匿名读面若限流收紧，导出构建在 CI 可能被 429——导出脚本带退避与上次快照续跑（--allow-stale 已实装）。
