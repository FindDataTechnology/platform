# add-packaged-skills — Design

## Context

刀二（add-external-skill-install，已归档/滚产 sha-2d1b725）已把多文件技能的地基铺完：`custom_skills` 行的 `files`/`frontmatter`/`origin_meta` 三列、`skill-materialize.js` 整树物化（含陈旧清扫）、`external-sources.js` 的 `parsePackage`（zip→body+files+inventory，限值 `PACKAGE_LIMITS`）与 `safePackagePath`/`TEXT_EXTENSIONS`。pack 线的存储与运行时因此**零改动**——本设计只接通格式与入口：

```
   发布侧 (facet/gateway)                       安装侧 (cell)
┌──────────────────────────┐               ┌────────────────────────────┐
│ 校验器 pack-manifest.js    │               │ pack-store.installPack      │
│  skills[i] += files/fm    │──manifest──▶  │  透传 files/frontmatter     │
│  路径/白名单/碰撞/限值      │  (版本端点     │ 物化器/DB 行 ✅ 已就位零改动  │
│ jsonLimit 1mb→24mb        │  全量传输)     │ 装包确认+报告披露            │
│ 读投影/发布门/raw-md拒绝    │               │                            │
└──────────────────────────┘               └────────────────────────────┘
     + 上传入口×4（设置→技能 zip / 草稿导入 / 编辑器直传 / CLI）
```

关键现状事实（实测代码锚点）：发布线 `gateway/packs.js:646` `jsonLimit="1mb"`；装包 `pack-store.js:177` 只传 name/description/content；`lib/pack-manifest.js` 的 skill 条目校验（:340-359）不认识 files 也不拒绝未知键——**旧 cell 遇 files manifest 静默装哑技能**；raw-md 端点（`gateway/packs.js:934`）合成 frontmatter 只吐 body；装包 UI（`PackDetailDialog.subscribe()`）零确认直达 installPack。

## Goals / Non-Goals

**Goals**：复杂技能（SKILL.md+references+scripts）上传→发布→安装→运行全链在本版本闭环（验收线见 proposal）；发布门与装包门维持同一校验函数；存量 manifest/存量行零迁移零行为变化。

**Non-Goals**（设计层面再确认）：registry/技能市场多文件形状（fail-loud 留白，独立 change）；blob/包引用存储（ADR-0025 定案内联）；编辑器完整文件树编辑；脚本自动执行与依赖安装（落盘即止，与刀二同级）。

## Decisions

### D1 manifest 形状：内联 files，缺省旧行为

`skills[i]` 增加可选 `files: {相对路径: 文本}` 与可选 `frontmatter` 对象。字段缺省 = 校验器视同旧 manifest，物化器/装包路径产出与今天逐字节相同。**备选被否**：blob 引用（丢版本原子性，见 ADR-0025）；`skillMd`+`skillFiles` 平行结构（多一套命名，无增益）。

### D2 限值：刀二平权单一事实源

`PACK_LIMITS` 新增条目直接对齐 `PACKAGE_LIMITS` 已验证数字：单辅助文件 ≤512KiB（`maxFileBytes`）、单技能辅文件合计 ≤2MiB（`maxTotalAuxBytes`）且 ≤64 个（`maxAuxFiles`）；frontmatter 计入单技能合计。正文 ≤64KiB 不变。**不加聚合上限**：maxSkills=10 × 单技能上限天然封顶 ≈21MiB，规则越少越好。`jsonLimit` 1mb→24mb（容顶格 manifest + JSON 转义膨胀）。**备选被否**：紧策展档（2MiB 聚合）——用户明令「必须能够实现复杂 skills 的上传」，边界不做瓶颈。

### D3 校验进校验器：一门管两门

路径安全（复用/内联 `safePackagePath` 语义：拒绝对对路径、`..`、反斜杠、盘符、NUL）、纯文本白名单（`TEXT_EXTENSIONS` 语义）、限值、以及 **files 键拒绝 SKILL.md 大小写变体**（macOS 大小写不敏感 FS 下 `skill.md` 会砸掉 `renderSkillMd` 产出的渲染正文——物化顺序是先写渲染 SKILL.md 再写 aux 树）全部写进 `validatePackManifest`。facet 发布门（`gateway/packs.js:779`）与 cell 装包门（`pack-store.js:154`）调用同一函数——**这个既有性质是本设计最重要的安全不变量，任何实现不得在装包侧加第二套规则**。

