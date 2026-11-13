# Tasks — 市场货架整体优化（P0 断点 → P1 分类骨架 → P2 卡片详情 → P3 格式 v2 → P4 内容与门）

> 分期纪律：每期独立可出片，P0 与 P2 可并行。每期完成即走一次出片走查（生产 en 全程浏览 + zh 回归），不攒到最后。
> 并行纪律：提交只 `git add` 本 change 相关文件，勿 `-A`；共享工作树提交前先 `git branch --show-current`。

## 1. P0 · 修断点：语言变化即重取（不换设计）

- [x] 1.1 语言变化即重取（落在组件触发层，不是 API 模块内建订阅——数据层无 store，订阅点在宿主视图）：`PackMarketView` 与 `PackDetailDialog` 各持 `i18n.language` 触发器（ref 持最新 refresh/search，避免陈旧闭包），变化即以新 locale 重发；验证：e2e「market refetches when the locale switches」两种视图各断言一次
- [x] 1.2 `PackMarketView`：重取改为**静默刷新**（`refresh(..., { silent: true })` 保留已渲染列表，不落 MarketSkeleton；失败不落破坏性错误框）；验证：e2e 切语言过程中卡片保持可见、无骨架帧
- [x] 1.3 `PackDetailDialog`：语言��化重取当前 `packId`（静默、不重置会话态；`packChanged` 分支保留 packId 切换的完整重置）；验证：e2e 详情开着切语言，标题随语言变
- [x] 1.4 重取失败保留旧数据 + 非阻断提示（新键 `packs.market.staleLocale` 五语，`data-testid=pack-market-locale-stale` / `pack-detail-locale-stale`）；验证：`npm run check:locales` 五语 parity 绿
- [x] 1.5 线标签多语言化：新增零依赖叶 `lib/pack-taxonomy.js`（zh 线词 → 规范 slug → 五语标签，带主子标签回落，未映射透传），归位真源仍是 `lib/pack-category-lines.js`（零改动）；读面每行同时下发 `line`（筛选身份）与 `lineLabel`（本地化标签）；验证：`scripts/test-market-locale-refetch.mjs` 8/8
- [x] 1.6 搜索跨轨道：`list()` 在非 zh 请求时把 search 子句扩到 `json_extract(manifest,'$.i18n."<tag>".name/description')`（含主子标签回落）；zh 请求子句逐字节不变；验证：单测 en 搜 `Strategy Lab` 命中 / zh 搜同一词 0 条 / zh 关键词照常命中
- [x] 1.7 facet 详情弹窗降噪：`PackMarketView`→`PackDetailDialog` 新增 `installSurface`（默认 true），facet 壳传 false 跳过 deployments/billing 三探针；验证：facet 壳 e2e 通过且弹窗仍正常
- [x] 1.8 新增 `scripts/test-market-locale-refetch.mjs`：线标签投影矩阵 / 跨轨道搜索 / 未覆盖 locale 回落 / en-US 主子回落 / 纯 zh 包在 en 下命中；验证：`node --test` 8/8
- [x] 1.9 `e2e/facet-shell.spec.js` 增加切语言用例（真 facet 服务 + 真 SQLite 种子 + src 构建的壳）：zh 卡 → 切 en 卡与 chip 同变 → 跨轨搜索命中 → 详情开着切回 zh；同文件把陈旧断言 `My packs` 更新为已合入的 `My agents`（词表改名，HEAD 已落地、spec 未跟）；验证：该 spec 9/9
- [x] 1.10 出片验证：生产 `search=strategy&locale=en` > 0、en 下线 chip 为英文、切语言无手动刷新即变身；台账记录

## 2. P1 · 分类骨架：声明的两轴分面

