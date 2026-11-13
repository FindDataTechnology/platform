# add-external-skill-install — Design

## Context

刀二实施前的一手核实（本机实测 2026-10-15，全部命令与响应在案）：

**上游取包形状**
- SkillHub：`GET api.skillhub.cn/api/v1/download?slug=` → **302** → `skillhub-….cos.accelerate.myqcloud.com/skills/<id>/<slug>/<ver>.zip`。实测下载 `pdf-image-text-extractor`：zip 8 文件 = `SKILL.md`(15KB) + `scripts/*.py`×4 + `README{,.en}.md` + `_meta.json`；frontmatter 与 `_meta.json` 版本再次互相矛盾（2.1.0 vs 1.0.13，刀一 `versionLayer` 记录的形态复现）。
- Smithery：条目 `gitUrl` = `https://github.com/<owner>/<repo>/tree/<ref>/<path>`。**取包策略实施中改判**（两轮实测）：① 整仓 tarball 在单体仓不可用——slug `commit` 命中 NVIDIA-NeMo/DataDesigner（Monorepo），拉 2KB 技能要 38.8MB 整包，15s 超时；② 改 **GitHub contents API 逐文件取**（大小先于字节可知，限额无需搬字节即可执行）。实测两个真实形状：目录路径**中间段是符号链接**（`.claude/skills` → `../.agents/skills`，裸 GET 全路径 404，需逐段解析）；**失效实证**：`frontend-design`（mitsuhiko）的 `tree/main/skills/frontend-design` 已 404——仓库还在，**目录没了**；同仓 `skills/commit` 正常。→ 取包必须 fail-closed，不能相信列表快照里的 gitUrl 永真。

**运行端消费形状（node_modules 源码级核实）**
- skill 名文法 = `^[a-z0-9]+(-[a-z0-9]+)*$`（`dsh-skill` `isSkillName`）；不匹配 → `skill file … ignored: invalid skill name`，**整条静默丢弃**。
- frontmatter 消费面：`whenToUse` 进 SkillEntry；`parseInvocationPolicy` 读 `user-invocable` / `disable-model-invocation`，且**对 camelCase 旧拼写直接 throw**（`frontmatter field "userInvocable" is unsupported` → 文件被忽略）；`metadata` 对象保留。
- resource base：filesystem provider 对目录形态技能下发 `resourceBase {kind:"directory", path}` → 模型提示词里是 "Base directory for this skill: <dir>"，`scripts/x.py` 相对引用**真实可用**（多文件存储升格的意义所在）。
- 现状物化器 `renderSkillMd` 只重建 `name+description` 两字段，其余 frontmatter 全丢。

**平台现状**
- `custom_skills` 表（v29）：`id,name,description,content,enabled,origin_pack_id,origin_pack_version,created_at,updated_at`；单文件物化 `<root>/<safeDir(name)>/SKILL.md`，`removeSkill` 已是整目录 rm。
- 既有自定义技能写入端点（POST/PUT/DELETE `/api/extensions/skills`）的门 = `db.isDbReady()` + 会话鉴权（**没有** `requireMcpManage`，与 MCP 端点不同）。
- `jszip` 与 `js-yaml` 已是直接依赖。实施中曾显式加过 `tar@6.2.1`（tarball 路线所需），随取包策略改判（contents API）**整体回退**——最终**零新增依赖**。
- 外部源路由读取姿态 = 登录用户可读（沿 market catalog GET）。

## Goals / Non-Goals

**Goals:**
- 两源各一条**实测成立**的取包链路，失败一律显式报错、零残留。
- 多文件包端到端（取包 → 安全解包 → 入库 → 物化目录树 → dsh 可相对引用）。
- frontmatter 保留（不含 dsh 会 throw 的旧拼写键）。
- 名字归一化，消除「静默丢弃」类故障。
- 知情确认**在服务端强制**（无 confirm 字段 = 400，不依赖前端饰面）。
- 旧数据零迁移：新列全 nullable，旧行行为逐字节不变。

