# 外部技能源（External Skill Sources）— 刀一 + 刀二

> openspec: `add-external-skill-sources`（刀一，只读镜像，已归档）+ `add-external-skill-install`（刀二，安装路径，2026-10-15）。
>
> **刀二一句话**：货架只读保留，但每条目多了一个「安装」入口——预览（正文摘录+文件清单+脚本高亮+许可证+上游地址）→ 知情确认（含脚本必勾）→ 装进本实例成为可被 agent 调用的技能。服务端强制确认（无 `confirm:true` 一律 400）。

## 是什么

壹座扩展市场（Settings → 工具与技能）新增**「外部源」tab**：镜像外部技能市场的条目供发现。只读——没有任何安装路径，条目元数据不落盘、不进 pack、不进物化树；每个卡片带来源徽章、许可证三态 chip（declared / not-declared / unknown）与**「未经本平台审校」**标记。

与「商店」tab 的关系见 `openspec/specs/ecosystem-curation/spec.md`（外部镜像面是命名独立面，精选面的准入/排序/展示规则逐字节不变）。

## 源适配器契约

模块：`external-sources.js`（根目录，与 registry-bridge 平行，不耦合）。

- 每源两函数：`list(query, {limit})` 搜索、`get(slug)` 详情；返回归一化 Entry。
- Entry 关键字段：`source` / `originUrl` / `licenseState`（三态）/ `version` + `versionLayer`（版本取自哪层元数据——腾讯实测同一包两层版本互相矛盾，故记录来源层不判真伪）。
- 快照缓存：键 = 请求形状；TTL ≤ 1h；坏响应保留上一份好快照并标 `stale`（沿用 registry-bridge 姿态）；首次即失败 → 该源报 failed，不造数据。
- 聚合：`Promise.allSettled` 扇出，每源 top-N（`EXTERNAL_SOURCE_PAGE_SIZE`，默认 20，上限 50），按源分组原样返回；**浏览器永不直连外部 API**。
- 出站纪律：10s 超时、无凭据、平台 UA。

### 当前源清单

| id | 市场 | 鉴权 | licenseState | 说明 |
|---|---|---|---|---|
| `skillhub` | 腾讯 SkillHub（skillhub.cn） | 免鉴权 | unknown（API 无 license 字段） | search 无游标无 total，limit 即上限 |
| `smithery` | Smithery（api.smithery.ai） | 免鉴权 | unknown（许可证在上游仓库） | gitUrl 即 originUrl；~25k 条 |

### env 开关

- `EXTERNAL_SKILL_SOURCES`：csv 启用清单；**unset/空 = 全开**；未知 id 忽略；设为不存在的 id（如 `none`）= 全关 = 货架空。
- `EXTERNAL_SOURCE_PAGE_SIZE`：每源返回条数（默认 20，上限 50）。

### 端点

- `GET /api/extensions/external/sources` — 启用源清单
- `GET /api/extensions/external/search?q=` — 聚合搜索（按源分组）
- `GET /api/extensions/external/entry/:source/:slug` — 单条详情

全部只读 GET；写动词不存在（e2e 有只读断言钉死；刀二起安装走独立端点 + 服务端确认门）。

## 刀二：安装路径（2026-10-15）

### 端点

- `GET /api/extensions/external/install-preview/:source/:slug` — 取包+解析的预览（正文摘录 ≤1500 字、文件清单含 script/omitted 标记、许可证、上游地址、归一化名）；禁用/未知源 404；取包失败 502；限额 422。
- `POST /api/extensions/external/install` — body `{source, slug, confirm}`；**`confirm !== true` → 400 且零副作用**；成功 200 `{skill, replaced}`；同名冲突 409；上游 404→502。

### 取包链路（逐源实测定案）

| 源 | 机制 | 要点 |
|---|---|---|
| SkillHub | `GET /api/v1/download?slug=` → 302 → COS zip | 手动跟重定向 ≤3 跳，**每跳 host ∈ {api.skillhub.cn, skillhub.cn, \*.myqcloud.com}**；下载体 ≤30MB |
| Smithery | gitUrl → **GitHub contents API 逐文件** | tarball 路线实测否决（单体仓 2KB 技能要 38.8MB 整包且超时）；`githubResolveDir` 逐段解析**中间符号链接**（实测 `.claude/skills` → `../.agents/skills`）、逃逸即拒；超限文件不下载、以 omitted-large 入清单；上游目录 404 → fail-closed（`frontend-design` 实证：条目在货架但上游目录已被删） |

包缓存：键 `source:package:slug`，TTL 10min、上限 5 条插入序淘汰；失败永不入缓存（重试必须重新取包）。

### 安全与治理面

