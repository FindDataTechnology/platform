## 1. 蓝图构造师（Builder A2）——已实施

- [x] 1.1 `server/blueprint-author.js`（桥，`/api/blueprint-author`）+ `server/blueprint-author-mcp.js`
      （桥子三工具：drafts_list/validate/save）；validate=既有 `validateBlueprint` 全链逐字段原文；
      save 校验绿才 `store.createBlueprint`（与粘贴通道同池同链）；**无 approve/cast/trial/delete**
- [x] 1.2 `platform.bundle.json` 登记（bundled 自激活）；`server/auth.js` loopback 豁免
      （`isInternalBuilderBridges`，与 architect 同款）；`server.js` 挂载；
      `scripts/test-builder-author-bridges.mjs` 6/6（红环不落池、绿稿落池同池、
      桥子/桥 HTTP 面双查无越权动词）
- [x] 1.3 种子 persona 收编 promptIntro+DRAFT_SCHEMA+constraints 全部纪律 + 边界句
      （改现役团队→团队架构师；批准/铸造/试跑→主人在构造间）；测试钉边界句

## 2. 智能体作者（Builder B）——已实施

- [x] 2.1 `server/pack-author.js`（桥，`/api/pack-author`）+ `server/pack-author-mcp.js`
      （桥子四工具：drafts_list/market_servers/validate/save）；validate=既有 `validatePackManifest`；
      save 把 manifest **投影成草稿 entries**（编辑器形状）落既有 packStore，按 draftId 更新不蔓延；
      **无 publish/pricing/deploy/mint**，响应明示「Saving is NOT publishing」
- [x] 2.2 bundle 登记 + auth 豁免 + server.js 挂载；单测：红 manifest 拒交付、绿稿落池无 packId、
      更新不蔓延、market_servers 只出 registry/bundled 目录条目（ctx 无 extensionStore 时诚实空表）
- [x] 2.3 种子 persona 收编采访流程（技能/MCP 引用/角色）+ 边界句（发布→编辑器发布门；分身→分身工坊）

## 3. 种子与门——已实施

- [x] 3.1 `docs/blueprint-architect.seed.json`、`docs/pack-author.seed.json`：过 pack 清单校验 +
      en 副轨全覆盖（3:1 比率门逮 description 超长两处已压缩）；`official-locale-coverage` 门纳入
      两份新种子并加「全部官方资产过 pack 校验器」用例——**该门随即逮到 #3 遗留的三处 guide 步骤
      比率超限（facade-builder×1/finddata-facade×1/架构师 notes 缺 en）已全修**
- [x] 3.2 分工互斥：四员 persona 边界句齐（架构师 v1.2 补「模板起草归蓝图构造师」）——测试钉住

## 4. 入口接线（web）——已实施

- [x] 4.1 蓝图构造间粘贴引导加直通车道句（粘贴通道保留）；综合看板空态加 Builder 指引；
      pack 草稿空态加智能体作者指引
- [x] 4.2 四员官方徽章随 #2 的 `official` 判定自动呈现（铸造上架后即带）；i18n 五语言同批，locale 闸绿
- [ ] 4.3 e2e（对话内起草→构造间见草稿）：依赖铸造上架后的真机链路，随走查班补

## 5. 验收

- [x] 5.1 七套单测 85/85（含既有 fleet-architect/templates/pack-locale 系列）+ typecheck/biome/locale 绿
- [ ] 5.2 真机走查：无构造师安装的 cell 粘贴通道照常；安装后对话内起草落池；两通道草稿同池同权
- [ ] 5.3 铸造上架四员 pack（与 rebrand/i18n 合班发版），官方集合读面可见四员
