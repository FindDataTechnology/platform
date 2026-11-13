## 1. IR 与边界规则

- [x] 1.1 新增 `server/pack-projection.js`：`projectManifestToIR(manifest)` → IR `{skills, personas, mcpRefs, dshCompat, displayMeta}`（另返回 `dropped[]` 供调用方如实交代），纯函数无 I/O；排序/换行/CRLF 归一保证确定性；验证：`scripts/test-pack-projection-boundary.mjs` 10 条（IR 键集恰为 5 类、能力逐字段保真且排序稳定、CRLF 不影响结果）
- [x] 1.2 投影前置校验：`validateProjectionBoundary(manifest)`（**放在 `server/pack-projection.js` 而非 `lib/pack-manifest.js`**——design D1 要求边界规则只有一处；且两个问题不同：清单校验回答"是不是合法 pack"（fleet/console 在那里合法，团队模板正靠它出货），投影校验回答"能不能离开平台"）。`fleet`/`console`/定价计费键即拒并给路径；端点与凭据键任意深度扫描即拒；`bots`/`plugins` 只**丢弃并记入 `dropped`**（它们是供给决定，含它们的 pack 仍合法）；验证：同文件 5 条（两类节拒、任意深度拒、丢弃不拒、非对象即拒）
- [x] 1.3 `DEFAULT_DSH_COMPAT = ">=0.2.0-rc.2 <0.3.0"` + `checkDshCompat({range, matrixVersion})`；解析不了的区间、缺版本一律**拒**（不放行）；`compareVersions` 按 semver 11.4 做预发布标识符比较（`rc.10` 新于 `rc.2`——dsh 正是这种编号，字符串比较会判反）；验证：同文件 3 条（范围内/低于/高于、不可解析即拒、rc 序）

## 2. 三个适配器

- [x] 2.1 `.yizpack` 适配器：`toYizpackEnvelope()` 委托既有 `buildBundle`，**逐字节一致**（用例直接 `Buffer` 对比，防容器漂移）。口径说明：yizpack 是**平台信封**，携带完整清单（含 fleet 模板）——它要去的是另一台壹座/桌面，没有编排的团队模板是另一个产品；出走边界只约束跨 harness 的两封；验证：`scripts/test-pack-projection-envelopes.mjs` 6 条含金样对比与缺 builder 即拒
- [x] 2.2 dsh 信封：`toDshBundle(ir)` → `{files: {"skills/<name>/SKILL.md", "skills/<name>/<附文件>", "presets/<id>.json"}, packageJson}`；`dsh.profile.bundles` 只指向自身、`dsh.compat` 带范围；**不产出 `cordis.patch.yml`**（D2：patch 层能 insert 加载项＝接管运行时）；验证：同文件 4 条（路径集合恰为 skills+presets、无 cordis、无 http/apiKey/token/Authorization、附文件随技能目录走）
- [x] 2.3 桌面预置清单：`toDesktopPresetManifest([{file, bytes}])` → `{bundles:[{file, sha256}]}`，按文件名排序、空文件名丢弃；验证：同文件用例断言键集恰为 `{file, sha256}`、同字节同摘要、异字节异摘要（确定性用例合并在同一文件，不另开 `-determinism`：同一断言点）

## 3. 确定性与漂移闸

- [x] 3.1 `scripts/project-pack-bundles.mjs`：源是仓库内 `packs/projections.json`（不可变快照；**不读库、不读市场、不联网**，否则闸验的是构建机的运气）；产出 `bundles/manifest.json` + `resources/bundles/*.yizpack` + `resources/dsh-bundles/<id>/`；`--check` 只读且非零退出，并额外检查**陈旧产物**（源里没有的文件仍会被烘焙出货）；验证：`test-pack-projection-drift.mjs` 8 条（源为空＝零改动、绿/红、篡改技能正文点名字封与技能、篡改 yizpack、手改清单、幽灵产物、两次逐字节一致、越界即拒）
- [x] 3.2 确定性：排序（skills 按名、personas 按 id、mcpRefs 按 registryName、tags/allowTools 排序）+ 换行归一（CRLF→LF）+ 固定 JSON 缩进；验证：同文件'two runs are byte-identical'（清单、yizpack、SKILL.md 三者逐字节）；**跨平台注**：本轮只在 macOS 实跑，Linux 由 CI 的同一步覆盖——归一是代码层保证，不依赖平台换行
- [x] 3.3 CI 接入：`.github/workflows/ci.yml` 的 gates job 里，紧跟 `Spec ↔ code constants` 加 `node scripts/project-pack-bundles.mjs --check`（约 100ms，只读仓库）；验证：本地改快照不重投影 → `--check` 退出 1 并点名信封；真仓当前 `clean — 0 pack(s), no drift`（与今天安装包不带预置包一致）

## 4. 交给烘焙（离线步骤，不阻塞发布）

- [x] 4.1 比对结论（**内容变更 = 无**）：仓库今天**不存在** `bundles/manifest.json`（`ls bundles` 与 `find -name manifest.json | grep bundle` 均为空），`bake-bundles.mjs` 走"no starter bundles listed"分支。生成器在源列表 `packs/projections.json` 缺失时同样产出零信（`--check` → `clean — 0 pack(s), no drift`，退出 0），故"生成结果 == 现手工清单"成立且为**空集对空集**——本变更不改变出货预置包内容。D5 要求的"不是重构而是内容变更"情形在此不适用。
- [x] 4.2 `bake-bundles.mjs` 改为只认生成清单：每条须带 `sha256` 且与文件字节一致，否则 fail——缺摘要报"carries no sha256 … bundles/manifest.json is GENERATED … declare the pack in packs/projections.json"，不符报两个摘要；保留既有 `readBundle` 全量重校验与"重建目标目录"的幂等；新增 `--root` 供 fixture 与产物快照复核；验证：`scripts/test-bake-bundles-generated.mjs` 4 条（生成清单烘焙且幂等、手加无摘要条目被指名拒、摘要不符拒并给两值、非 zip 仍拒）
- [x] 4.3 无后门回归：烘焙只落字节，导入仍走同一 `readBundle` 校验（用例 'a listed file that is not a valid bundle still fails' 就是它的反向证明）；既有 `test-pack-import-bundle.mjs` + `test-offline-bundle.mjs` 15/15 全绿；真仓 `node scripts/bake-bundles.mjs` 仍输出"no starter bundles listed"（零改动）

## 5. 收尾

- [x] 5.1 `openspec validate add-pack-bundle-projection --strict` 绿；分批全量扫（602 文件，每批 40，排除 4 个已证既有红套件）：**5263 条 / 5211 过 / 27 挂**——与上一轮（5128 条 / 27 挂）**同样的 27 条、同样的 19 个文件**，逐条已在 `harden-plugin-supply-gates` 5.2 归因（既有红 + 他人未提交文件：`server/auth.js`、`InputRequestCard.tsx`、`personal-staff-fleet.seed.json`、`add-zhiyu-mobile-clients`）；多出的 135 条正是本轮新增用例。**新增红 = 0**。另：本变更 44 条用例在落地树复跑全绿，`--check` 与 `bake-bundles` 在真仓均为零改动。
- [x] 5.2 文档：`docs/ecosystem-curation.md` 增 §7.2「三封信封同源」——表格列出三个信封的内容与边界（yizpack＝平台信封可带 fleet；dsh bundle 只含能力、无 patch 层；桌面清单只有文件名与摘要），并指明 `scripts/project-pack-bundles.mjs` 是唯一来源、`--check` 由 CI 执行
