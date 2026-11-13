# add-external-skill-sources

## Why

壹座的技能与 MCP 货架是封闭清单：技能只有 bundled JSON、registry 单装、pack 内联三条入场通道，生态素材全靠人工审校台账（首批 ~40 条）。而 2026 年的技能生态已收敛到 SKILL.md 事实标准（agentskills.io 规范 6 字段，46 客户端采用，含 Codex/Gemini CLI/Cursor），腾讯 SkillHub 与 Smithery 两个主流市场均有免鉴权、可程序化读取的 REST 索引（本轮一手实测 200）。用户要求兼容 DeepSeek 官方 plugin market 与主流 skills market——调研定案（见 change 探索记录）：DeepSeek 无官方市场（官方索引格式仍是 proposal），真正的兼容面是**技能市场**；壹座不缺新架构，缺的是把单源 registry-bridge 泛化为多源适配器。

本 change 是三刀中的**刀一（只读）**：建源适配器层，接腾讯 SkillHub 与 Smithery 两个免鉴权源，在壹座 web 扩展市场开一个与「精选」物理分开、带完整来源标记的**外部源货架**。不含安装——安装（多文件存储、frontmatter 保留、名字归一化、知情确认）推刀二另立 change。

## What Changes

- 新增**源适配器接口**：每个外部源实现 `list(query, cursor) -> Entry[]` 与 `get(slug) -> EntryDetail` 两个函数，注册进一个源注册表；`EXTERNAL_SKILL_SOURCES` env 控制启用哪些源（默认两源全开，可整体关闭）。
- 新增两个源适配器：**腾讯 SkillHub**（`api.skillhub.cn/api/v1/search|categories|download`，免鉴权）与 **Smithery**（`api.smithery.ai/skills`，免鉴权，元数据经 gitUrl 指向 GitHub raw）。
- 新增**服务端聚合搜索端点**：一框搜多源，服务端各取前 N（默认 20）合并、按源分组返回；不承诺全量翻页。服务端缓存 TTL 1h；坏响应不清空旧快照（沿用 registry-bridge 原则），前端标注 `stale · 更新于 <时间>`。
- 壹座 web 扩展市场（`ExtensionsPage`）新增**「外部源」tab**（默认可见，不挂 flag）：搜索/分类/详情/来源三态徽章（declared / not-declared / unknown）+「未经本平台审校」标记。只读，无安装按钮。
- `ecosystem-curation` spec 加一条 delta：外部源镜像是命名的独立面，不属于 curated marketplace，其存在 SHALL NOT 改变 curated 条目的准入、排序或展示规则。

**明确不做**（本 change 边界）：安装/导入；多文件技能存储（`custom_skills` 单文件限制维持现状）；DSH 插件（npm/Cordis bundle）任何形态的接入；skills.sh（Vercel OIDC 硬墙）/ glama（API key + 数据许可条款）/ mcp.so（无 API）/ dshmarket（API 是插件更新用非目录）。

## Capabilities

### New Capabilities

- `external-skill-sources`：外部技能源的接入面——源适配器契约、聚合搜索行为、缓存与失败姿态、来源三态与未经审校标记、env 开关、只读边界（无安装路径）。

### Modified Capabilities

- `ecosystem-curation`：新增 Requirement「外部源镜像是命名的独立面，不属于 curated marketplace」——澄清自动镜像面与人工审校精选面的关系，钉死精选面准入规则不受镜像面影响。

## Impact

- **服务端**：新模块 `external-sources.js`（适配器注册表 + 两适配器 + 缓存/快照），新路由挂进 `server/routes/extensions.js`（`/api/extensions/external/*` 前缀，与现有 market 路由平行）；不触碰 `registry-bridge.js`、`db.js`、`skill-materialize.js`、pack 链路任何一行。
- **前端**：`web/src/pages/ExtensionsPage.tsx` 加 tab；新组件 `web/src/components/extensions/ExternalSourceTab.tsx`；`packages/core` 扩展 extensions-api client（只加端点，不改既有方法）。
- **配置**：`EXTERNAL_SKILL_SOURCES`（csv：`skillhub,smithery`，缺省=两源全开；空串=全关）。
- **外部依赖**：运行时对 `api.skillhub.cn` 与 `api.smithery.ai` 的出站 HTTPS。CN 节点对 smithery 的可达性未验证——上线核验任务包含从 prod 节点实测，不通则 env 关闭该源。Smithery 数据再分发条款上架前核验（glama 有显式数据许可先例，smithery 未见；来源徽章归属展示满足惯常要求）。
- **安全面**：只读货架不引入任何内容进入运行时（无 SKILL.md 落盘、无 pack 引用）；外部元数据仅作展示，渲染走既有文本通道。
