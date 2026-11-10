# MCP 工具面治理 · paas 侧需求书

> 交付对象：paas 实施者。本文是两份 OpenSpec change 的合并需求视图：
> `openspec/changes/pack-tool-declaration-gate/` 与 `openspec/changes/full-mode-tool-scope/`。
> 两者的 spec delta 是权威契约；本文补充实现锚点、数据形状、验收口径与排期。
> 作者侧（34 个 pack 的回填与重发）不在本文范围，见 finddata 仓
> `openspec/changes/pack-tool-declaration-backfill/`。

---

## 1. 问题

pack 对 MCP 的引用粒度是**整个 server**。运行时只在「选中 pack 角色」（聚焦模式）时写工具过滤器，
且只有 manifest 声明了 `allowTools` 才会收窄；full 模式与自建预设一律不过滤。

现状实测（本机用各 server 仓的真 `FastMCP.list_tools()` 抓 schema，cl100k 分词）：

| server | 工具数 | schema token |
|---|---:|---:|
| fd-quant | 50 | 48,818 |
| fd-daas-mcp | 161（线上） | ~33,400 |
| fd-open-data-mcp | 71 | 19,795 |
| fd-find-data-business-mcp | 32 | ~16,700 |
| fd-cn-report | 44 | 10,114 |
| fd-paper-trading | 19 | ~6,400 |
| fd-legal-search-mcp | 10 | ~3,600 |

套到具体 pack（「用到」= 技能正文里 `mcp__server__tool` 实际点名的工具）：

| pack | 引用 server | 现在挂 | 实际用到 | 现在 token | 声明后 token |
|---|---|---:|---:|---:|---:|
| wire-ic-debate | 3 | 255 | 11 | ~92,300 | ~7,000 |
| data-macro-analysis | 4 | 308 | 20 | ~79,000 | ~7,500 |
| lex-civil-nine-step | 2 | 42 | 8 | ~20,300 | ~3,200 |
| wire-equity-research | 5 | 358 | 75 | ~128,800 | ~41,400 |

一个装了 3 个 wire pack 的 cell，日常 full 模式对话在说第一句话之前就背约 **139k token** 的 schema。

**结论**：执行层（guard / register-shadow / restrict）已经建好且有测试，缺的是两件事——
发布时不强制声明（`pack-tool-declaration-gate`），以及 full 模式不消费声明（`full-mode-tool-scope`）。

---

## 2. 范围

| 编号 | 交付物 | 对应 change | 优先级 |
|---|---|---|---|
| A | 发布门：每个 MCP 引用必须显式声明工具面，并做工具级闭包 | `pack-tool-declaration-gate` | P0（B 的前置） |
| B | full 模式按「已装 pack 的声明并集」过滤；自建预设支持工具维度 | `full-mode-tool-scope` | P0 |

**非目标**

- 不改 `dsh-profile-template/platform-tool-scope.js`（bridge 已在所有模式读取 `tool-filter.json`）。
- 不改 registry / 网关：过滤是客户端关注点，registry 侧虚拟端点覆盖不了用户自部署的 MCP。
- 不做渐进披露（延迟注册 + tool_invoke）。声明方案已拿走 70–92% 的收益，剩下的尾差靠 server 侧 schema 瘦身。
- 不在 install 时拒绝「无声明」的旧版本（见 A1 的兼容边界）。

---

## 3. 代码地图（现状锚点）

