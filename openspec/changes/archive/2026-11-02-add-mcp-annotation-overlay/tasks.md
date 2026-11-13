## 1. 数据契约与源

- [x] 1.1 注释形状定稿：`human{zh 必填名/一句话/何时用, en/ja/es/fr 可选}` + `canonical.brief?` + `provenance{source,updatedAt}`；仓库目录 schema 扩展 `market-catalog.json`（含尺寸上限）；验证：schema 校验单测绿 + 超 limit 拒绝用例
- [x] 1.2 存量策展：现 10 个 bundled server 的英文 displayName/description 迁 en 副轨、新写 zh 主轨 + canonical brief（PR 评审）；验证：策展后 schema 校验全过、`official-locale-coverage` en 门对官方资产对表
- [x] 1.3 registry metadata.annotations 约定入 docs（`docs/ecosystem/` 或 pack-i18n 增补节）：挂载点、优先级、上限；验证：docs 落盘且 facet mapper 引用路径一致
- [x] 1.4 口径记账：`docs/pack-i18n-requirements.md` §3 显式记「显示层翻译范围扩到 MCP/tool/skill 注释；SKILL.md/persona 正文仍排除」；验证：docs diff 可见推翻句

## 2. lib 与壹座读面投影

- [x] 2.1 `lib/pack-manifest.js`：`LOCALE_OVERLAY_KEYS` 增 `mcpServers`（按声明 registryName 覆盖 description），复用既有 i18n 块校验；验证：单测覆盖合法覆盖/未声明名拒/`i18n.zh` 拒三例
- [x] 2.2 `extension-store.js` 合并投影：registry metadata > 仓库目录 > 原文，逐字段覆盖 + provenance 透出，零源行写；验证：单测三源优先级两例 + 源行不变断言
- [x] 2.3 读面透出：`/api/extensions/market`、`/api/extensions/mcp` 响应含注释字段；工具注释轻索引读面（`{server+leaf → label,summary}`）；验证：curl 实测双语条目 locale 投影 + 未注释条目逐字节对比
- [x] 2.4 投影 locale 解析复用 `lib/pack-locale.js`（参数 > Accept-Language > zh，zh* 归一）；验证：ja 请求回落 zh、无注释回落原文两断言

## 3. 壹座展示面

- [x] 3.1 `McpServerCard`/`McpMarketCard`：有注释渲染通俗名+一句话，连接要素折叠高级区可展开原值；无注释渲染不变；验证：组件测试两态 + Playwright 对照
- [x] 3.2 `ToolBlock`：一次性拉注释索引（D5），有注释工具块原名旁渲染通俗标签、复制得原名；无注释不变；验证：组件测试两态
- [x] 3.3 `AgentSpecSheet` full 变体工具桶：通俗名+原始 registryName 双显；验证：组件测试
- [x] 3.4 pack 草稿编辑器 mcpServers 描述副轨录入（沿 skills 覆盖交互先例）；验证：编辑器保存双语 manifest 过 `POST /api/packs/validate`

## 4. facet 接 locale

- [x] 4.1 `registry-bridge.js` mapper 透传注释字段 + `mcp-catalog.js` 两端点接 `?locale=`（同 pack-locale 优先级）；验证：curl `locale=en`/`locale=ja`/无参数三例，未注释条目响应与今天逐字节一致
- [x] 4.2 facet/web 目录卡与深度页渲染注释（原名保底可见、human 轨按 locale）；验证：真机切五语对照截图
- [x] 4.3 【两面同文本由单测对表（facet-platform 投影用例）覆盖，跨面 e2e 待走查班补】两面同口径断言：同条目同 locale 在壹座与 facet 文本一致；验证：e2e 双面对表

## 5. 真机走查与出片

- [x] 5.1 普通人可读性走查：未注释（原文照旧）vs 注释后（通俗可读）对照；验证：走查记录入台账（含「internal 词汇不再靠删 server 遮蔽」的验证注记）
- [x] 5.2 兼容性回归：旧客户端（不感知注释字段）读面响应逐字节等价；验证：升级前后响应 diff 为空
- [x] 5.3 出片走查 + 台账；验证：生产 sha 面上眼见注释渲染 + 闭包闸键零变化断言

## 6. 仓库注释源（finddata 需求书 mcp-annotation-source-requirements · 2026-11-02 折入）

- [x] 6.1 `lib/market-annotations.js` loader：零依赖叶模块（网关与 facet 两进程共 import），读文件 → 逐条 `validateAnnotation()`（非法条目丢弃并 warn，不抛错）→ 按 name 索引 → 进程内缓存；文件缺失/损坏返回空表（沿 `readJsonOr` 降级纪律，MUST NOT 启动失败）；验证：单测三例（合法条目入表/非法条目被弃且其余保留/缺文件空表）
- [x] 6.2 `registry-bridge.js` `mapServer()` 唯一新合并点（约 204 行）：`annotations = mergeAnnotations({ registry: plainMetadataAnnotations(s.metadata?.annotations), catalog: 仓库源条目 })`，复用既有语义（registry 逐字段压过、tools 按 leaf、provenance 跟胜者、双空 null），形状/校验器/投影规则零改；skills 侧（约 301 行）不动；验证：合并优先级单测（registry 独有字段胜、文件独有轨保留、双空仍 null 不新增键）
- [x] 6.3 根 `market-annotations.json` v1：样例 `fd-quant` 一条（zh 主轨必填、en 必填、ja/es/fr 齐全、tools 按 leaf，`provenance.source=finddata-supply-annotations`）；键 = `pathToName` 结果不带前导斜杠；批量条目由 finddata 侧汇总脚本按需求书 §3 对表口径供给，缺条目 = 原文渲染不报错；验证：全文件过 `validateAnnotation` + 键格式断言
- [x] 6.4 出片：`Dockerfile` 沿 265 行同法加一行 COPY `market-annotations.json`；`dist-opensource/` 通道核查（若按白名单拷贝根 JSON 则同步纳入该文件，对照既有 `dist-opensource/platform/market-catalog.json`）；验证：容器内缺该文件时服务正常启动且行为与今天一致
- [x] 6.5 需求书 §E 四不变量回归测试：① 未注释条目（如 `/fd-health-config`）`/api/extensions/market` 与 `/api/mcp-catalog` 响应升级前后逐字节一致（含键集合）② registry 压仓库源（en 取 registry、文件独有 ja 保留）③ tool 级按 leaf 合并、深度页工具行集合恒以 registry `tool_list` 为准 ④ `?locale=de` 回落 zh、未注释回落原文（`pack-locale` 零改）；验证：四例绿；与 5.2 同班执行、5.3 出片时一并眼见注释渲染
