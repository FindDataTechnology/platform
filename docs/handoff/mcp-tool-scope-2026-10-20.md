# MCP 工具面治理 · 交接文档（终版）

> 日期：2026-10-20
> 状态：**两个 change 已归档**，代码与测试闭环；剩余均为生产 rollout 动作。
> - A = `pack-tool-declaration-gate` → 归档为 `openspec/changes/archive/2026-10-20-pack-tool-declaration-gate`
> - B = `full-mode-tool-scope` → 归档为 `openspec/changes/archive/2026-10-20-full-mode-tool-scope`
> 对应需求方：finddata `openspec/changes/pack-tool-declaration-backfill/`

---

## 0. 一句话结论

**A、B 的代码、测试、文档全部完成并已归档。** 生产侧只剩三件事：A 的 `warn` 观察与 `enforce` 切换、B 的 flag 打开与探针测量、facet 镜像滚动（`enforce` 的前置）。作者仓回填正在收尾（3 套试点 v2 已验，22 套后台发布中，预期 32 套全带声明）。

归档记录：
- A：`specsUpdated=true`，added 2 / modified 1 / removed 1（移除「Publish validates tool allowlists against the registry」，由新门取代）。
- B：`specsUpdated=true`，added 3 / modified 1。
- `openspec validate --all`：**166 passed, 0 failed**。

---

## 1. A（发布门）已完成并归档

### 1.1 落地内容

| 位置 | 内容 |
|---|---|
| `lib/pack-manifest.js` | 形状层接受 `fullSurface` / `fullSurfaceReason`；与 `allowTools` 互斥；标记必须为 `true`；理由非空 ≤500；理由不得脱离标记。**「两者皆无」在形状层仍合法**（安装兼容）。 |
| `lib/publish-tool-gate.js` | `namedMcpTools()` / `toolFaceErrors()` / `toolClosureErrors()`：抽取 `mcp__<server>__<tool>`；每个引用二选一；点名工具必须落在 `allowTools` 内（`fullSurface` 豁免）。 |
| `gateway/packs.js` | `collectPublishVerdict` 接入工具面门；`PACK_TOOL_FACE_GATE=off|warn|enforce`（默认 warn，逐请求读取）；enforce 400 + `toolFace: true`；warn 结构化日志。既有名字门语义不变。 |
| `web/` 详情页 | 「声明 N / 全量 M 工具」；`fullSurface` 显示理由；旧版显示「未声明」。 |
| `web/` 编辑器 | 草稿可未选工具保存；「标为全量 + 理由」开关；发布前本地预检点名 server。 |
| `scripts/preflight-pack-tool-gate.mjs` | 回填前预检（见 §3）。 |

### 1.2 测试证据

```bash
node --test scripts/test-pack-cell.mjs scripts/test-publish-tool-gate.mjs \
           scripts/test-pack-validate.mjs scripts/test-pack-marketplace.mjs
# → 60/60

npx playwright test e2e/packs.spec.js -g "discloses" --project=fast          # 1 passed
npx playwright test e2e/packs.spec.js -g "full-surface marker|resource declarations|tool allowlists" --project=fast
# → 3 passed
```

### 1.3 剩余运营项

- **5.1**：`warn` 上线观察一周，收集 `[publish-tool-face-gate] warn-only` 违规面。
- **5.2**：作者仓回填完成后切 `enforce`。**前置：facet 必须换到含本 change 的镜像**（见 §5）。

---

## 2. B（full 模式收敛）已完成并归档

### 2.1 落地内容

- **数据层**（`db.js`）：迁移 33 `user_presets.mcp_tools`；覆盖偏好 `user_preferences.toolScope.fullSurface`（JSON 数组，空数组删键，损坏读空）；预设 CRUD 接受 `mcpTools`。
- **推导**（`lib/full-mode-tool-scope.js`）：`deriveFullModeToolScope()` 并集 + 安全阀（未声明/`fullSurface`/空声明 → 该 server 不过滤，绝不产出 `{server: []}`）；`customPresetToolScope()` 声明/回落/覆盖。
- **合成**（`dsh-profile.js`）：full 分支并集；custom 分支声明/回落；pack 分支覆盖删键；`writeToolFilterPatch(scope.mcpTools)`；`FULL_MODE_TOOL_SCOPE` 默认 off（逐字节等价）。
- **API/UI**：`GET/PUT /api/mcp-tool-scope`；设置 → MCP 每 server「完整工具面」开关；自建预设编辑器工具选择器（catalog `toolList`，拒绝自由输入）。
- **guard 文案**（2.5）：拒绝信息指向 `Settings → MCP`；bridge 执行逻辑未改。

### 2.2 测试证据