**Non-Goals:**
- 外部技能自动更新/版本跟随；依赖（pip/npm）自动安装；license 门；dsh 插件（npm bundle）安装；Smithery 私有/gated 条目（只见公开 gitUrl 条目）。
- 加固既有 `/api/extensions/skills` 的门（刀二沿用其姿态，不扩大变更面）。

## Decisions

**D1 — 存储：`custom_skills` 加 3 个 nullable 列（migration v30），单表无关联表。**
- `files TEXT NULL`：JSON map `{"scripts/x.py":"…"}`（仅辅助文件，不含 SKILL.md 正文）。
- `frontmatter TEXT NULL`：上游 frontmatter 原始 map（JSON），安装时落库。
- `origin_meta TEXT NULL`：`{kind:"external", source, slug, originUrl, upstreamName, upstreamVersion}`。
备选：独立 `custom_skill_files` 表（拒绝——数据量与访问形态都是行内读写，关联表只增复杂度）；`origin_kind` 独立列（拒绝——`origin_meta.kind` 已足够，少一列少一份迁移面）。`CUSTOM_SKILL_COLS` 同步加三列（alias 驼峰），`addCustomSkill`/`updateCustomSkill` 可选参数透传（undefined=不动）。README 里旧行 NULL=单文件现状，**零数据迁移**。

**D2 — 取包：适配器契约加 `fetchPackage(slug)`，各自实现，统一纪律。**
- SkillHub：download 端点取 zip。重定向**手动跟**（`redirect:"manual"`，≤3 跳），**每跳校验 Location host ∈ {api.skillhub.cn, skillhub.cn, *.myqcloud.com}**——不裸跟 fetch 默认重定向（防 302 到任意站）。jszip 内存解包（下载体 ≤30MB 上限）。
- Smithery：解析 `gitUrl` → `{owner, repo, ref, subPath}`（接受 `/tree/` 与 `/blob/` 两形态，blob 取 dirname；ref 缺省不传让 API 按 HEAD 解析）；**逐文件走 GitHub contents API**（`api.github.com/repos/<o>/<r>/contents/<path>`，公开仓免鉴权）：`githubResolveDir` **逐段解析**目录路径（实测中间段可为符号链接——`.claude/skills`→`../.agents/skills`——每段 404 即 `upstream-not-found`，符号链接跟随有预算、逃逸即拒）；`githubFetchDirFiles` 递归取文件（深度 ≤4，>2MB 的文件**不下载**、以 `{oversized:true}` 描述符进清单如实展示）。404 → 显式 `upstream-not-found`（`frontend-design` 实证形态）。**tarball 路线实测否决**：单体仓整包 38.8MB/超时，且 codeload 无子树端点。
- 统一：沿用刀一出站纪律（无凭据、平台 UA）；二进制取包超时放宽到 15s（zip 体量大于 JSON）；`Accept` 随源（zip 二进制照收，不复用 JSON header 假设）。

**D3 — 安全解包：集中一个 `parsePackage` 层，先验后取，超限即败。**
- 路径校验（共用）：拒绝绝对路径、`..` 段、盘符、NUL、反斜杠逃逸；目录项跳过；`__MACOSX/`、`.DS_Store` 垃圾滤除。zip 走 `unzipToMap`（jszip 解包时逐项校验 + 解包累计 ≤50MB 防 zip-bomb），Smithery 的 contents-API 文件映射直接进同一层。
- 限额（常量 `PACKAGE_LIMITS`）：单辅助文件 ≤512KB、辅助文件总量 ≤2MB、辅助文件数 ≤64、下载体 ≤30MB、解包累计 ≤50MB、正文 ≤200k 字符。**超限 = 安装失败**，不截断。
- 文本判定：扩展名白名单（md/txt/json/yaml/yml/toml/csv/py/sh/js/ts/rb/pl/ps1/bat/cmd/sql/html/css/ini/cfg/xml…）+ `#!` 开头；其余（二进制）**不存储**，但**预览必须如实列出**（`action:"omitted-binary"`）；contents API 拒下的超大文件列 `action:"omitted-large"`——省略可见，永不静默。
- 包内无 SKILL.md（大小写不敏感、取最浅者）→ 显式失败。

