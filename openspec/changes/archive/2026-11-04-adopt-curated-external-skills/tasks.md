# adopt-curated-external-skills — Tasks

## 1. 精选钉定源

- [x] 1.1 清单 `lib/curated-sources.js`：`anthropics/skills` @ `ca45fc496a3436251f191354091d557da31c15b5`，13 条 Apache-2.0；清单零正文，只写 slug / 上游路径 / 中文用途 / 标签
- [x] 1.2 结构性排除写进文件头与测试：pdf / docx / pptx / xlsx（Proprietary）、doc-coauthoring（无许可）、claude-api（60+ 辅助文件超 `maxAuxFiles(64)`，实测 `limit-exceeded`）
- [x] 1.3 adapter：`list` / `get` / `fetchPackage`，`originUrl` 钉到 sha（`.../tree/<sha>/<path>`），镜像许可态恒 `unknown`
- [x] 1.4 注入缝：`createExternalSourceRegistry({ extraAdapters })`（缺省 `[]`，既有调用点行为不变）；`server/routes/extensions.js` 装配精选源
- [x] 1.5 `GITHUB_TOKEN` 可选支持：仅对 `api.github.com` 挂 Authorization（匿名 60/h 实测第 6 条起 403）

## 2. 许可门修正

- [x] 2.1 新增 `proprietary` 轴：保留所有权利 / 专有 / 明禁再分发 → `rejected`，轴名 `proprietary`（不再误报 `not-declared`）
- [x] 2.2 宽松优先不变：MIT 样板文字里带 "All rights reserved" 仍判 `admitted`（回归测试钉死）
- [x] 2.3 分层裁决不变：primary（LICENSE 原文）压制 declared（frontmatter 自述）

## 3. 转正组装修正

- [x] 3.1 `buildAdoptedManifest`：`sanitizeFrontmatter(...) ?? {}` —— 上游 frontmatter 只有 name+description 时不再 `Object.keys(null)` 崩溃（`skill-creator` 实测撞上）
- [x] 3.2 回归测试：`adoption survives a frontmatter that sanitizes down to nothing`

## 4. 审计命令

- [x] 4.1 `scripts/adopt-curated-skills.mjs`：逐条 `previewAdoption` → 裁决表；`--json` 出机器台账；任一条被卡退出码 1（fail-closed）
- [x] 4.2 `--emit <dir>`：产出 13 份 `manifest.json` + `provenance.json` + `audit.json`；强制 `--operator` / `--reviewer`
- [x] 4.3 实测（2026-11-03，pin `ca45fc49`）：**13/13 admitted，0 refused**；产物 924KB，13 份全部过 `validatePackManifest`，全部 `toolFace=chat`，aux 文件树完整（canvas-design 28 个、skill-creator 17 个、mcp-builder 10 个）

## 5. 验证

- [x] 5.1 `scripts/test-curated-sources.mjs` 17 例全绿（清单守卫 / adapter 契约 / 取包 / 许可三分支 / 转正 / 最小 frontmatter）
- [x] 5.2 既有相关套件回归：`test-external-sources` + `test-external-package` + `test-official-adoption` + `test-adoption` + `test-upstream-license` + `test-external-source-endpoints` 共 83 例全绿
- [x] 5.3 活网审计跑通两次（匿名撞限流 → 带 token 通过），拒绝台账与准入台账均落盘

## 6. 未做（对外动作，需另行确认）

- [x] 6.1 把 13 条转正产物发布到市场（`gateway/packs.js` 发布门 / 管理员身份）——已核实：台账 §9 补记 2026-11-03，14 枚（13 curated+评审小队）经内网 port-forward facet:3200 publish_pack.py 一次过门；2026-11-04 市场 API 复验 adopted 包活体可见（作者 aloadtree@gmail.com→official:true）
- [x] 6.2 注册进注册处技能目录以进入材料广场（`/api/skills`，见 `docs/ecosystem-curation.md` 的入库轴）——已核实：10 条 eco-* 入库，facet catalog 复验 207 条、eco 13 全见（3 旧+10 新），内容端点 serving 9612B 实取（台账 §9 补记）
- [x] 6.3 批次 B：研发小队 pack（VoltAgent 8 岗 review/advisory 型 + superpowers 方法论技能）——已核实：研发评审小队 `jwDL7dSY…`（VoltAgent 八岗改铸，MIT @ ed74d115）随 14 枚批次上市场（台账 §9 补记；f27a5bb1/8dafac76 随批）
