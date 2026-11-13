# add-packaged-skills — Tasks

## 1. 校验器（发布门=装包门的同一函数）

- [x] 1.1 `lib/pack-manifest.js`：`PACK_LIMITS` 新增 `maxSkillFileChars`（512KiB）、`maxSkillAuxChars`（2MiB）、`maxSkillAuxFiles`（64）；`validatePackManifest` 的 skill 条目接受可选 `files`（对象，键=相对路径，值=文本）与可选 `frontmatter`（对象），frontmatter 体积计入单技能合计。验证：单测好/坏矩阵全字段（缺省=旧行为逐字节不变）。
- [x] 1.2 校验规则落地：路径安全（绝对路径/`..`/反斜杠/盘符/NUL 拒绝）、纯文本扩展名白名单（对齐 `external-sources.js` 的 `TEXT_EXTENSIONS`，单一事实源可导出复用）、files 键拒绝 `SKILL.md` 大小写变体（不敏感 FS 碰撞）。验证：每规则一条负例单测，错误信息带 entry+路径。
- [x] 1.3 限值错误信息命名超限条目与具体 bound（per-file / count / aggregate）。验证：三条顶格负例单测。

## 2. cell 装包线

- [x] 2.1 `pack-store.js installPack`：existing/new 两分支透传 `files`/`frontmatter` 给 `updateCustomSkill`/`addCustomSkill`（物化器/DB 零改动）。验证：单测装一个带 files 的 manifest → 行含 files → 物化树含 `references/x.md`；升级移除文件后陈旧清扫生效。
- [x] 2.2 携脚本包装包确认（服务端强制）：`POST /api/packs/install` 载荷规则——manifest 任一技能 files 含脚本扩展名而请求缺 `confirm` → 400 零安装。验证：单测缺 confirm 拒绝/带 confirm 通过/无脚本包不受影响。
- [x] 2.3 安装报告披露：技能行加 `fileCount` 与 `scriptFiles`（脚本文件名数组）。验证：单测断言报告行字段。
- [x] 2.4 `uninstallPreview` 修改判定扩为 content‖files‖frontmatter 三比对。验证：单测「只改 aux 文件也 warn」。

## 3. facet 市场线（gateway/packs.js）

- [x] 3.1 `jsonLimit` 1mb→24mb；发布流透传新字段（校验器已认）。验证：本地起 facet 发顶格 files manifest 成功、旧单文件 manifest 行为不变。
- [x] 3.2 读投影：`summaryOf`/详情/版本列表把 `files` 压成路径数组；新增 `GET /api/packs/:id/versions/:v/skills/:skill/files/:path`（可见性同详情，公开包匿名可读，路径逃逸 404）。验证：curl 断言详情无 files 内容体、按文件端点匿名 200/私包 404。
- [x] 3.3 `PACK_FILES_ENABLED` 发布门（默认关）：关时 files manifest 发布 4xx 带原因；无 files 发布不受开关影响。验证：两种 env 状态三例 curl。
- [x] 3.4 raw-md 端点对树技能 fail-loud（4xx 文案指明含辅助文件）；单文档技能不变。验证：curl 两态。

## 4. 上传入口（同一个 parsePackage）

- [x] 4.1 cell 包上传端点：`POST /api/extensions/skills` 增 multipart zip 通道（预览模式返回 inventory：body 摘要/路径/脚本标记/省略项；确认模式 `addCustomSkill({files, frontmatter})`，frontmatter 平台赢 name/description、REJECTED 键过滤）。body 上限与 zip 守卫对齐 `PACKAGE_LIMITS`。验证：单测好包落库落盘、坏包（无 SKILL.md/路径逃逸/超限）4xx 零残留。
- [x] 4.2 设置→技能 UI：「添加自定义技能」表单加 zip 上传，展示清单预览（脚本高亮、省略项如实）后创建；列表项展示文件数。验证：浏览器走查真 zip。
- [x] 4.3 pack 草稿导入带 files：编辑器「从已安装技能导入」读全行（files/frontmatter）；草稿持久化含 files（草稿端点 body limit 同步抬）。验证：导入多文件技能→存草稿→重开完好。
- [x] 4.4 编辑器直传 zip 按钮（我的创作→技能条目），走 4.1 同一解析。验证：浏览器走查。
- [x] 4.5 CLI 线：`build_pack_manifests.py`（finddata 仓）遍历技能目录组 `files`，超限报错退出；`validate_manifest.py` 对拍新校验器。验证：本地对拍一个带 scripts 的真实技能目录。

## 5. 前端装包流

- [x] 5.1 携脚本包确认弹窗（一次性，命名脚本数；服务端 400 的缺 confirm 错误映射为该弹窗重试）。验证：e2e 或浏览器走查携脚本包装包。
- [x] 5.2 安装报告技能行渲染 fileCount/scriptFiles。验证：走查报告显示。

## 6. 端到端验收（「改好」的定义）

- [x] 6.1 e2e：zip 上传（设置→技能）→ 对话中真实解析 `references/*.md` 引用与执行脚本 → 草稿固化 → 发布（门开）→ 另一 cell 装（确认弹窗）→ 对话同样跑通。缺任一环不算过。
- [x] 6.2 兼容回归：无 files 的存量 pack 装包/升级/卸载全路径行为不变（跑既有 pack e2e 套件）。

## 7. 文档与部署

- [x] 7.1 `facet-pack-builder` skill 文档：manifest 限值表更新（files 三限）、CLI 组 files 用法、raw-md 对树技能 fail-loud 提示。
- [x] 7.2 部署次序手册：先 cell（fd-prod GitOps）→ 桌面版随下一版本（release.yml 公开线）→ `PACK_FILES_ENABLED` 开门；写进 `docs/registry-maintenance.md` §9 发布记录模板备注。
- [x] 7.3 出片滚产：fd-build-channel 判路 → 镜像 GHA→hkccr→relay→ccr → fd-prod 滚 → 台账落账（按 AGENTS.md 纪律，禁本地 docker build）。