- [x] 2.1 `lib/pack-taxonomy.js`：线表（5 值，slug+五语标签+固定顺序）+ 领域词表（slug+五语标签+声明顺序）+ env 覆盖（`PACK_DOMAIN_TAXONOMY`，非法覆盖回落内置）+ `slug→line` 归位与 `company/facade→null`；单测：词表形状、覆盖生效与回落、归位矩阵
- [x] 2.2 `lib/pack-category-lines.js` 改为薄兼容层转调新表（导出签名不变）；验证：`scripts/test-category-line-mapping.mjs` 不改断言全绿
- [x] 2.3 `packs` 表新增 `domains` 列（JSON 数组，nullable）；写入点=发布（来自 manifest，P3 接线前先允许空）与策展端点；`category` 列零迁移
- [x] 2.4 `GET /api/packs/facets`：按 locale 返回 `{lines:[恒 5 条含计数 0], domains:[计数>0，声明顺序]}`；单测：恒 5、空线计数 0、领域零计数不出现、顺序=声明顺序
- [x] 2.5 `PackMarketView` 分面改用 facets 端点，两行分轴（线常驻 / 领域第二行）；零计数线灰化，点击给"该线暂无上架内容"提示；验证：e2e 分面形状 + 内容增减不改 chip 形状
- [x] 2.6 未归类档：无法归位的条目不进任何 chip，策展板以待办样式高亮（列出缺领域声明的条目）；验证：策展板 e2e
- [x] 2.7 `CurateView`：领域改词表多选选择器（写 `domains` 列），去掉自由 slug 输入；存量词表外取值显式标示不合法且发布被阻（与 P3 校验器联动，先落 UI 与存储）；验证：选择器只列词表项、保存后 facets 计数变化
- [x] 2.8 迁移脚本 `scripts/migrate-pack-domains.mjs`：按 category 归位批量回填 75 条的 `domains` 列，先 dry-run 打印清单，人工过目后落盘，输出审计清单；验证：回填后 facets 计数与手算一致、`category` 列逐字节不变
- [x] 2.9 线/领域标签住服务端词表（非 web locales），五语完备性由 `scripts/test-pack-taxonomy.mjs` 钉（每线×五语、每域×五语断言）；新增 UI chrome 键（packs.market.domains/lineEmpty、facetCurate.* 八键）走 `check-locales` 门绿
- [x] 2.10 出片验证：生产分面恒 5 线带计数、en 标签、裸 slug 零出现；台账记录

## 3. P2 · 卡片与详情的信息架构（不依赖 v2 字段）

- [x] 3.1 新组件 `PackIdentityMark`：服务端生成印章（线色底 + 线单字 + 结构角标），复用 `SiteMark` 印章语言与 `DESIGN.md` 字号登记；验证：五线 × 四结构快照测试，无任意值新登记外漏
- [x] 3.2 新组件 `PackCard`：五槽位（身份/承诺/可得信号/适用人群/边界）+ 降级链（promise→首句→name；整词截断补省略号；缺槽整段省略）；验证：单测覆盖降级链全部分支与"最长 678 字 description 不再出半行"
- [x] 3.3 `PackMarketView` 普通卡与官方画廊卡统一走 `PackCard`；消除嵌套可点目标（fork 链接移出卡片可点区）；验证：e2e 键盘 Tab 卡片单一焦点停靠点
- [x] 3.4 `PackDetailDialog` 七段式重排（首屏承诺/你会得到/三步上手/示例指令/三桶/边界与诚实声明/版本+常驻 CTA）；缺段整段省略；技能正文全量检视不回退（既有 e2e 锚点 `pack-skill-*` 保持）
- [x] 3.5 示例指令可点：壹座宿主带 prompt 进对话（parked-draft 通道，DocumentsPage 先例），facet 匿名复制到剪贴板；验证：e2e 两宿主各一条
- [x] 3.6 官方徽章收敛：列表/详情徽章只按服务端来源判定投影；roster 复核（71/75 通胀消除——非名册作者条目不再带官方徽章）；验证：`scripts/test-official-showcase.mjs` 扩断言
  > 复核实录（2026-11-03，现网 /api/packs?pageSize=100 全量对账）：徽章已是纯名册投影——4 支非名册作者条目（ops-seed/chengsi/qq/doc-studio）零官方徽章，名册内作者全部带章，互斥矩阵由 describeProvenance 单点裁决（adopted×名册外=community 无键）。71/75 之「通胀」不是投影缺陷而是供给结构：62 支官方内容全在走查账号 aloadtree@gmail.com 名下发布（供给发布身份卫生，归后续供给面提案，不属本 change）；扩断言 7/7 绿（含 en 轨不丢章、详情同判两防漏）。
- [x] 3.7 `facet/web/DESIGN.md` 登记：新印章字号、新增任意值（若有）、入场动效（rise-in stagger ≤200ms）；`design-lint` 门绿
  > 印章尺寸沿用既有登记（SiteMark 例外 §1/§2 零新增）；stagger 公式单点住 PackCard（§3 登记）；新微标「已复制」入 §1 白名单。design-lint 无新违例（P2 顺带还清了 P0 欠的 3 处 amber 命名色，基线 −9）。
- [x] 3.8 e2e：卡片五槽位、详情七段、facet 壳 `#/packs` 无 Router 回归用例；`npm run test:e2e` 绿
- [x] 3.9 出片验证：生产卡片五槽位眼见、详情七段眼见、壹座 Store 面同步回归；台账记录