```bash
node --test scripts/test-full-mode-tool-scope.mjs               # 8/8
node --test scripts/test-full-mode-tool-scope-integration.mjs  # 6/6（真实合成）
node --test <A 的 4 个套件 + focus-overlay + custom-presets + B 的 2 个>
# → 100/100
npx playwright test e2e/custom-presets.spec.js e2e/extensions.spec.js --project=fast
# → 26/26（UI 改动无回归）
E2E_PORT=3110 npx playwright test --config=playwright.full-mode.config.js
# → 3/3（独立项目名：full-mode）
```

`full-mode` 项目覆盖：双 pack 并集、覆盖开关恢复、自建预设收窄。运行需先 `npm run web:build:e2e`。

### 2.3 剩余运营项

- **5.1**：fd-prod 打开 `FULL_MODE_TOOL_SCOPE=on`（回填完成后）。
- **5.2**：`--turn-trace` 同题对比，token 差符合预期（三 pack 场景 ≥60k 降幅）。
- **5.3**：观察一周无「工具不见了」后翻默认值。
- **5.4**：数字写入 `measurements.md`。

---

## 3. 回填前预检（已跑通）

对方用容器内签发的 token 完成了一次全量预检：

```
manifests=34 servers=11 faceViolations=0 unresolved=0
11 个 server 全部 missing=-
fd-text-core 快照 15 个工具、声明 5 个，无滞后
```

**两个坑（已固化进脚本）**：
1. 环境变量必须是 `MARKET_REGISTRY_TOKEN`，不是 `REGISTRY_TOKEN`。bridge 只读前者；用错会静默 401，随后所有 server 被当成 local-binding 豁免，输出假绿 `unresolved=0`。
2. 现场签的 token 只有 10 分钟；长期方案用 M2M 凭据。

脚本已加三重防护：
- `REGISTRY_TOKEN` 有值而 `MARKET_REGISTRY_TOKEN` 为空 → 明确告警。
- `registryVerified` 标志：未成功拉取索引时，server 标 `UNVERIFIED`，不再冒充「local-binding exempt」。
- 汇总三态：`skipped (no registry URL)` / `unknown (registry NOT verified)` / 真实计数；配置了但未验证 → 退出码 1。

运行方式：

```bash
MARKET_REGISTRY_TOKEN=<fresh> REGISTRY_URL=https://mcp.finddatatech.cloud \
  node scripts/preflight-pack-tool-gate.mjs \
  ~/finddata/docs/*/pack-manifests ~/finddata/docs/xingyan/packs/pack-manifests
```

---

## 4. 关键不变量（改代码时不要破坏）

1. **覆盖 = 删键**，不是枚举全量（guard 只收窄 map 里出现的 server）。
2. **未声明 = 全量**；绝不产出 `{server: []}`。
3. **失败 open**：DB/偏好读失败 → `null`（不过滤）。
4. **只在合成时刻计算**，并集不落盘。
5. **优先级**：用户覆盖 > 聚焦 pack 的 allowTools > full 并集 > 不过滤。
6. **flag off 逐字节等价**：写出 `{ "mcpTools": {} }`。
7. **自建预设的 `mcpTools` 也受 flag 控制**（保守选择，符合 B5 的等价承诺）。

---

## 5. 生产风险与坑

| 风险 | 说明 / 处置 |
|---|---|
| **facet 是 `Recreate`，不是滚动** | `~/finddata/fd-infra-deploy/all-services/prod/facet.yaml`：`replicas: 1`、`strategy: Recreate`、`hostNetwork` 独占 3200。换镜像会先停后起，有几十秒中断。**切 `enforce` 前 facet 必须换到含本 change 的镜像**，否则旧代码跳过工具面门，enforce 在 facet 面不生效。 |
| 三清单同步 | 镜像升级需同步 `platform.yaml`、`platform-demo.yaml`、`facet.yaml`；ArgoCD hard-refresh 后核对 imageID 与 digest、`restarts=0`。 |
| 95 条引用首次进名字门 | 已由预检验证（unresolved=0）；后续新增声明仍需预检。 |
| 快照滞后 | 例：fd-text-core gov 工具。刷新走 registry `POST /api/refresh/<path>`。 |
| 老 cell 安装新 manifest | `fullSurface` 未知键被容忍；旧 cell 按全量运行（安全阀）。 |
| 作者为绕门全标 `fullSurface` | 理由必填 + 详情页展示 + 作者仓构建报告单列。 |
| e2e 前端不更新 | 改 web 后必须 `npm run web:build:e2e`。 |
| 测试语言 | `e2e/packs.spec.js` 是 zh-CN；断言用中文文案。 |
| 自建预设测试 id | API 返回 catalog id（`user.preset`），roster 用 `rosterPresetId` 转成的 `user-preset`；等待/切换要用后者。 |

---

## 6. 改动文件清单

