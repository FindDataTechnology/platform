## 1. 导出管线与校验门

- [x] 1.1 `scripts/plaza-export.mjs`：从 facet 市场 API 经 `loadListedPacks` 判据拉全量 listing，产出 `snapshot.json`（带生成日期）—— 验证：对生产 API 实跑，条数与 `/api/packs` 对账相等
- [x] 1.2 `catalog.json` 生成：复用注释层形状（canonical.brief + human 五语 + whenToUse + provenance），来源=listing 字段 ∪ 既有 market-annotations（有则并、无则 listing 摘要兜底）—— 验证：schema 断言每条四字段齐
- [x] 1.3 `llms.txt` / `llms-full.txt` 生成（en 主 zh 镜，逐节指针+自足摘要）—— 验证：每条链接可达断言通过
- [x] 1.4 `materials/*.md` 生成（en+zh，slug=packId 派生稳定地址）+ `infrastructure.md`（输入-动作-产出表格化）—— 验证：三问结构字段（是什么/怎么获取/截至何时）逐页齐
- [x] 1.5 ai_readable 六条 lint 成门：自足节/实体写全/术语唯一/输入-动作-产出/三问结构/provenance 必带，红则 exit 非 0 且零产物 —— 验证：`scripts/test-plaza-export.mjs` 含故意坏例各红一条
- [x] 1.6 数目对账门入导出（差非零即红，双计数入错误信息）—— 验证：mock 差一即红

## 2. 官网静态站 site-plaza/

- [x] 2.1 站骨架：五语 hero + 五类素材卡墙（功能集/生态技能/MCP 服务/AI 分身/官方数据锚，各带实例）—— 验证：五语各页全节渲染，`node scripts/check-locales.js` 或站内 parity 断言绿
- [x] 2.2 机制链四段（发布→获取→运行→服务化，素材视角）+ 给谁用双栏（人/AI 机器面指针）—— 验证：冷读自足（每段不依赖上文可读）
- [x] 2.3 素材目录画廊：官方/分身徽章、垂类筛选、检索；客户端拉 `/api/packs` 实时刷新，失败静默退快照并标"快照截至 X"—— 验证：断网/断 API 两态真机各走一遍
- [x] 2.4 人面 JSON-LD + 机器孪生链接；页脚五行梯 + 兄弟站互链—— 验证：解析器抽 JSON-LD 成功；zhiyu/yongyi/facet 往返链接成立
- [x] 2.5 品牌串全部 v5 终词「壹座·智能体素材广场」/ "Yizuo Agent Materials Plaza"—— 验证：grep 站内旧词零命中

## 3. 上产与部署

- [x] 3.1 部署物：静态目录上 cheap/雷池机【配置面已完成：deploy/README+Caddyfile 已写；主机落位+DNS 外部件未做】，Caddy 每域一块 file_server `agent.finddatatech.cloud`（配方同台账 §15.59）；DNS A 记录由域主加（外部件，记录等待）—— 验证：域名解析后 200，无域名前经 hosts 验证
- [x] 3.2 导出进部署链：deploy 前跑 plaza-export（红则中止不发车）—— 验证：故意破坏一条 lint，部署链拒发

## 4. 双面走查（出口判据）

- [x] 4.1 人面走查：五语真机全页 + 两客户端（桌面/移动宽度）眼见—— 验证：截图入台账 §9【已闭：Playwright 真浏览器 21/21（四标签点击断言/三域门/五语+双宽度截图 10 张 gui-test-screenshots/plaza-*.png）；浏览器走查同时逮住 live 刷新顶掉三类快照的真缺陷（见 §9 补记）】
- [x] 4.2 AI 面走查：派真实 agent 从 `/llms.txt` → `catalog.json` → 任一 material md → 真装一个包全链零人工干预—— 验证：走查报告记台账；冷读三问全对
- [x] 4.3 兄弟站互链往返 + www products/facet 页加广场链接（外部件记挂）—— 验证：三站往返成立

## 5. v2 三类素材接入（用户裁定 2026-11-03：核心=素材清单，三类全暴露）

- [x] 5.1 导出接 skills-catalog 源：`/api/skills-catalog` 全量（197）入 catalog，slug=skill-<name> 前缀，zh 直通四语槽位同文（provenance 如实标注源与日期，不伪造翻译）—— 验证：实跑 catalog 中 skill 类计数=源计数；逐源对账门含 skill
- [x] 5.2 导出接 mcp-catalog 源：`/api/mcp-catalog`（13 公开）+ 深度路由全 tool 面入 catalog，slug=mcp-<name>；素材页内嵌 tools[]（名+描述+toolCount+license+provider），不拆工具页—— 验证：mcp 类计数=源计数；任一服务页 tools 明细数=深度路由 toolCount；注释投影 ?locale=en 实测 en 落 catalog
- [x] 5.3 pack 素材页枚举自身内容：pack 详情匿名可读 manifest，页内列出该包 skills 与 mcpServers 引用（"壹座 packs 里面有的"字面暴露）—— 验证：抽 3 包页内核对其 manifest 清单
- [x] 5.4 逐源对账门 v2：packs 对 marketplace.json 权威（现行），skills/mcp 各对其源端点计数，任一差非零即红零产物—— 验证：mock 任一源差一即红
- [x] 5.5 hero 重定心：三类素材活计数（智能体/技能/MCP 服务/工具数）+ 快照截至为主数据；画廊加 species 标签页（agent/skills/mcp 三签，计数各显）—— 验证：counts.json 含三源计数；页面五语 parity 门绿
- [x] 5.6 测试套件 v2：fixture 加 skill/mcp 条目，门套全绿（11 旧测不破+新源用例）—— 验证：`node --test scripts/test-plaza-export.mjs scripts/test-plaza-site.mjs` 全绿

## 6. v2 三域一门

- [x] 6.1 站内 hostname 感知：location.hostname 为 skills./mcp. 时画廊预选对应 species（agent. 不过滤）—— 验证：三域打开预选状态眼见
- [x] 6.2 skills. 域接线：Caddy 新块（root 同 /srv/agent-plaza-site）→ 雷池 site 31 并域 17→18（GET 活体→全字段 PUT→读回核验）→ 证书重签 **18-SAN**（17 旧 `-d` 逐个核对再加 skills——挤出事故律）→ push-cert —— 验证：https://skills.finddatatech.cloud/ 200 且 SAN 计数=18；17 旧域回归全 200/302
- [x] 6.3 mcp. 根跳转：Caddy mcp 块加匿名根 matcher（无注册表会话 cookie 且 path=/ → 302 agent.finddatatech.cloud?species=mcp）；`/<server>/mcp`、`/api/*`、/static 零触碰—— 验证：匿名根 302；任一 `/x/mcp` 端点仍 200/401（非 302）；带会话根路径进控制台
- [x] 6.4 三域回归入部署验单：agent/skills 双域五点验 + mcp. 三态（匿名根跳/协议端点不动/会话不跳）—— 验证：curl 断言脚本入 deploy-plaza.sh，全绿出单