## 4. P3 · 显示格式 v2 + 作者端翻译工作台

- [x] 4.1 `lib/pack-manifest.js`：v2 字段校验器（identity/promise/audience/outcomes/examples/domain 形状、显示宽上限、词表校验）；新增 `scripts/test-pack-display-format.mjs` 校验矩阵（含超宽/越界/词表外/色值拒绝）
- [x] 4.2 `LOCALE_OVERLAY_KEYS` 扩容（promise/audience/outcomes/examples/domain/tags/identity.mark.value）+ 叠加校验（数组等长对齐、结构字段禁入）；验证：overlay 校验用例 + `pack-locale-tracks` 场景逐条对上
- [x] 4.3 `lib/pack-locale.js` 投影扩展：v2 字段按 locale 覆盖与 zh 回落；验证：en/ja 请求投影单测
- [x] 4.4 发布面把 manifest `domain[]` 写入 `packs.domains` 列；策展端点接受 `domains[]`（词表内）；验证：发布→facets 计数联动单测
- [x] 4.5 读面透传：summary/detail 携带 v2 字段；`PackCard`/详情消费（无 v2 字段时降级链不变）；验证：**存量 manifest 变更前后投影 diff=0** 快照测试（逐字节）
- [x] 4.6 官方发布门：名册作者 + en 组织面未满覆盖 → 422 结构化缺项清单；非名册不受限；验证：`scripts/test-pack-registry.mjs` 增两侧用例
- [x] 4.7 作者端翻译工作台（`PackDraftsView` 抽屉）：zh/目标语并排、组织面覆盖率、缺项定位跳转、经 `entries.i18n` 保存；不写翻译不产生空 `i18n` 键；验证：e2e 编辑器补 en→发布→市场英文读面呈现
- [x] 4.8 领域/适用人群选择器接词表；词表外存量取值标示不合法并阻发布、保存零静默改写；验证：e2e 三态（合法/不合法/保存保留）
- [x] 4.9 发布前分级提示：官方阻断（列出缺项+跳转工作台）、社区非阻断；服务端错误如实透出（服务端是真值）；验证：两身份各一条 e2e
- [x] 4.10 外部投影：`facet/marketplace-repo.js` 增加 `facet.json` sidecar 纯透传 + README 首行优先 promise；`marketplace.json`/`plugin.json` 结构零变化；验证：`scripts/test-facet-marketplace-repo.mjs` 增三用例（sidecar 逐字节、清单结构不变、README 首行）
- [x] 4.11 覆盖度仪表组件（分母=组织面，缺项精确到字段路径）；详情"边界与诚实声明"段接入；验证：社区条目 0/m 与 m/m 两态 e2e
- [x] 4.12 `npm run check:locales` + `design-lint` + `npm run test:unit` 全绿；出片走查（老包渲染逐字节回归 + 新字段包眼见）

## 5. P4 · 内容迁移与覆盖门

- [x] 5.1 审计脚本 `scripts/audit-official-locale-coverage.mjs`：对在架目录按组织面核算官方条目 en 覆盖，缺项清单（pack id+字段路径），存在缺项非零退出；验证：对当前生产跑一次，输出与手抽 3 条一致
- [x] 5.2 内容作业：23 条 zh 泄漏逐条补 en（技能 61 条、agent 名 8 个、guide 按包计），按审计缺项清单逐条消项；验证：审计转绿（0 缺项）
- [x] 5.3 标签归一：`柏讯`/`wire` 同义双写合并为受控 slug；自由标签单语化（进 `i18n.tags` 轨道）；验证：生产 en 下列表标签零中文残留
- [x] 5.4 覆盖度看板进策展板：全部在架条目的 n/m 覆盖与缺项列表（运营巡检入口）；验证：策展板 e2e
- [x] 5.5 官方发布门开启前检查：在架官方 71 条覆盖 100%，门常绿一周后再视为稳定；验证：审计脚本连续 7 次运行零缺项
- [x] 5.6 生产走查全链：en 全程（浏览/分面/搜索/详情/示例可点/覆盖标记）+ zh 逐字节回归（列表投影 diff=0）+ facet 与壹座双宿主；台账 §9 发布记录
- [x] 5.7 OpenSpec 归档准备：主 spec 同步核对（pack-marketplace / pack-locale-tracks / pack-category-line-mapping / official-locale-coverage / pack-authoring 的 MODIFIED delta 带全量既有场景），`openspec validate --specs` 全绿