| 位置 | 作用 |
|---|---|
| `lib/pack-manifest.js:356` `validatePackManifest` | shape 校验；发布端与安装端共用 |
| `lib/pack-manifest.js:479` | `allowTools` 形状校验（非空、≤64、`[A-Za-z0-9._-]{1,128}`、去重） |
| `lib/pack-manifest.js:213` `effectiveMcpTools` | pack 级 ∩ 角色级，唯一的声明推导函数 |
| `lib/pack-manifest.js:72` | `PACK_LIMITS.maxToolsPerMcp = 64` |
| `lib/publish-tool-gate.js` | 既有名字校验：快照对拍 + 实时探测兜底 + commercial 闭合 |
| `gateway/packs.js:41` `declaresTools` | **漏洞所在**：无声明时整段 gate 被跳过 |
| `gateway/packs.js:127` | `if (declaresTools(manifest))` 调用点 |
| `pack-store.js:97` `installMcpRef` | 装包时把 server 写入全局 `extension_configs` |
| `pack-store.js:160` | 安装路径的 shape 校验（不得加发布门） |
| `dsh-profile.js:805` `writeMcpPatch` | 合成：mcp.json → DB → 凭据 → overlay → focus → 写 filter |
| `dsh-profile.js:961` | `writeToolFilterPatch(scope.source === "pack" ? scope.mcpTools : null)` |
| `dsh-profile.js:1012` `writeToolFilterPatch` | 物化 `tool-filter.json` + 复制 bridge |
| `dsh-profile.js:1255` `deriveScope` | 三种预设族的 scope 推导；custom 分支硬编码 `mcpTools: null` |
| `dsh-profile-template/platform-tool-scope.js` | 运行时执行：guard + register-shadow + restrict（**不改**） |
| `db.js:1329/1338` `setPreference/getPreference` | 键值偏好存储 |
| `db.js:1365` `getFocusOverlay` | 既有 per-preset overlay（add/removeMcp） |
| `db.js:2395` `createUserPreset` | 自建预设行（`skills` / `mcp_servers` 两个 JSON 列） |
| `registry-bridge.js:173-179` | catalog 已携带 `toolList`（名字）+ `toolDetails` |
| `web/src/components/packs/PackDraftsView.tsx:185` | 编辑器已能读写 `allowTools` |
| `web/src/components/packs/PackDetailDialog.tsx` | 详情页（披露落点） |
| `scripts/probe-pack-scope.mjs` | 验收探针：full/focused roster + `--turn-trace` token 差 |

---

## 4. 需求 A：发布门（`pack-tool-declaration-gate`）

### A1 manifest 形状

`mcpServers[]` 新增两个可选键，与 `allowTools` **互斥**：

```jsonc
{
  "registryName": "law-bench",
  "requiredGroup": "analysts",
  // 二选一：
  "allowTools": ["clause_assemble", "clause_review"],   // 非空、≤64
  // 或
  "fullSurface": true,
  "fullSurfaceReason": "工具经 tool_search 间接选择，无法静态枚举"  // 非空
}
```

**兼容边界（关键）**：`validatePackManifest` 是发布端与安装端共用的。
「无声明」必须在 **shape 层继续合法**，否则存量已发布版本在安装时会被自己的校验器拒掉。
门只在发布路径执行。

- 两者并存 → shape 层拒绝，点名冲突字段。
- `fullSurface: true` 但理由为空/缺失 → shape 层拒绝。
- 理由长度上限沿用 `notes` 的做法（建议 ≤500 字符）。

### A2 发布门

`gateway/packs.js` 的 gate 组合里新增一段，**无条件执行**（不再受 `declaresTools` 门控）：

- 每个 `mcpServers[]` 引用必须有非空 `allowTools` 或 `fullSurface: true` + 理由。
- 错误：400，点名 pack、server、两种修法（补声明 / 标全量 + 理由）。
- 环境开关 `PACK_TOOL_FACE_GATE=off|warn|enforce`，默认 `warn`：warn 下记录结构化日志但放行，enforce 下拒绝。
- 既有 `declaresTools` 门控的**名字校验**保留原样：只对声明了名字的引用做快照/探测/commercial 检查。

### A3 工具级闭包

从 pack 的 `skills[].content` 抽取 `mcp__<server>__<tool>`，断言 `<tool>` ∈ 该引用的 `allowTools`。
`fullSurface` 引用豁免。失败点名 server + tool + 引用它的技能。

- 复用 `lib/publish-tool-gate.js` 已有的抽取/归一逻辑，不要另写一套正则。
- 这条是「声明不会落后于技能正文」的保证：技能改名工具而忘了改声明 → 发布失败。

### A4 详情页披露

`PackDetailDialog.tsx` 对每个 MCP 引用渲染实际挂载的工具面：

- 有 `allowTools`：`声明 6 / 全量 161 工具`（总数来自 catalog 的 `toolList`）。
- `fullSurface`：`全量 161 工具` + 作者理由。
- 旧版本（两者皆无）：`全量 161 工具（未声明）`，页面正常渲染。

数据只来自版本 manifest + catalog，**不发实时探测**（server 暂时 401 不应让详情页失败）。

### A5 编辑器

`PackDraftsView.tsx`：

- 草稿允许「未选工具」保存（否则中途保存失败）。
- 未选工具时提供「标为全量 + 填理由」的显式控件。
- 发布前本地预检复用同一规则，缺口就地提示到具体 server。

### A6 验收

