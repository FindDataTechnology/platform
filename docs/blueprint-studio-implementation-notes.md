# Blueprint Studio 实现指引（v1 切片）· 配套《fleet-blueprint-studio-requirements》

> 用途：给 paas 会话 apply `add-blueprint-studio` 时的落地参考——不是规格（规格以 change `add-blueprint-studio` 为准），而是**finddata 侧会话读过你仓代码后验证过的落地口径**。我试写过一版 Slice 1 服务端脊柱，按「不直改 paas」纪律已整段回滚；若实施时想拿参考实现文件，我可以照本版重产出到你指定路径（说一声即可）。
> 规格层＝本仓 change `add-blueprint-studio/`；命名与语言轨＝本仓存档 `add-ai-native-lexicon`（集群/阵列/能力包/能力市场）；蓝图格式契约＝finddata 根 `vertical-blueprint-constructor`。

---

## 1. 切片规划（三段落，每段可独立验收）

| Slice | 内容 | 验收 |
|---|---|---|
| **1 · 服务端脊柱（本指引）** | 蓝图实体表 + 校验链桥 + 批准/铸造路由 + 市场发布客户端 + 单元测试 | 「草稿→校验→批准→铸造」全程过（publish 客户端注入式 mock） |
| 2 · 编辑/审批 UI | web 侧「蓝图构造间」入口；表单+JSON 双轨；校验回放与 diff 呈现 | 七步旅程的前四步界面全真 |
| 3 · 试跑验收与可售态 | 首轮断言执行/报告落账 + 与 `add-vendor-supply-open`/`add-market-revenue-share` 准入字段对账 | 七步旅程全程（装一台跑一轮，断言全绿才可售） |

## 2. 我仓里验证过的关键约定（别重读）

- **路由挂载点在 `server.js`**：各特性工厂函数成排挂载（如 `createFleetRoutes(app, ctx)`）。蓝图用同款 `app.use(createBlueprintRoutes(ctx))`，紧随 fleet 挂载点（语义最相邻，也与 architect 边界注释对齐）。
- **独立 SQLite，勿动根 db.js**：fleets 的模式是每特性自带 db 文件（同级 `server/routes/*-db.js`）。蓝图用 `storeDir("data")/blueprints.db`（测试以 `BLUEPRINT_DB_PATH` 重指到 tmp 目录），版本记 `schema_migrations`。仓库是多会话高并发状态，根 db.js 另有会话在改——**不可碰**。
- **校验器返回形状**（本指引一小节中最容易踩错）：
  - `server/fleet-template.js` `parseFleetTemplate(manifest)` → **单对象判定** `{ ok:false, error }`（不是 errors 数组；ok 时有更多字段）。
  - `lib/pack-manifest.js` `validatePackManifest(manifest)` → **`[{ error, entry? }]` 数组**（内 `fail(errors, error, entry)`）。错误原文直出即为「无第二校验器」要求面。
  - `allowTools ⊆ 商业集` 闸在**发布门/市场侧**：studio 里本面期待「publish 一道还要走它」——勿复制。
- **发布客户端**：与 `facet-pack-builder/scripts/publish_pack.py` 同一 proxy 通道：`POST {FACET_BASE_URL}/api/packs?packId=<id>`，headers `x-facet-token: process.env.FACET_INTERNAL_TOKEN` + `x-facet-user: <author email>`。宿主有 `FACET_INTERNAL_TOKEN` 即可（paas 宿托管该 env；admin 限流差异与通道本身无关）。
- **测试范式**：`node --test scripts/test-*.mjs`；路由用注入式 `resolveUser` + `publishClient`（不碰真市场门）。
- **Lint/检查**：`npm run lint`（biome）；带 UI 文案后须 `npm run check:locales` 双轨绿。

## 3. Slice 1 服务端形状（参考规格）

### 3.1 实体（`server/routes/blueprints-db.js`）

