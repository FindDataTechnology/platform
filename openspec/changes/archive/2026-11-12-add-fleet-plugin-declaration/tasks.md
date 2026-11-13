## 1. 声明与校验

- [x] 1.1 `lib/pack-manifest.js` 增 `plugins[]` 形状校验（id 形态、8 项上限、重复拒绝、`version` 形态、禁包名/地址/端点）；规则集中在 `lib/pack-plugins.js`（`PLUGIN_FORBIDDEN_KEYS` / `PLUGIN_ID_RE` / `PLUGIN_VERSION_RE`），上限走 `PACK_MAX_PLUGINS` 政策值；验证：`scripts/test-pack-plugins-manifest.mjs` 15 条（正例/禁键逐键/坏 id/坏版本/重复/上限可调/清单校验器同源/发布面只查形状）
- [x] 1.2 安装面 roster 命中校验与版本断言：`installPack` 新增注入式 `pluginSupply`，无 roster ⇒ 409 `plugin-roster-unavailable`，缺料 ⇒ 409 `plugin-supply-missing` 且一次列全（`describePluginSupplyFailure` 同时给声明版本与烘入版本）；烘入版本取自安装树（`readBakedVersions`）；验证：同文件 4 条安装面用例 + 全程 `net.connect` 打桩断言零网络；路由侧 `server/routes/packs.js` 两条安装路径都已接 `resolvePluginSupply`
- [x] 1.3 发布面只查形状：`validatePackManifest` 不含任何 roster 逻辑；验证：同文件用例断言 `@nobody/not-baked-anywhere` 这类 id 通过形状校验（供给在安装面才证明）

## 2. 落地到团队实例

- [x] 2.1 `server/fleet-plugins.js` 计算应有行集合（`computeFleetPluginPlan`，按包名去重、声明团队排序稳定）交给 `dsh-profile.js` 的新写入口 `writeFleetPluginRows`；**偏离 D2 的 `origin:` 字段**：loader 行只写 `{id, name}`（未知键有装载风险），来源关系落在同目录 `fleet-plugins.json` 台账（每次重算重写，不可漂移）——已记入 design.md『偏离与理由』；验证：`scripts/test-fleet-plugins-materialize.mjs` 14 条（行形状无多余键、平台行不被碰、plan/台账稳定）
- [x] 2.2 幂等：同一声明集连落两次，补丁与台账**逐字节相同**（D3 按来源重算，不做跳过式幂等）；验证：同文件'relanding twice is byte-identical'一条（并发落地未单独用例：两条并发写同一文件的原子性依赖 `atomicWriteTextSync`，已有机制，不在本变更新增承诺）
- [x] 2.3 多退少补：`{a,b}` → `{a}` 后仅 `b` 行消失；验证：同文件用例（断言补丁 id 集合与读面一致）
- [x] 2.4 归档清理：A/B 共享时第一次归档行保留且 `fleets` 只剩 B，第二次归档行消失；归档=终态⇒不再声明，故移除不需要独立删除代码；验证：同文件用例 + `materializeFleetPlugins` 跳过 `archived` 的用例
- [x] 2.5 断网落地：落地只读模板声明 + 写两个本地文件；验证：`test-fleet-plugins-materialize.mjs` 的全部落地用例都包在 `withoutNetwork()` 里（打桩 `net.connect` 断言 0 次）——合并进 2.1-2.4 文件，不另开 `-offline` 文件（同一断言点，分开会重复）

## 3. 读面

- [x] 3.1 团队详情（驾驶舱数据源）增 `plugins[]`：`team` 来自台账 ∩ 补丁层，`deployment` 来自运行时 roster 中已启用且无团队声明的 bundle；全部每次读现算不落库；验证：`scripts/test-fleet-plugins-readface.mjs` 5 条（两来源、改补丁后立即反映、roster 关闭项不显示）
- [x] 3.2 未供给不显示：声明了但不在生效集合的 id 不出现在读面；台账之外的补丁行也不被认作团队插件；验证：同文件两条用例

## 4. 导出/导入

- [x] 4.1 导出保留声明：`exportFleetToTemplate(fleet, members, { plugins })` 原样带出（无声明则字段缺席＝与旧导出逐字节一致）；路由从来源包的已装清单取声明；验证：`scripts/test-pack-plugins-import-missing.mjs` 用例
- [x] 4.2 导入整体失败：缺料时一次列出**全部**缺失 id（`details.missing`），且发生在任何物化之前——`listInstalledPacks()` 前后逐项相同；验证：同名文件（临时 DB_PATH 起真库）

## 5. 收尾

- [x] 5.1 回归：先断言团队行已落地（前置），再跑一次 `writeLlmProfile`，断言 `pdf-kit` 与 `llm-pi-ai`/`spill-policy` 同时在场；验证：`test-fleet-plugins-materialize.mjs` 最后一条（这条第一版曾因测试自己传错入参而假通过，加了前置断言后才是真守卫）
- [x] 5.2 `openspec validate add-fleet-plugin-declaration --strict` 绿；分批全量扫新增红 = 0（与 `harden-plugin-supply-gates` 5.2 同一轮证据，逐条归因见该任务；本变更新增 4 个套件 38 条全绿：`test-pack-plugins-manifest` 15、`test-fleet-plugins-materialize` 14、`test-fleet-plugins-readface` 5、`test-pack-plugins-import-missing` 4）
- [x] 5.3 前置依赖确认：`harden-plugin-supply-gates` 的三条闸（路由独占、贡献类别/供给白名单、凭据面）已在同一工作树实现并通过验证（7 个门禁套件 64/64、现网 35 份合成零违规），本变更即建立在这三条之上（团队插件行同样过路由独占断言）；二者尚未归档，落地时按同一批提交。
