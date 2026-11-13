# add-lex-line-board Tasks

> paas 姊妹单（finddata B2 `line-onboarding-contract-v2` tasks §5 的索引实施单）。
> 前置复核：paas 分支 `release/cell-session-persona`（81ce42d6e），boards 骨架 `:line` 通配已覆盖新线。

## 1. 适配器

- [x] 1.1 `lib/board-adapters.js` 新增 `LexBoardAdapter` 四块（D3 形状照 wire 四块模板）：概览（lex_me/lex_usage/lex_quota 三读指标）、我的凭据（lex_credentials_list：名称/状态/到期）、套件（lex_surface_overview 六套件矩阵静态事实）、账单（lex_billing 时间线）——验证：数据源=用户 lex 凭据直读 lex.finddatatech.cloud 客户面（与 lex-ops-mcp 同源不同通道），零模型回合零 token（commit 6f0dbdb19；端点形状对 fd-lex server routes 勘验后真读——me/usage/quota/billing 带 period=YYYY-MM、credentials=registry patch-keys 元数据）
- [x] 1.2 Q1 核实：lex 客户面是否有面向用户的计量流水读端点支撑「账单」块——核实结论落档；缺则该块诚实降级「建设中」+原站深链，不阻塞交付（定谳：console/billing 真存在且返回周期账本流水 entries+totals——账单块真读可行，降级路径仅留作上游失败兜底；fd-lex console_api/routes.py:193）
- [x] 1.3 ADAPTERS 注册 `["lex", new LexBoardAdapter(...)]`——验证：`GET /api/boards/lex` 走查四块（已连接/未连接/单块失败三态）（adapter 级三态仿真全过：connected 四块真数据/401→markInvalid+expired/单块失败仅该块 ERR；生产 pod 内 listBoardLines=[facet,wanxing,wire,lex]+未连接态 fetchBlocks 回包诚实；线上 401=会话门在岗与 wire 同判）

## 2. 呈现

- [x] 2.1 appCatalog lex 徽标 `early` → `live`（与看板同 commit）——验证：卡片徽标线上 live
- [x] 2.2 六语词条（看板标题/块标题/空态/降级文案）——验证：zh 主轨 + 五语副轨词条在册（zh-CN/en/ja/fr/es board.tab 新三键+board.metric 新三键；expiredBody 去「柏讯」专名中性化——同批修的既有欠账）

## 3. spec 增补与收尾

- [x] 3.1 spec delta `specs/line-boards/spec.md`：+3 REQUIREMENTS（lex 看板直读客户面数据 / 凭据态诚实呈现 / 每块原站深链——照柏讯三条同形，WHEN/THEN 场景各二）——验证：delta 语法过 `openspec validate add-lex-line-board --strict`（2026-11-09 复核：文件已在盘上，3 Requirement × 各 2 Scenario = 6 条 WHEN/THEN，validate --strict 通过；此前只是漏勾）
- [x] 3.2 滚版 + 线上走查：spec 场景逐条走查记录落档；finddata B2 门 `--line lex` L7 转 PASS——验证：走查记录 + 门输出全 PASS（滚版走通：org billing 墙拒跑私仓 image.yml→备用池出片 law-bench/platform:sha-5254a72（镜像 home yizuo→law-bench 迁移，tcr-ccr pull secret 拉取实测 PASS）→bump c5dcfa3→ArgoCD Synced Healthy，pod imageID digest c95a76dd；finddata 门 --line lex 全 PASS EXIT=0，全量剩余 5 FAIL 全为 ERP 如实未接入）
