# add-packaged-skills — Proposal

## Why

技能生态的标准形状已经是**包**：薄 SKILL.md + `references/*.md` + `scripts/*.py`（Anthropic 官方格式、SkillHub、Smithery 皆然），「渐进披露」——正文薄、细节按需读文件——是主流范式。而 pack manifest 的技能条目至今只内联单篇 markdown（≤64KiB）：复杂技能要么装不进 pack，要么拍扁丢脚本断引用。与此同时地基已全部就绪——刀二（add-external-skill-install）给外部技能线铺好了多文件 `custom_skills` 行、整树物化器、`parsePackage` 解析器与全套包限值——pack 线只差「最后一公里」的格式与入口。本轮迭代的核心目的：**复杂技能的上传、发布、安装、运行全链在本版本内完整落地**。

## What Changes

- **manifest 格式扩展（方向 B：内联，非 blob 引用，见 ADR-0025）**：`skills[i]` 增加可选 `files: {相对路径: 文本}` 与可选 `frontmatter` 对象。缺省（无 files/frontmatter）= 旧行为逐字节不变，存量 manifest 零迁移。正文上限维持 64KiB 不动——有 files 之后 64KiB 正文已是上下文预算天花板，本 change 不抬不降。
- **边界采用刀二平权**（经真实 SkillHub/Smithery 包验证过的数字，pack 线不做瓶颈）：单辅助文件 ≤512KiB、单技能辅文件合计 ≤2MiB 且 ≤64 个、正文 ≤64KiB；不加额外聚合上限（maxSkills=10 × 单技能上限天然封顶 ≈21MiB）。发布线 `jsonLimit` 1mb→24mb。
- **校验进校验器本身**（`lib/pack-manifest.js`）：路径安全（复用刀二 `safePackagePath`：拒绝绝对路径/`..`/反斜杠/NUL）+ 纯文本扩展名白名单（复用 `TEXT_EXTENSIONS`）+ files 键拒绝 `SKILL.md` 的大小写变体（macOS 大小写不敏感文件系统会砸掉渲染正文）。发布门与装包门是**同一个校验函数**——installPack 本就重验 manifest，这个性质保住即两门同守。
- **facet 读取面投影**：列表/详情把 `files` 压成路径清单（照 `extensions.js` list 端点先例）；全量 manifest 只在版本端点（装包服务端取回路径）与作者编辑时传输。
- **装包侧知情确认**：携带脚本文件（`.py`/`.js` 等）的包，安装时加一次性确认（「本功能集携带 N 个脚本文件」）；无脚本包维持现有零摩擦流。安装报告按技能披露文件数与脚本文件名。
- **frontmatter 透传**：平台记录赢 `name`/`description`，其余键原样过（含 REJECTED 键过滤），frontmatter 体积计入技能上限——与刀二安装技能、物化器行为完全一致。
- **上传入口四处打通**（复用同一个 `parsePackage`：同限值、同清单、同姿态）：
  1. **设置→技能收 zip**（`POST /api/extensions/skills` 升格）：上传→解析→清单预览→落库为多文件技能，本地先跑通；
  2. **pack 草稿从已安装技能导入带 files**：上传→本地对话验证→固化成 pack 的创作主径；
  3. **pack 编辑器直传 zip 按钮**（我的创作→技能条目）；
  4. **CLI 线**：`build_pack_manifests.py` 从本地目录组 files（识律类内部线）。
- **registry 响亮失败**：per-skill raw-md 端点对树技能返回显式 4xx（「该技能含辅助文件，暂不支持注册」），杜绝丢树孪生静默上线。
- **滚动洞用发布门堵**：facet 加 `PACK_FILES_ENABLED` env（默认关）；次序=先滚 cell（fd-prod+桌面）→ 桌面底线版本过了 → 开门。旧 cell 校验器对未知键不拒绝也不报错（静默吞 files 装出哑技能），桌面版以月计升级，纪律挡不住，开关挡得住。

**明确不做**：
- 不做 registry/技能市场的多文件形状（`skill_md_url` 单文档、market 安装链路零改动）——独立 change 跟进，本轮以 fail-loud 显式留白。
- 不启 blob/包引用存储（C 方案）——版本原子性优先；数据级附件（模板资产、语料）真出现时再立 ADR 改道。
- 不做 pack 编辑器的完整文件树编辑器（增删改单个文件）——四处上传入口已覆盖「进得来」，「改得细」缓做。
- 不自动执行任何脚本（落盘即止，运行与否由用户在对话中决定，与刀二同级权限）。

## Capabilities

### New Capabilities

- 无新 capability——全部行为落在既有 capability 的扩展上（多文件行/物化是刀二已立语义的自然延伸，本 change 把它接进 pack 线与上传入口）。

### Modified Capabilities

- `pack-authoring`：「Skills are composed inline」升格为「可携带辅助文件树与 frontmatter」——草稿技能条目携带 files；编辑器提供 zip 直传与从已安装技能导入（带 files）两个入口；从自定义预设预填草稿时，作者自己的多文件技能全量带入（含 files）。
- `pack-installation`：安装物化整棵目录树（SKILL.md+files）；携脚本包装一次性知情确认（服务端强制）；安装报告按技能披露文件/脚本清单；卸载预览的「已修改」判定加 files 对比。
- `pack-marketplace`：发布接受 files（限值同校验器、`jsonLimit` 24mb）；列表/详情读投影把 files 压成路径清单；`PACK_FILES_ENABLED` 发布门（默认关）；raw-md 端点对树技能 fail-loud。
- `extension-management-ui`：「User can add a custom skill」升格——自定义技能添加支持 zip 包上传，解析后展示文件清单（含脚本高亮与省略项如实标注）再创建。
- `extension-runtime-management`：「Backend API for managing skills at runtime」升格——技能 CRUD API 接受 `files`/`frontmatter`（或包上传），存储与物化走刀二已立的多文件语义。

## Impact

- **服务端**：`lib/pack-manifest.js`（校验器扩展：files/frontmatter/路径安全/白名单/SKILL.md 碰撞，PACK_LIMITS 新增条目）；`gateway/packs.js`（jsonLimit、读投影、PACK_FILES_ENABLED、raw-md fail-loud）；`pack-store.js`（installPack/uninstallPreview 透传 files/frontmatter）；`server/routes/extensions.js`（zip 上传端点）；`external-sources.js`（`parsePackage` 导出复用，限值单一事实源）。
- **前端**：设置→技能上传 UI（zip 选择→清单预览→创建）；pack 编辑器技能条目 files 展示与直传/导入入口；装包确认弹窗（携脚本包）。
- **CLI/创作线**：`build_pack_manifests.py` 读本地目录组 files；facet-pack-builder skill 文档跟进。
- **部署**：次序硬约束——先 cell（fd-prod GitOps + 桌面版随下一版本节奏）后 facet 开门；`PACK_FILES_ENABLED` 默认关。
- **验收线（本版本「改好」的定义）**：真实 Anthropic 式复杂技能（SKILL.md+references+scripts）zip 上传 → 本地 cell 对话中真实解析引用/执行脚本 → 固化 pack 草稿 → 发布 → **另一个 cell 装包后同样跑通**——端到端一气，缺一环不算改好。
