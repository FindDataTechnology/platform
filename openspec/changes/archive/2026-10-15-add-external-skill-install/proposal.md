# add-external-skill-install — Proposal

## Why

刀一（`add-external-skill-sources`，已归档/滚产 `sha-09989ff`）把外部市场（腾讯 SkillHub、Smithery）做成了**只读货架**：用户能看见外面有什么，但看完什么也做不了——每个卡片只能点开一个详情弹窗和一个上游外链。发现面已经通了（生产 12/12 眼见实证），下一步是把「看见」变成「可用」：让用户能把外部技能装进自己的壹座，成为真正能在对话里被 agent 加载调用的技能。这是刀二的唯一目的，也是刀一在 spec 里明确留给后续 change 的能力（「内容进入运行时属于后续 change」）。

## What Changes

- 新增 **`POST /api/extensions/external/install`** 端点（一个端点管两源，body 带 `source`）：服务端拉取外部包 → 解包 → 校验 → 落库 → 物化，产出可被 dsh 加载的技能。**取包链路逐源定案**（本轮实测）：
  - **SkillHub**：`GET /api/v1/download?slug=`（302 → COS 的 **zip**，实测 8 文件：`SKILL.md + scripts/*.py + README*.md + _meta.json`）——这就是多文件技能的来源。
  - **Smithery**：`gitUrl` 指向 GitHub 目录（实测形状 `https://github.com/<owner>/<repo>/tree/<ref>/<path>`）→ **contents API 逐文件取**（实施中改判：整仓 tarball 在单体仓不可用——2KB 技能要拉 38.8MB 且超时；API 先报大小后取字节，限额可执行）。目录路径允许中间段是符号链接（实测 `.claude/skills` → `../.agents/skills`，需逐段解析）；部分条目 gitUrl 已失效（`frontend-design` 目录 404），必须 fail-closed 报错而不是装出半成品。
- **存储升格：单文件 → 多文件目录**。`custom_skills` 表加 `files` 列（nullable JSON，`{"相对路径": 文本内容}`）；SkillHub 包里除 SKILL.md 正文外的辅助文件（scripts/README/_meta）一起入库。物化器从「写一个 SKILL.md」升级为「写整棵目录树」，dsh 的 filesystem provider 把目录当 resource base（实测 `renderResourceHint`：模型拿到 "Base directory for this skill: <dir>"），所以 `scripts/xxx.py` 这类相对路径引用真正可用。**旧行（files 为 NULL）行为逐字节不变**——零迁移。
- **frontmatter 保留**：现物化器重写 SKILL.md 只写 `name + description` 两字段（`renderSkillMd`），把上游 frontmatter 的 `whenToUse`/`user-invocable`/`metadata` 全部抹掉——而 dsh 实测消费这些字段（`parseInvocationPolicy` 读 `disable-model-invocation`/`user-invocable`；`whenToUse` 进 SkillEntry）。改为**保留上游原始 frontmatter**（仅强制 `name`/`description` 用平台归一值覆盖），用户在 UI 编辑时正文以外的字段不再丢失。
- **名字归一化**：dsh 的 skill 名文法实测为 `^[a-z0-9]+(-[a-z0-9]+)*$`（`isSkillName`），不匹配的**整条被静默忽略**（`skill file … ignored: invalid skill name`）。外部名字含大写/下划线是常态 → 安装时归一化（小写化 + 非法字符转 `-` + 压缩折叠），归一结果作为平台内技能名，**原始名进 description 与来源徽章**保留可追溯性；归一后与既有技能同名 → 409 明确报错（不静默覆盖、不造魔法后缀；覆盖只发生在对已装外部技能显式重装时）。
- **含脚本技能知情确认**：安装前服务端返回一份**预览**（SKILL.md 正文摘要 + 文件清单 + 脚本文件高亮 + 许可证三态 + 上游地址），前端弹确认面板，用户显式确认（checkbox：「我知道此技能包含可执行脚本且未经本平台审校」）后**才**执行安装。纯文稿技能（无 scripts）不弹该 checkbox，走普通确认。端点层强制：未经确认的请求缺 `confirm` 字段一律 400——门在服务端不在饰面。
- 前端「外部源」货架（`ExternalSourceTab`）解除只读：详情弹窗加「安装」按钮（现在只有一个上游外链），接预览 → 确认 → 安装 → 结果反馈。**「未经本平台审校」标在安装流全程保留**。

