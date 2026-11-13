# add-external-skill-install — Tasks

> 验证纪律：每步自带验证方法；红先绿后的回归用例沿用刀二修复轮的先红后绿法。

## 1. 存储升格（DB + 物化器）

- [x] 1.1 `db.js` migration v30：`custom_skills` 加 `files`/`frontmatter`/`origin_meta`（TEXT NULL，幂等 `ALTER` + 版本标记表）；`CUSTOM_SKILL_COLS` 加三列驼峰别名；`addCustomSkill`/`updateCustomSkill` 支持可选透传（undefined=不动）。验证：新增 `scripts/test-custom-skill-v30-migration.mjs`（整形回 v29 形状 + 清 v30 标记 → 重跑 `initDb()`：三列补上、启动不降级、旧行三键全 null、重复启动幂等）——2/2 绿
- [x] 1.2 `skill-materialize.js` 升级：`writeSkill` 有 `files` → 整目录树写入 + 陈旧辅助文件对账删除（SKILL.md 仍原子写）；辅助文件路径再校验（非法跳过+warn）。验证：新增 `scripts/test-skill-materialize-files.mjs`（写/改/减文件三态 + 路径逃逸拒绝 + 旧行单文件产物逐字节等于现行）
- [x] 1.3 `skill-materialize.js` frontmatter 保留：有 `frontmatter` → `yaml.dump(stored ⊕ {name,description 覆盖})` + 正文；camelCase 旧拼写键写入前滤除（存储层与物化层双滤）。验证：同测试文件——保留字段（whenToUse/user-invocable/disable-model-invocation/metadata）落盘可见、旧拼写键永不出现、无 frontmatter 行输出与 1.2 前全等
- [x] 1.4 依赖面：实施中曾显式加 `"tar": "^6.2.1"`（tarball 路线所需），随取包策略改判（contents API）**回退**——最终零新增依赖（`jszip`/`js-yaml` 已是直接依赖）。验证：`git diff package.json` 无 diff + 全测试族绿

## 2. 取包与解包（external-sources.js 扩展）

- [x] 2.1 适配器 `fetchPackage(slug)`：SkillHub=download 端点 zip（**手动跟 302、≤3 跳、每跳 host ∈ {api.skillhub.cn, skillhub.cn, *.myqcloud.com}**、体积 ≤30MB）；Smithery=gitUrl 解析（`/tree/` + `/blob/`、ref 缺省按 HEAD）→ **GitHub contents API 逐文件取**（tarball 路线实测否决：单体仓 2KB 技能要 38.8MB 整包且超时）——`githubResolveDir` 逐段解析中间符号链接（逃逸拒+预算）、`githubFetchDirFiles` 递归 ≤4 层、超限文件以 `{oversized:true}` 描述符入清单不搬字节。验证：`scripts/test-external-package.mjs`（注入 fetch 桩：302 白名单内/外、404 upstream-not-found、符号链接解析/逃逸、subpath 过滤、oversized 描述符）——16/16 绿
- [x] 2.2 `parsePackage` 共用层：zip（jszip 经 `unzipToMap`，解包累计 ≤50MB）与 contents-API 文件映射两路走同一路径校验（拒绝绝对/`..`/盘符/NUL/反斜杠）、垃圾滤除（`__MACOSX/`、`.DS_Store`）、限额（单文件≤512KB/总量≤2MB/文件数≤64，**超限即败不截断**）、文本白名单 + `#!` 表（二进制 `action:"omitted-binary"`、超大 `action:"omitted-large"`，均可见）、无 SKILL.md 显式失败。验证：同测试文件——逐条限额与逃逸用例（含 `../evil` 必须整体失败）——绿
- [x] 2.3 包缓存：快照缓存挂 `source:package:slug` 键，TTL 10 分钟、Map 上限 5 条插入序淘汰；坏响应不入缓存。验证：同测试文件——两次 resolve 只调 loader 一次、第 6 条挤掉第 1 条、loader throw 不留脏
- [x] 2.4 注册表暴露 `fetchPackage(sourceId, slug)`（经缓存；禁用源返回 null）。验证：同测试文件 + `scripts/test-external-source-endpoints.mjs` 追加断言

## 3. 安装编排（新模块 external-install.js）