- 解包统一走 `parsePackage`：路径逃逸拒绝（绝对/`..`/盘符/NUL/反斜杠）、垃圾滤除、聚合限额超限即败（辅助文件 ≤512KB/个、总量 ≤2MB、≤64 个、解包 ≤50MB、正文 ≤200k 字符）；单文件超限不失败而是不落盘 + 清单如实标注。
- 名字归一化到 dsh 文法 `^[a-z0-9]+(-[a-z0-9]+)*$`（不匹配的整条静默丢弃——归一化消除此类故障）；原始名进 origin_meta/描述保留可追溯。
- 冲突裁决：同 `(source, slug)` 重装 → 替换（同 pack `replaced` 语义）；其他来源同名 → 409 不覆盖。
- 物化：整目录树（SKILL.md + 辅助文件，陈旧文件对账删除）；前端 resource base 指向技能目录，`scripts/*.py` 相对引用真实可用。
- frontmatter 保留：上游 frontmatter 落库并在物化时重发（`whenToUse`/`user-invocable`/`disable-model-invocation`/`metadata` 全保留）；dsh 会 throw 的 camelCase 旧拼写键**双滤**（存储层+物化层）。
- 零新增依赖（jszip/js-yaml 已是直接依赖）；数据库 migration v30 三列全 nullable，旧行行为逐字节不变（升级测试直证）。

## 上线核验结论（2026-10-15，快照 `c175452` ≙ 源码 `90b7ece`；修复版快照 `09989ff` ≙ 源码 `12ced1c` 已滚产）

### 刀一（只读货架）

1. **prod 可达性 ✅**：从 cheap3 生产节点实测 `api.skillhub.cn` **HTTP 200 (0.35s)**、`api.smithery.ai` **HTTP 200 (1.11s)**——两源均可达，无需关源。
2. **Smithery 条款 ✅（含一条所有权变化）**：官方 OpenAPI 规范已发布（Stainless 托管 `openapi.documented.yml`，`/skills` 为文档化公开读端点，读操作免鉴权是设计而非疏漏）；Arcade.dev ToS（Smithery 2026 已并入 Arcade）未见公开目录元数据的再分发禁令，「Unauthorized sharing or reselling」条款指服务本身。**本次依赖的合规底线 = 只读展示元数据 + 来源归属（originUrl 外链）**，已满足。⚠️ **所有权变更记风险**：API 若未来收敛为需 key，快照 stale 姿态 + `EXTERNAL_SKILL_SOURCES` 关源开关即为降级路径。
3. **关源演练 ✅**：生产容器内实测三态——默认两源、`skillhub` 单源（smithery 不再请求）、`none` 全关（空清单），searchAll 分组与 `isEnabled` 均按语义行为。
4. **生产数据通路 ✅**：生产容器内直跑适配器打真实上游，双源各返回 3 条归一化条目（licenseState=unknown 正确、originUrl 真实）；生产前端懒加载 chunk（`ExtensionsPage-UlDl3Pu8.js`）含 `extensions-tab-external` / `external-source-shelf` / `external-group` 全部本 change 标记。
5. **UI 眼见 ✅（登录后生产实证，2026-10-15）**：`scripts/verify-live-external-sources.mjs` 以 .env 测试账号走真 Logto 登录链（平台 /login 是壳 → `sso-login` 跳 auth 域英文两步表单 → 回跳），在生产域名开 `extensions-tab-external`、对两上游市场跑真搜索（`pdf`）、进详情弹窗，**10/10 ALL PASS**：无 flag 下 tab 可见 / 两源分组渲染（腾讯 SkillHub 20 entries + Smithery）/ 许可证三态 chip + 「未经本平台审校」标 / 货架零安装按钮 / 详情弹窗（Pdf 条目 + 「Open upstream page」外链）/ search API 200 且 `groups=[skillhub, smithery]`。真回合外两源均返回生产数据。截图 `/tmp/external-shelf-prod.png`（画面中白卡 = 详情弹窗本身，非登录页——innerText dump 实证）。
6. **真缺陷修复（上面眼见带出）✅**：Escape 关详情弹窗时若详情 fetch 仍在途，晚到的 `setDetail` 会把弹窗弹回（生产探针实证：Escape→hidden 后 dialog count 仍 = 1）。修 = `ExternalSourceTab` 详情请求加 seq 失效门（close 使在途请求作废，`7d89a91`）；e2e 新回归用例先红后绿（延迟路由 + Escape → 弹窗必须保持关闭），external-sources 5/5、extensions 20/20、typecheck/lint 全绿。
7. **修复已滚产并复验 ✅（2026-10-15）**：快照 `09989ff`（≙ 源码 `12ced1c`，含本修复）→ GHA 绿 → 镜像回灌后部署侧 digest 全等 → GitOps `ce56697` 五清单（platform/platform-demo/facet/agent-runner-b/c；serving 留 `sha-73f64eb`）全 rollout。复验：pod 在产 digest 与构建侧一致；探针加强版（新增「Escape 关后等 12s 弹窗不再现」断言）**12/12 ALL PASS**，`at-screenshot detail dialog count: 0`（修复前为 1）；demo `/api/ready` = `{"ready":true}`。

### 刀二（安装路径，2026-10-15 滚产 sha-2d1b725）