- [ ] 无声明无标记的引用 → 发布 400，错误含两种修法。
- [ ] 只 `fullSurface` + 理由 → 发布成功；理由在详情页可见。
- [ ] 两者并存 → shape 层 400。
- [ ] 点名工具不在声明内 → 发布 400，错误点名工具与技能。
- [ ] `fullSurface` 引用上的点名工具不触发闭包失败。
- [ ] 既有名字校验用例（快照滞后探测兜底 / UNRESOLVED / commercial 闭合 / 本地绑定豁免）全绿。
- [ ] 一份回填前的旧 manifest 仍可安装（install 路径不受门影响）。
- [ ] `warn` 模式：违规发布成功且留下结构化日志。

---

## 5. 需求 B：full 模式收敛（`full-mode-tool-scope`）

### B1 并集推导

新增纯函数（建议 `dsh-profile.js` 内或 `lib/` 下）：

```js
// installedPacks: [{ manifest }]，来自 db.getInstalledPacks()
// 返回 { server: [leaf...] }，未列出的 server = 不过滤；全部不过滤时返回 null
function deriveFullModeToolScope(installedPacks, fullSurfaceServers = []) {
  const byServer = new Map(); // server -> Set | FULL
  for (const p of installedPacks) {
    for (const ref of p.manifest?.mcpServers ?? []) {
      const s = ref?.registryName;
      if (typeof s !== "string") continue;
      if (ref.fullSurface === true || !Array.isArray(ref.allowTools)) {
        byServer.set(s, "FULL");            // 安全阀，见 B2
      } else if (byServer.get(s) !== "FULL") {
        const set = byServer.get(s) ?? new Set();
        for (const t of ref.allowTools) set.add(t);
        byServer.set(s, set);
      }
    }
  }
  for (const s of fullSurfaceServers) byServer.set(s, "FULL");  // 用户覆盖
  const out = {};
  for (const [s, v] of byServer) if (v !== "FULL") out[s] = [...v];
  return Object.keys(out).length ? out : null;
}
```

**只在合成时刻计算**（启动 / 切预设 / MCP 或 skill 配置变化），不落盘为独立状态——与既有 focus 推导同一纪律。

### B2 安全阀（必须实现，必须有单测）

以下任一情况，该 server 的并集结果必须是「不过滤」，**绝不能是空数组**：

- 引用没有 `allowTools`（回填未完成 / 旧版本）；
- 引用标了 `fullSurface`；
- 该 server 被任何一份旧 manifest 引用。

`{server: []}` 会让 161 个工具全部消失。单测里显式断言这个形状不出现。

### B3 每 server 全量覆盖

- 存储：`user_preferences` 键 `toolScope.fullSurface`，值为 server 名数组；空数组即删键。复用 `getPreference/setPreference`。
- 为什么不放 `extension_configs.permissions`：那一列语义是「扩展能调用哪些内置工具」，与本需求不同。
- 为什么不放 focus overlay：overlay 是 per-preset 的，而覆盖是全局偏好（full 与聚焦都生效）。
- 优先级：**覆盖 > 聚焦 pack 的 allowTools > full 模式并集 > 不过滤**。
- API：`GET/PUT /api/mcp-tool-scope`，body `{ fullSurface: ["fd-daas-mcp"] }`，鉴权与序列化变更路径沿用现有设置路由。
- UI：设置 → MCP，每 server 一个「完整工具面」开关。

### B4 自建预设工具维度

- `user_presets` 新增列 `mcp_tools TEXT DEFAULT '{}'`（JSON：`{server: [leaf...]}`），与 `mcp_servers` 并列。
- `createUserPreset/updateUserPreset` 接受并持久化 `mcpTools`。
- `deriveScope` 的 custom 分支读取它；**缺省时回落 full 模式的并集**，不再是 `null`。
- 编辑器工具选择器复用 pack 编辑器的 catalog `toolList` 来源，拒绝自由输入。
- 覆盖标记压过预设的收窄。

### B5 灰度

`FULL_MODE_TOOL_SCOPE=off|on`，默认 `off`：off 时 `writeToolFilterPatch(null)`，与今天逐字节一致。
回填完成后在 fd-prod 打开，观察一周再翻转默认值。

### B6 验收