- [x] 3.1 `normalizeSkillName(raw)`：lowercase → 非 `[a-z0-9]` 折叠 `-` → 去首尾/重复 → 空即抛；≤64。名字源 = 条目 id（slug）。验证：`scripts/test-external-install.mjs`——含大写/下划线/中文/连续符号/超长的归一表驱动用例
- [x] 3.2 `previewInstall`：取包（缓存）→ parsePackage → 组装 `{bodyExcerpt≤1500, files[{path,bytes,script,action}], licenseState/licenseText, originUrl, upstreamName, normalizedName, version, source}`；禁用源→null。验证：同测试文件（桩包断言形状 + script 标记正确）
- [x] 3.3 `performInstall`：confirm 校验在最外层路由（3.5）；本层=取包→冲突裁决（同 `(source,slug)` 重装替换；异源 409）→ db 写（add/update：content=正文、files/frontmatter/origin_meta）→ materialize → 返回 `{skill, replaced}`；全链任一失败零残留（先解析后写库）。验证：同测试文件——首装/重装替换/异源冲突 409/上游 404 无行无目录 四态
- [x] 3.4 origin_meta 回读面：`GET /api/extensions/skills` 的数据库行带 `files`（仅路径数组）+ `originMeta`（含 upstreamName 供 UI 显示原名）。验证：`scripts/test-external-source-endpoints.mjs` 或 install 测试中的 list 断言

## 4. 端点与门（server/routes/extensions.js）

- [x] 4.1 `GET /api/extensions/external/install-preview/:source/:slug`：db ready 门 + 会话；禁用/未知源 404；取包失败 502（含原因）；限额 422。验证：端点测试（沿用 `scripts/test-external-source-endpoints.mjs` harness）
- [x] 4.2 `POST /api/extensions/external/install`：body `{source, slug, confirm}`；`confirm !== true` → **400 且零副作用**（先断言后动作的顺序写死）；成功 200 `{skill, replaced}`；冲突 409；上游 404→502。验证：端点测试四态 + 「无 confirm 直调不落任何行/文件」
- [x] 4.3 只读断言更新（刀一遗留死门）：`test-external-source-endpoints.mjs` 中「外部源路由无写调用」的 grep 断言按本 change 正当改判——改为「所有写路径必须经 confirm 门」（断言 install 路由存在且非 confirm 请求被拒），确保不留假绿。验证：该测试文件全绿

## 5. 前端（货架 → 安装流）

- [x] 5.1 `packages/core` extensions-api 加 `previewExternalInstall(source, slug)` / `installExternalSkill(source, slug)`（后者恒带 confirm:true，服务端仍强制）。验证：web typecheck 通过
- [x] 5.2 新组件 `ExternalInstallDialog.tsx`：状态机 previewing→consent→installing→success|failed；consent 含正文摘录、文件清单表（script 高亮+二进制 omitted 标注）、license 三态、上游地址、脚本警告、确认 checkbox（有脚本时必须勾选才可提交）；failed 显示服务端原因可重试。验证：`web:build:e2e` 通过
- [x] 5.3 `ExternalSourceTab` 详情弹窗加安装入口（禁用源不渲染）→ 接 5.2；成功路径提示去「已安装」；「未经本平台审校」标在详情+面板恒在。验证：e2e（5.4）
- [x] 5.4 e2e（`e2e/external-sources.spec.js` 扩展，路由 mock 全链）：①预览面板先出、无确认不可装（按钮禁用）②脚本技能必须勾选 ③confirm 后调 install 且成功态 ④失败态如实显示 ⑤**旧断言翻转**：原「货架无安装按钮」改为「安装按钮存在但必须经确认面板」；「详情仅外链」旧断言同步改判。验证：`npx playwright test --project=fast e2e/external-sources.spec.js` 全绿（先红后绿：5.4 先于 5.2 写红）
- [x] 5.5 i18n 五语言（en/zh-CN/es/fr/ja）：脚本警告、确认勾选、清单表头、三态结果文案成对。验证：`npm run check:locales` 绿

## 6. 全量与回归

- [x] 6.1 `npm run lint` + `npm --prefix web run typecheck` + 既有 e2e 车道（extensions/external-sources 相关 spec 全绿）。验证：命令输出
- [x] 6.2 单测全量：`npm run test:unit`（含新增 4 个测试文件）。验证：命令输出

## 7. 生产上线（标准线）

- [x] 7.1 本地全绿后出片：`fd-build-channel pick platform` 判路 → 快照 → GHA → relay → ccr 硬门（skopeo digest 全等）。验证：`gh run watch` 绿 + `grep "OK yizuo/platform:sha-" /var/log/tcr-relay.log`
- [x] 7.2 滚产五清单（platform/platform-demo/facet/agent-runner-b/c；serving 不动）→ rollout status 全绿。验证：`kubectl rollout status` + pod imageID digest 核对
- [x] 7.3 生产真装验收：扩展 `scripts/verify-live-external-sources.mjs`——登录后 preview 一个 SkillHub 条目 → confirm 安装 → 断言已安装列表出现 + pod 内物化目录含 scripts 文件 → 卸载清理。验证：探针 **ALL PASS** 输出
- [x] 7.4 台账 + docs 回填：`docs/external-skill-sources.md` 加刀二核验结论（含 gitUrl 失效实证）；memory 更新。验证：文档 diff + 提交