8. **出片 ✅**：`fd-build-channel` 判路 = 公开仓免费线（私有池已耗尽）→ `make-public-snapshot --init` 裁快照 → 强推公开镜像仓 → **补出片 workflow 恢复提交（该提交 sha 即镜像 tag）**触发出片。镜像 `sha-2d1b725`（增量源码 `b781476`，1.41GB）；`gh run watch` 绿；镜像回灌 `OK (4s)`；**部署侧与构建侧 skopeo digest `sha256:986fcb4d…` 全等**（bump 硬门）。
9. **滚产 ✅**：GitOps `4d58016` 五清单（platform/platform-demo/facet/agent-runner-b/c；serving 不动留 `sha-f9a9547`）→ ArgoCD hard refresh → 五 rollout 全绿；pod imageID `986fcb4d…` 在产五份；platform `/healthz`=`{"ok":true,"cells":3}`、demo `/api/ready`=`{"ready":true}`，0 restart。
10. **生产真装验收 ✅（23/23 ALL PASS，`verify-live-external-sources.mjs` 扩展版）**：真 Logto 登录 → 货架真搜索 `pdf` → 详情弹窗 → **安装按钮出现** → 预览面板出（文件清单 + 脚本标记 + 「未经本平台审校」）→ **脚本包的确认按钮在勾选前 disabled** → 勾选 → 确认 → 成功态（`document-pdf`）→ 已装列表出现该卡 → 卸载清理。全链 API 200：preview/install/skills 三条都在案。
11. **pod 内物化实证 ✅（KEEP_INSTALLED 留装时）**：`<cell>/data/custom-skills/document-pdf/` = `SKILL.md` + **8 个 `scripts/*.py`** + `forms.md`/`reference.md`/`LICENSE.txt`/`_meta.json`（共 12 辅助文件）——多文件目录树成立，dsh resource base 指向该目录，`scripts/x.py` 相对引用可用；物化的 SKILL.md 头保留上游 `license` 字段（name/description 由平台行覆盖）；DB 行 `origin_meta` = `{kind:external, source:skillhub, slug, originUrl, upstreamName}`，`frontmatter` 含 `license`。卸载后目录随 `removeSkill` 整树消失（清理实证）。
12. **探针两修（生产跑出的真坑）**：① 已装技能列表在 `/settings/skills`，`/settings/mcp` 的已装 tab 只列 MCP 服务器——首跑「已装列表」FAIL 是探针走错页，不是功能缺陷（已改判并注释在案）；② 加 `KEEP_INSTALLED` 开关，否则卸载会清掉 pod 内查验窗口。
13. **3.4 缺口修复（滚产前自查带出）**：spec 要求「list 端点暴露辅助文件清单与来源」，实现里 `GET /api/extensions/skills` 的映射**漏了** `files`/`originMeta` 两键（`b781476` 补上 + 端点测试钉死：多文件行暴露路径数组、旧行两键 null）。**教训=spec 与实现之间的断言必须落到端点级，否则缺口静默。**

## 证据链（探索底稿，2026-10-14 四路调研 + 20 项亲手核验）

- **DeepSeek 无官方插件市场**：官方索引格式仅 proposal（`.agents/notes/proposed/.../2026-10-02-plugin-market-index-format.md`，原文 "No official market exists"）；客户端插件页只有安装无浏览；社区市场 awesome-dsh-plugin 索引真身在 GitHub 仓 `data/plugins/*.yml`（站点 plugins.json 传输截断不可依赖）。→ dsh 插件生态本 change 明确不接（宿主全权限代码，与 pack v1 边界、`dsh-adapter-boundary` allowlist 双冲突）。
- **SKILL.md 是事实标准**：agentskills.io 规范 6 字段，46 客户端（含 Codex/Gemini CLI/Cursor/Copilot）；腾讯 SkillHub 官方文档自述遵循同规范；实测腾讯包解包 = `SKILL.md + scripts/ + _meta.json` 多文件结构（刀二存储升格的直接动因）。
- **skills.sh 排除**：Vercel OIDC 硬墙（401 + docs 原文确认）；glama 需 API key + 数据许可条款；mcp.so 无 API（robots 禁）。
- **注入面**：刀一为零（无落盘）；刀二引入落盘后由**知情确认 + 服务端强制 confirm + 脚本不自动执行 + 未审校标全程在**治理（正文进系统提示词的注入风险不可消除，只能让用户知情）。
- **取包策略改判实证（刀二实施中）**：Smithery 整仓 tarball 在单体仓不可用——slug `commit` 命中 NVIDIA-NeMo/DataDesigner，**2KB 技能要拉 38.8MB 整包且 15s 超时**；codeload 无子树端点 → 改 GitHub contents API 逐文件取。另测出目录中间段可是**符号链接**（`.claude/skills` → `../.agents/skills`，裸 GET 全路径 404），故逐段解析；条目 `frontend-design` 的 gitUrl 目录上游已被删（404）→ fail-closed 是必需而非防御姿态。