- [ ] 两个 pack 引用同一 server（6 / 9 个工具）→ full 模式 filter 为 15 个工具的并集。
- [ ] 无 pack 引用 → 该 server 完整面。
- [ ] 任一引用无声明 / 标 fullSurface → 该 server 完整面（安全阀）。
- [ ] 卸载最后一个引用 pack → 该 server 从 filter 中消失。
- [ ] 无已装 pack → filter 为 `null`。
- [ ] 覆盖开关打开 → 该 server 在 full 与聚焦两种模式下都是完整面；关闭后恢复。
- [ ] 自建预设未声明 → 继承并集；声明 → 精确集合；覆盖 → 完整面。
- [ ] 开关 off 时合成结果与改动前逐字节一致（fixture 对拍）。
- [ ] `probe-pack-scope.mjs`：full 模式工具数下降，`--turn-trace` token 差符合预期。

---

## 6. 数据契约汇总

```jsonc
// 1) manifest（发布与安装共用的形状）
"mcpServers": [{
  "registryName": "fd-quant",
  "requiredGroup": "analysts",
  "allowTools": ["compute_sma", "summarize_drawdown"],  // 与下面互斥
  "fullSurface": true,                                   // 与 allowTools 互斥
  "fullSurfaceReason": "…"
}]

// 2) 物化给运行时的过滤器（形状不变）
{ "mcpTools": { "fd-quant": ["compute_sma", "summarize_drawdown"] } }

// 3) 用户覆盖（user_preferences）
key: "toolScope.fullSurface"
value: ["fd-daas-mcp"]

// 4) 自建预设（user_presets.mcp_tools）
{ "fd-open-data-mcp": ["read_series", "data_stats"] }
```

---

## 7. 测试矩阵

| 层 | 用例 |
|---|---|
| 单测 | `deriveFullModeToolScope` 六种输入（并集/单 pack/无声明/fullSurface/空/覆盖） |
| 单测 | 安全阀：`[{allowTools: undefined}]` 不得产出 `{server: []}` |
| 单测 | 优先级：覆盖 > 聚焦声明 > 并集 > 不过滤 |
| 单测 | 开关 off 的逐字节等价（fixture 对拍） |
| 集成 | 装两个 pack → filter 为并集 → 卸一个 → 收窄 → 卸最后一个 → 键消失 |
| 集成 | 自建预设 mcpTools 往返 + 缺省回落 |
| e2e | full 模式 roster 收窄；覆盖开关恢复；预设编辑器拒绝未在册名字 |
| 发布 | A6 的 8 条 |
| 安装 | 回填前的旧 manifest 仍可安装 |
| 详情 | 三种渲染分支（声明 / 全量+理由 / 未声明） |

---

## 8. 顺序与依赖

```
A1 shape（接受 fullSurface）  ──> A2/A3 发布门（warn）  ──> A6 验收
        │
        └──> 作者仓回填与重发（finddata，不在本文）──> A2 切 enforce
                                                        │
B1/B2 并集 + 安全阀（flag off）──> B3/B4 覆盖与自建预设 ──> B5 在 fd-prod 打开 ──> 翻转默认
```

- A1 必须先上，否则带 `fullSurface` 的 manifest 会被 shape 层拒。
- A2 以 `warn` 上线，给作者仓留出回填窗口；回填完成后切 `enforce`。
- B 的并集依赖声明存在，所以 B5 打开必须在回填之后；但代码可以先行、flag 关闭。

---

## 9. 风险与回滚

| 风险 | 处置 |
|---|---|
| 把门错放进 shape 校验 → 存量 pack 装不上 | A1 的兼容边界 + 一条 install 兼容性测试 |
| 并集算出空集 → 工具面消失 | B2 安全阀 + 显式单测 |
| 作者为绕门全标 fullSurface | 理由必填 + 详情页展示 + 构建报告单列全量引用 |
| 并集随装包变化导致 prompt cache 失效 | 只在合成时刻变化，不是每轮；可接受 |
| 详情页因 server 不可达渲染失败 | 只用版本快照 + catalog，不发实时探测 |
| 回滚 | A：`PACK_TOOL_FACE_GATE=off`；B：`FULL_MODE_TOOL_SCOPE=off`。新列与新键对旧版本是惰性数据 |

---

## 10. 完成定义

1. 上述测试矩阵全绿。
2. `probe-pack-scope.mjs` 在 fd-prod 上给出前后对比：`wire-ic-debate` 的 focused roster 从 255 降到 ~11，full 模式在装了 3 个 wire pack 的 cell 上 token 降幅 ≥60k。
3. 数字写入各自 change 的 `measurements.md`。