**D4 — 预览与安装两段式；包进快照缓存节约二次下载。**
- `GET /api/extensions/external/install-preview/:source/:slug`：取包+解析 → `{preview:{bodyExcerpt(≤1500 字), files:[{path,bytes,script,action}], licenseState, licenseText, originUrl, upstreamName, normalizedName, version, source}}`。禁用源 → 404。
- `POST /api/extensions/external/install`：`{source, slug, confirm:true}`。缺 `confirm===true` → **400**（服务端强制，绕过 UI 也一样拒）。禁用源 → 404。
- 包缓存：快照缓存新增 op 键 `source:package:slug`，TTL **10 分钟**、**上限 5 条**（Map 插入序淘汰最旧）——预览→确认→安装两次调用只下载一次；缓存的是解析后对象（≤5×2MB 内存面）。坏响应不入缓存（失败即刻返回，与元数据快照姿态一致）。

**D5 — 名字归一化 + 冲突裁决。**
- `normalizeSkillName(raw)`：lowercase → `[^a-z0-9]+` 折叠为 `-` → 去首尾/重复 `-` → 空则显式失败；长度 ≤64。归一输入 = 条目 `id`（两源都是 slug）；上游 displayName（中文）只进展示，不进名字。
- 冲突：同名技能已存在——① 其 `origin_meta` 是同一 `(source, slug)` → **重装替换**（content/files/frontmatter/origin_meta 全量覆盖，语义同 pack 的 `replaced`）；② 其他任何来源 → **409**，明示冲突技能来源（user/pack/另一外部条目），不静默覆盖、不造后缀。

**D6 — frontmatter 保留：存储原始 map，物化时归一 name/description、滤旧拼写。**
- 安装时：解析上游 SKILL.md frontmatter 存 `frontmatter` 列；**剔除** dsh 会 throw 的 camelCase 键（`userInvocable`/`modelInvocable`/`disableModelInvocation`）——永远不落库（双保险：物化时再滤一次）。
- 物化时：有 `frontmatter` → `yaml.dump({...stored, name: row.name, description: row.description})` + 正文；无 → 现行两字段头。值类型强转安全（name/desc 字符串）。
- 用户在 UI 编辑正文不影响 frontmatter 列（编辑面不暴露 Invocation 键编辑；`user-invocable:false` 与 `disable-model-invocation:true` 等同策略字段照旧生效——这是保留的**目的**，不是缺陷）。

**D7 — 物化：目录树写入 + 陈旧文件对账（幂等）。**
- `writeSkill(row)`：有 `files` → mkdir 技能目录，写 SKILL.md（原子 temp+rename 照旧），再写每个辅助文件（原子写，幂等）；**对账**：技能目录内不在 `files`∪{SKILL.md} 的文件删除（含子目录递归，重装后上游删掉的文件随之清掉）。
- 辅助文件路径再校验一次（入库值与磁盘路径之间的最后防线）；非法路径 → 跳过 + warn（不炸整个 rebuild）。
- `rebuildFromDb` 无需改逻辑（`writeSkill` 自己处理）；`removeSkill` 已递归删目录。**旧行产物逐字节不变**（无 files/frontmatter → 同一 renderSkillMd 输出）。