```sql
CREATE TABLE blueprints (
  id TEXT PRIMARY KEY,             -- 'bp_<ts>_<rand>'
  owner_email TEXT NOT NULL,
  name TEXT NOT NULL,
  one_line TEXT NOT NULL DEFAULT '',
  out_of_scope TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,      -- 蓝图全文（boundary/dataSources/fleet/agents/mcpServers/monitoring/acceptance/board）
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | approved | cast
  version INTEGER NOT NULL DEFAULT 1,         -- 每次编辑 +1
  approved_by TEXT, approved_at TEXT,
  diff_summary TEXT,               -- 批准时留存的「前版 vs 该稿」字段级 diff
  cast_pack_id TEXT, cast_pack_version INTEGER,
  trial_report_json TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX blueprints_owner_idx ON blueprints(owner_email, updated_at DESC);
```

纪律：`updateBlueprint` 必须版本 +1 **并清旧批准**（approved_by/at 置空）——旧稿批准永不延用给新稿（否则 apply 重校验兜底形同虚设）。

### 3.2 校验链桥（`server/blueprint-validate.js`）

顺序：shape 闸（凭据键扫描：禁 `token|secret|password|api[_-]?key|private[_-]?key|endpoint|url|headers` 键名与秘密字面值；`target/registryName/allowTools/requiredGroup` 属契约白名单；`dataSources` 只收在册 server 名/内部库逻辑名）→ `parseFleetTemplate` 直校 `blueprint.fleet`（**零翻译层**：组装 `{fleet, agents, mcpServers}` 喂它）→ 组 manifest 后过 `validatePackManifest`。

铸造 manifest 按现行形状：`category:"fleet"`、name「〈场景〉集群（模板）」、`_casting` 记 `{source:"fleet-blueprint-studio", blueprintId, version, approvedBy, approvedAt, diffSummary}`。

diff：`diffBlueprint(prev,next)` 字段级列表（boundary/dataSources/fleet.members 计数/fleet.orchestration.edges 计数/agents/mcpServers/acceptance/monitoring/board），供批准面渲染。

### 3.3 路由（`server/routes/blueprints.js`，全部 owner 域）

| 路由 | 语义 |
|---|---|
| `GET /api/blueprints` | 列（清单不含 content） |
| `GET /api/blueprints/:id` | 详（owner only，他人 404） |
| `POST /api/blueprints` | 新草稿（shape 闸先行，失败照报不阻） |
| `PUT /api/blueprints/:id` | 编辑=**新草稿版**；必携 `expectVersion`，不符答 409 |
| `POST /api/blueprints/:id/validate` | 全链校验 + manifestPreview + errors |
| `POST /api/blueprints/:id/approve` | 携 expectVersion=当前版；**校验必全绿**才写批准 |
| `POST /api/blueprints/:id/cast` | 两段纪律：① status=approved 且 approved_by=本人；② 对**同一草稿**重跑校验；组 manifest+_casting，调发布客户端 |
| `POST/GET /api/blueprints/:id/trial-report` | 试跑报告落/读（执行器随 Slice 3） |

### 3.4 单测点（`scripts/test-blueprints.mjs`，注入式 mock）

四闸全走通：①对不当 expectVersion 的批准报 409；②校验不绿的批准报 422；③未批准的铸造报 409；④顺利铸造记录 `cast_pack_id`（publishClient mock 返回 `{ok:true,packId,version}`）。排入 `npm run test:unit`。

## 4. UI / Slice 2 对接要点

- 页面落在 `web/src/pages/`（加主路线 tab）；**勿动**并行在途的 `add-fleet-owner-surface`/`polish-web-surfaces` 路径——「蓝图构造间」作独立分栏，不嵌驾驶舱。
- locales：`web/src/locales/**` zh/en 双轨（`npm run check:locales` 绿）。
- 校验结果与 diff 呈现 + 批准按钮=对话级纪律（规格 D4 同款信号灯）。

## 5. 参考实现交回

我开始前已把三份原型写出（`server/routes/blueprints-db.js`、
`server/blueprint-validate.js`、`server/routes/blueprints.js`），并按「不直改 paas」要求**全量回滚**——如需直接挪作实现底稿（非权威形态），说一声，我重产出到你指定归属（仓库外路径或本文件同目录皆可）。