**明确不做**（保持刀一/既有边界）：
- 不做外部源的自动更新/版本跟随（装下来的就是一个快照版本，记 `originUrl`，用户想更新就再装一次；`origin_meta.kind='external'` 的新行允许被重装覆盖——同 pack 的 `replaced` 语义）。
- 不动 pack 链路、不动 registry 市场安装链路（registry 那条 `market/skills/:name/install` 零改动）。
- 不做依赖自动安装（SkillHub 的 python `dependency:` 字段只展示不执行——执行面在用户的 runner 环境，平台不代跑 pip）。
- 不做 license 门（declared 也不拦装，透传给用户看；「未经审校」是平台姿态）。

## Capabilities

### New Capabilities

- 无新 capability——刀二的全部行为落在既有 capability 的扩展上（安装路径是 `external-skill-sources` 的自然延伸，多文件/归一化是 `extension-runtime-management` 的既有存储行为的升格）。

### Modified Capabilities

- `external-skill-sources`：只读边界收紧为**「货架只读、安装走显式确认」**——移除「External shelf is read-only」需求（原「no install path」被本 change 正当地取代），新增「外部技能安装」「安装前知情确认与服务端强制」「多文件包按目录树存储与物化」「名字归一化到运行中文法」「取包链路逐源且 fail-closed」五条需求。
- `extension-runtime-management`：技能记录升格——`custom_skills` 可携带辅助文件集合与外部来源 provenance；list 端点如实暴露文件清单（路径）与来源，旧行（NULL）行为逐字节不变。
- `skill-invocation`：物化语义升格——多文件技能物化为**整棵目录**（SKILL.md + 辅助文件，前端 resource base 语义可用）；物化时**保留存储的上游 frontmatter 字段**（dsh 实测消费 `whenToUse`/`user-invocable`/`disable-model-invocation`/`metadata`，现被重写抹掉）；无存储 frontmatter 的旧行表头不变。
- `extension-management-ui`：新增「外部技能安装确认面板」需求（预览内容、脚本高亮、确认 checkbox、安装结果反馈）。

## Impact

- **服务端**：`external-sources.js` 加 `fetchPackage(source, slug)`（两源各一个取包实现 + 解包/清洗/限流；**零新增依赖**——jszip/js-yaml 已是直接依赖，实施中的 tar 依赖随策略改判回退）；`server/routes/extensions.js` 加 preview/install 两端点；`skill-materialize.js` 升级为目录树写入（保留旧单文件路径为子集情形）；`db.js` 加三列迁移（v30：`files`/`frontmatter`/`origin_meta` 全 TEXT NULL）；`extension-store.js` 透传。
- **前端**：`ExternalSourceTab.tsx` 详情弹窗加安装按钮；新组件 `ExternalInstallDialog.tsx`（预览 → 确认 → 结果三态）；`packages/core` 加两个外部 API 方法。
- **数据库**：`custom_skills` 加 3 列（`files`、`frontmatter`、`origin_meta`）——幂等迁移，旧行 NULL=单文件现状。
- **安全面**（本 change 的核心）：
  - **落盘即注入面开启**：SKILL.md 正文将进系统提示词——这正是知情确认要治理的；不自动执行任何外部代码，脚本文件只是落在技能目录里，是否运行由用户在对话中决定（与手工上传技能同级权限）。
  - **解包安全**：包解包做路径逃逸校验（拒绝 `../` 与绝对路径）、单文件体积上限、总解包体积上限、文件数上限；只存文本类文件（白名单扩展名），二进制/超大文件不入库并在预览里如实标注。
  - **出站纪律不变**：沿用 10s 超时、无凭据、平台 UA；安装端点的取包请求全部服务端发起。
  - **名称碰撞**：归一化后的名字与既有技能冲突时 409 + 明确错误（不静默覆盖——覆盖只能由用户对已装外部技能显式重装触发）。
- **条款面**：刀一核验的「只读展示 + 来源归属」底线之外，本 change 新增**内容再分发**（把上游技能内容取下来存进用户自己的实例）。SkillHub 下载接口是官方目录功能（用户主动动作）；Smithery 内容取自上游公开 git 仓，许可状态沿条目透传并在确认面板明示——用户为内容的最终使用人。
