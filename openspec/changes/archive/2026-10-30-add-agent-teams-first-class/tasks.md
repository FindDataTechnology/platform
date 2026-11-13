## 1. 前置核实（词表分类是第一批活）

- [x] 1.1 逐条分类 zh 的 22 处「集群」：团队 / 桌面机群 / 部署集合 三类判定（结论：`fleet.*`、
      `nav.fleet`、`board.tab.fleet-summary`、`onboarding.tour.stepFleet.*`(desktopOnly) 为机群/部署语义，
      保留「机群/集群」；其余 19 处改「智能体团队」）
- [x] 1.2 `packs.wizard.*` 核实结论：FleetTemplateWizard 走 `/api/fleets/from-template`，实化对象是团队——改「团队」正确
- [x] 1.3 `surfaces.ts` 结论：query 参数子面无需导航登记（slug 不变，factory preset 零影响）

## 2. 词表改名（五语言同批）——已执行并扩批

- [x] 2.1 zh-CN 20 处改「智能体团队」（见 1.1 分类；3 处机群语义保留）
- [x] 2.2 en/es/fr/ja 同步改写；**词表 v4 扩批（2026-10-30 用户裁定）**：阵列→小组、能力包→智能体、
      能力市场→智能体市场、品牌→壹座·智能体基础设施，五语言 ~660 处（机械替换+复合句手工修+fr 缩写冠词），
      技能包/dsh 插件包豁免
- [x] 2.3 `check:locales` 绿；zh 全量审计零残留（阵列/能力包/能力市场/舰队=0）；e2e 三处文案断言同步

## 3. 服务端：列表字段与批量端点

- [x] 3.1 `GET /api/fleets` 行内补 `defaultModel`/`effort`/`contextBudget`/`spend`（只增字段）；
      `scripts/test-fleet-list-fields.mjs` 4 用例（null 缺省/PATCH 回路/spend 形状/owner 隔离）绿
- [x] 3.2 `POST /api/fleets/batch`：逐条串行+逐条回执+单条失败不中断+越权/未知 id 统一 "not found"+
      去重+超上限整批拒（`FLEET_BATCH_MAX` env 可调默认 50）；`scripts/test-fleet-batch.mjs` 6 用例绿
- [x] 3.3 两测试文件入 `test:unit` glob；既有 `test-fleet-core`+`test-fleet-owner-surface` 30/30 零扰动

## 4. 前端：三面 + 行内编辑 + 批量

- [x] 4.1 `TeamsOverviewBoard`（跨团队聚合 + 汇总条 + 异常优先排序 + 三路独立降级 + 卡片进驾驶舱）；
      **实施扩展**：hub 增第三面 `?view=owner`（经营坞 OwnerBoardStrip 原样保留可达——其订阅/花销/
      市场行能力不被新默认视图埋没）；`/fleets` 默认=综合看板（自动选中首队的旧行为移除，
      remembered selection 不再强制进驾驶舱——深链仍直达）
- [x] 4.2 `TeamsManagementView`：清单 + 行内编辑（名称/默认模型/状态，逐行错误反馈不污染全局）+
      勾选批量 + 逐条回执（成功 N/失败 M+失败逐条）+「进驾驶舱」直达；manage 面隐藏左栏（表格即清单）
- [x] 4.3 视图切换（`?view=` query）挂在导航项内；`/fleets/:id` 深链不进切换态且切换器隐藏
- [x] 4.4 i18n `agentTeams.*` 五语言同批（注意 i18next 插值是双花括号）；`check:locales` 绿
- [x] 4.5 e2e `e2e/fleet-hub.spec.js` 四条绿（汇总条+异常排序、行内改名 PATCH 回路、批量部分失败
      逐条回执、深链不变）；既有 `fleets.spec` 四处 goto("/fleets") 期待驾驶舱的用例改深链（契约变更的
      既有面随行），27/27 绿

## 5. 验收

- [x] 5.1 单测（新旧 40/40）+ e2e（27/27）+ `openspec validate --strict` 绿 + typecheck 绿 +
      biome 触碰文件绿（fleets.js 两条 pre-existing lint 非本批引入，不越界代修）+ locale 闸绿
- [ ] 5.2 真机走查：无团队空态 → 建两支团队 → 综合看板见汇总条与异常排序 → 管理面行内改名/换模型
      → 批量暂停（含一支归档做部分失败）→ 逐条回执 → 点进驾驶舱 → 深链书签直达（随出片走查班）