### D4 读投影：清单随行、内容按需

列表（`GET /api/packs`）与详情（`GET /api/packs/:id`）把 `files` 压成路径数组（先例：`extensions.js:244` 对 custom_skills 只吐 `Object.keys(s.files)`）；新增按文件取内容的只读端点（`GET /api/packs/:id/versions/:v/skills/:skill/files/:path`），可见性与详情一致（公开包匿名可读——延续「装前可验」的检查保证，spec 已改写为 inventory+按需）。全量 manifest 仅在版本端点（装包服务端取回）与作者编辑草稿时传输。**备选被否**：详情继续全量（每次浏览拖 MB 级树）。

### D5 信任姿态：携脚本一次性确认，服务端强制

装包请求对携脚本包必须带 `confirm` 标记，缺标记 400 且零安装（先例：刀二外部安装的服务端强制确认）。无脚本包完全走旧路。安装报告的技能行加 `fileCount` 与 `scriptFiles` 数组。**备选被否**：零确认+事后披露（静默装可执行文本进陌生人 cell）；外部线全套预览（抹平策展/未审阅两层信任的分层）。

### D6 registry：raw-md 对树技能 fail-loud

`/api/packs/:id/versions/:v/skills/:skill` 遇树技能返回 4xx（文案指明「含辅助文件，暂不支持单文档注册」），杜绝 `skill_md_url` 注册出丢树孪生。单文档技能行为不变。多文件 registry 形状=后续 change。

### D7 上传入口×4：同一个 parsePackage

1. **设置→技能**：`POST /api/extensions/skills` 收 multipart zip → `parsePackage` → 清单预览（body 摘要/路径/脚本高亮/省略项如实）→ 确认后 `addCustomSkill({files, frontmatter})`（frontmatter 平台赢 name/description，REJECTED 键过滤——复用 `renderSkillMd` 既有政策）。
2. **草稿导入**：编辑器「从已安装技能导入」读 `getCustomSkill` 全行（含 files/frontmatter）。
3. **编辑器直传**：草稿技能条目 zip 直传，同一解析端点。
4. **CLI**：`build_pack_manifests.py`（finddata 仓）遍历技能目录组 `files`，超限即报错退出（沿用其现有 gate 风格）；facet-pack-builder skill 文档同步。

四处同限值同姿态——限值定义只此一份（D2）。

### D8 升级/卸载语义：整体替换 + 修改判定加 files

升级：`updateCustomSkill(name, {content, files, frontmatter})` 整体替换，物化器陈旧清扫自动删掉 v2 移除的文件（`materializeAuxFiles` 的 walk-sweep 既有逻辑）。卸载预览的「已修改」判定从 `row.content !== s.content` 扩为 content‖files‖frontmatter 三比对。

### D9 滚动部署：发布门 + 次序

`PACK_FILES_ENABLED` env（facet，默认关）。次序硬约束：**先滚 cell（fd-prod GitOps → 桌面版随下一版本节奏）→ 桌面底线版本过了 → 开门**。开关把「旧 cell 静默哑技能的窗口期」变成显式未开放。cell 侧新校验器向后兼容旧 manifest（缺省旧行为），反向不兼容——这正是门存在的理由。

## Risks / Trade-offs

- **21MiB 级 manifest 旅行**：发布 API/装包取回各一次，SQLite TEXT 行 ~21MiB 无碍；读投影把浏览面隔开。接受；数据级附件真出现时按 ADR-0025 的退出条件改道 blob。
- **桌面版本长尾**：门开着之前桌面用户装不了 files 包——但看到的是明确「未开放」错误而非哑技能。桌面版出片节奏（release.yml 公开线）应赶在开门前带上新 cell。
- **multipart 上传是 cell 服务新面**：沿用刀二出站/入站纪律（限 body 大小=30MiB 压缩上限同 `maxDownloadBytes`、zip 炸弹守卫 `maxUnpackedBytes` 50MiB、路径逃逸拒绝）——`parsePackage` 已内建。
- **e2e 基线**：验收线（proposal Impact）必须含「另一 cell 装包后同样跑通」——真对话解析 `references/*.md` 与执行脚本，不是只验落盘。

## Open Questions

无——grilling 三轮已清空前沿（本轮决策树全文见 change 目录外的工作记录；如需回溯，决策对应 proposal What Changes 各条）。