### A
- `lib/pack-manifest.js`、`lib/publish-tool-gate.js`、`gateway/packs.js`
- `scripts/test-pack-cell.mjs`、`scripts/test-publish-tool-gate.mjs`、`scripts/test-pack-validate.mjs`
- `scripts/preflight-pack-tool-gate.mjs`（新）
- `web/src/lib/packs-api.ts`、`web/src/components/packs/PackDetailDialog.tsx`、`web/src/components/packs/PackDraftsView.tsx`
- `web/src/locales/{en,zh-CN,ja,es,fr}/common.json`
- `e2e/packs.spec.js`

### B
- `db.js`、`lib/full-mode-tool-scope.js`（新）、`dsh-profile.js`
- `scripts/test-full-mode-tool-scope.mjs`（新）、`scripts/test-full-mode-tool-scope-integration.mjs`（新）
- `server/routes/misc.js`、`server/routes/custom-presets.js`
- `web/src/lib/presets-api.ts`、`web/src/components/extensions/McpInstalledView.tsx`、`web/src/pages/CustomPresetsPage.tsx`
- `web/src/locales/{en,zh-CN,ja,es,fr}/common.json`
- `dsh-profile-template/platform-tool-scope.js`（仅拒绝文案）
- `playwright.full-mode.config.js`（新）、`e2e/full-mode-tool-scope.spec.js`（新）

---

## 7. 归档状态

| change | 归档路径 | spec 变更 |
|---|---|---|
| A | `openspec/changes/archive/2026-10-20-pack-tool-declaration-gate` | added 2 / modified 1 / removed 1 |
| B | `openspec/changes/archive/2026-10-20-full-mode-tool-scope` | added 3 / modified 1 |

`openspec validate --all` → 166 passed / 0 failed。

---

## 8. 上线状态（2026-10-20 已执行）

生产环境 fd-prod（kube context `cheap`），镜像 `sha-b7752cf` / digest `1d563371`（≙ paas `620dbadc`，
含 A+B），platform / facet / platform-demo 三个部署同镜像。

| 项 | 状态 | 证据 |
|---|---|---|
| A 发布门 | **`enforce` 已生效** | `platform-config` 的 `PACK_TOOL_FACE_GATE=enforce`，platform 与 facet 进程内 `printenv` 一致 |
| A 端到端判词 | **通过** | `/api/packs/validate`：未声明 → `toolFace: true` + 两种修法；`fullSurface`+理由 → `valid: true` |
| B full 模式并集 | **`on` 已生效** | cell `1da519d4c1c0bf89` 的 `tool-filter.json` 09:36:29 写出 `{airegistry-tools:5, facet-market-mcp:5}` |
| B 安全阀 | **按设计** | 未声明引用（`数据-股票` 等旧版本）对应 server 保持全量，无 `{server: []}` |
| 测量记录 | 已落盘 | A / B 各自归档目录下的 `measurements.md` |

**platform-demo 不在开关范围内**：它用独立的 `platform-demo-config`（没有这两个键），
所以 demo 仍是 `warn` / `off`（与改动前逐字节一致）。要一并打开就把同样的两个键加进
`platform-demo-config` 再重启 `platform-demo`。

**enforce 的暴露面**：在架 50 个带 MCP 引用的最新版里 **12 个仍无声明**（`数据-股票` v3、
`数据-中国经济` v3、两个旧 id 的柏讯包、`法律-合同`/`法律-案件`、`萬星`、5 个「物化验证」测试包）。
它们下一次发版会被 400 挡下，直到补声明或标 `fullSurface`；安装与已发布版本不受影响。

**B 的收益前置**：9 个 cell 共 41 条已装引用里 **30 条落后于最新发布版本**——回填并重发不会追溯
改变已装快照，用户升级后才吃到并集。升级完成后的估算：cell `3fdc7b8e8ac03b68` ≈60k token/轮，
cell `1da519d4c1c0bf89` ≈72k token/轮（`measurements.md` §3）。

**未做/未满**：
- A 5.1 的 `warn` 观察窗：核实生产时开关已被翻到 `enforce`（`kubectl-patch` 09:35:43Z），无 warn 日志；
  替代依据是回填前预检全绿（34 份 / 11 server / faceViolations=0 / unresolved=0）。
- B 5.2 的 `--turn-trace`：需在真实用户 cell 发两轮对话，未在他人 cell 上执行；以工具数 × 实测
  schema token 比例估算。
- B 5.3 的默认值翻转：观察窗未满一周，代码默认仍是 `off`，生产靠 env 开启。

- 回滚：A `PACK_TOOL_FACE_GATE=warn|off`；B `FULL_MODE_TOOL_SCOPE=off`（均逐请求/逐合成读取，
  改 `platform-config` 后重启 pod 生效）。
- 观察项：用户报「工具不见了」→ 先看该 cell 的 `tool-filter.json` 与已装版本；单 server 可用
  设置 → MCP 的「完整工具面」开关立即恢复。