**D8 — 安装编排放新模块 `external-install.js`；适配器扩展留在 `external-sources.js`。**
- `external-install.js`：`previewInstall(registry, source, slug)` / `performInstall(...)`——取包（缓存）→ parsePackage → normalizeSkillName → 冲突裁决 → db 写（add 或 update）→ `skillMaterialize.writeSkill` → broadcast → 返回 `{skill, replaced}`。
- `external-sources.js`：两适配器加 `fetchPackage`；注册表暴露 `fetchPackage(sourceId, slug)`（走包缓存）。
- 路由（`server/routes/extensions.js`）：两个新端点，门 = db ready + 会话（**沿既有 skills 写入端点姿态**；不用 requireMcpManage——同面既有 POST /skills 对任何登录用户开放，单独加码会在同一 UI 标签里造出不一致门）。失败映射：`upstream-not-found`→502、限额→422、名字空/冲突→409、缺 confirm→400。

**D9 — UI：详情弹窗加「安装」入口，确认面板是新组件。**
- `ExternalSourceTab` 详情弹窗：`Open upstream page` 旁加安装按钮（禁用源不渲染该按钮——详情入口本身就不存在）。点击 → `ExternalInstallDialog`。
- 状态机：`previewing → consent(勾选确认，含脚本必勾) → installing → success|failed(显示服务端原因)`。失败可重试（重新 preview）。成功后提供「前往已安装」引导（关闭面板 + 提示在「已安装」标签可见）。
- i18n 五语言（en/zh-CN/es/fr/ja）成对；文案要点：脚本警告（"此技能包含可执行脚本，未经本平台审校；脚本是否运行由你决定"）、确认勾选、文件清单表头。
- 既有 e2e 只读断言（无安装按钮）**按本 change 正当翻转**：改为「安装按钮存在但**流程必须经确认面板**」——旧断言删除要在 tasks 里显式列出，避免留死门。

**D10 — 版本与迁移。** `db.js` migration **v30**：3 个 `ALTER TABLE custom_skills ADD COLUMN`（files/frontmatter/origin_meta，全 TEXT NULL），幂等（沿用既有版本块模式）。`package.json` **零新增依赖**（`jszip`/`js-yaml` 已是直接依赖；`tar` 随取包策略改判回退）。

## Migration Plan

1. 实施 + 单测 + e2e 全绿（本地）。
2. migration v30 在既有 prod 库上幂等（旧行 NULL 不动）；回滚 = 摘除发布镜像（列多出无害，前版代码不读它们）。
3. 出片 → 滚产（标准五清单线）→ **生产真装一回**（脚本扩展 `verify-live-external-sources.mjs`：preview → confirm 安装一个 SkillHub 条目 → 断言已安装列表出现 + 物化目录含 scripts → 卸载清理）→ 台账 + 归档。

## Risks / Trade-offs

- **注入面就此开启**（最大风险）→ 治理就不止知情确认：脚本不自动执行、预览如实列脚本、未审校标全程在、名字归一不静默、冲突不覆盖。平台姿态 = 与手工上传技能同级（用户对自己实例的信任级别），不再额外教条。
- **Smithery gitUrl 失效是常态**（实测 1/2 命中）→ fail-closed + 错误进 UI；条目还在货架（元数据快照与包可用性解耦），安装时才显形——可接受（刀一货架承诺的只是元数据镜像）。
- **取包主机白名单面**：SkillHub 链路的重定向只放行 {api.skillhub.cn, skillhub.cn, *.myqcloud.com}；Smithery 链路只打 api.github.com 与 raw.githubusercontent 下载地址（条目自带）——白名单/端点都是显式常量，新增源/换 CDN 时一并评审。
- **包缓存内存面**：≤5 条 × ≤2MB 解析后文本。可忽略。
- **中文 displayName 归一为空**：`normalizeSkillName(displayName)` 会空 → 已设计为**名字取 slug**（两源恒有），displayName 只展示；若未来新源无 slug 无拉丁名 → 显式失败（好过静默装成空名）。
- **旧 e2e 只读断言翻转**：明确列为任务，防漏改造成「假绿」。
