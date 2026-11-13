## 1. 证据形状与校验

- [x] 1.1 证据形状集中在 `lib/curation-evidence.js`（纯函数）：`axes{}`（每轴 `verdict` + 一句话 `reason`）/ `pin{repo, commit|tag}`（浮动分支拒）/ `licence`（SPDX）/ `egress`（`none` | `open` | `allowlist(…)`）/ `reviewedBy`（无签名不算审）/ `reviewedAt` / `reviewValidUntil`（可空＝永久）；验证：`scripts/test-curation-evidence.mjs` 14 条（完整两例、缺块即未审、逐项点名缺什么、浮动钉点拒、egress 三形态与拼错拒）
- [x] 1.2 完整性判定：`needs-human` 即不完整（"停在半路的审不是审"）、缺 `egress` 不完整、插件 species 强制 P1/P2；**多出的轴也拒**（给错 species 声明一个不存在的审校步骤会误导）；验证：同文件用例（缺轴/缺 egress/轴止于 need-human/插件缺 P1 P2/多出轴/轴缺理由）
- [x] 1.3 过期判定：`evidenceState(entry, {today})` → `complete` / `stale` / `missing`；ISO 日字符串比较（不用 Date，避免时区按小时翻转）；空/未设＝永不失效；验证：同文件两条（过期转 stale 并给日期、空值三种形态均不过期）

## 2. 读面两维

- [x] 2.1 `server/plugin-catalog.js` 归一化整块透传 `evidence`（闸需要全部字段才能判）并新增 `pluginEvidenceState()`；`/api/plugin-catalog` 视图同时给 `state`（供给）与 `evidence`（证据摘要）两维；验证：`scripts/test-curation-readface.mjs` 断言正交（"已审但未供给"与"已供给但未审"并存且互不掩盖）
- [x] 2.2 `facet/supply-catalog.js` 新增 `attachEvidenceSummary(row, raw, {species})`，facade 与 data-anchor 两条目录路由都挂（无证据则原样不动）；摘要由 `evidenceSummary()` 投影，**审校人与各轴理由都不出内部**；验证：同文件用例断言响应体不含 `ops@acme`/`reviewedBy`/`reason`
- [x] 2.3 既有条目不被清除：用例以两条无证据旧条目跑读取，条目数不变、均标 `missing`、`pluginSupplyState` 仍返回 `unsupplied`（供给态不因新规则变化）；**现网目录今天不存在**（`packs/plugin-catalog.json` 缺失 → 空目录），故无真实条目需迁移，D5 的"首次启用全变缺证据"在此为零条目

## 3. 拒绝点

- [x] 3.1 `scripts/check-curation-evidence.mjs`：默认只判"本部署供给的条目"（供给名单 = `dsh-matrix/plugin-supply.json` ∪ `dsh-profile-template` 的 `dsh.profile.bundles`，剔除 `@deepseek-ai/*` 上游运行时），异常非零退出并逐条点名 `条目 (missing|stale)` + 每个缺失字段路径；`--all` 判全目录；`--candidate <file>` 判候选文件且**只读**；验证：`scripts/test-curation-evidence-gate.mjs` 9 条（完整过、缺 egress 点名并给修法、过期要求复审、--warn 不阻断、未供给不判、无目录即空、候选只读、上游剔除、judge 给状态）
- [x] 3.2 出片前置：`predist` 链尾 + Dockerfile `check-plugin-supply` 之后各加一条，**当前为 `--warn`（观察轮，打印不阻断）**；切换成阻断＝删掉那个 flag（注释里写明了）；验证：真仓当前无目录 → 输出"no plugin catalogue in this tree"、退出 0（零误报）；阻断形态由用例 '--warn prints the same problems but does not block' 反向钉住（同一条目 default 模式退出 1）
- [x] 3.3 上架路径：**实测该目录没有 HTTP 写面**（`PLUGIN_CATALOG_FILE` 只有读；全仓无对目录的 `writeFileSync`）——插件的"上架"就是**改文件 + 烘焙**，所以拒绝点就是这道门（3.1）加出片前置（3.2），`--candidate` 覆盖"写入前先验"。**偏离说明**：spec 场景写的是"上架返回明确错误且未写入"，本仓无该写接口可返回；已用"只读校验 + 出片阻断 + 读面不呈现为可供给"三处达成同一效果，且没有任何写入路径可绕过（验证：`--candidate` 用例断言文件逐字节不变）

## 4. 台账生成

- [x] 4.1 `scripts/gen-curation-ledger.mjs`：从 `packs/plugin-catalog.json` 生成**标记块**（`<!-- BEGIN/END GENERATED: curation-ledger -->`），字段白名单＝条目 / species / 上游钉点（短 ref）/ SPDX / 出网 / 逐轴结论 / 复审期限 / 证据态 / 审校人；块外散文**一字不动**（今天的台账还有首批理由与三条硬排除，整文件生成会毁掉真记录——这是有意的实现选择，理由写进脚本注释）；验证：`scripts/test-curation-ledger.mjs` 8 条（字段与排序、散文保真、两次逐字节一致、重复生成不叠块、手改表红、改散文不红、空目录不删台账、无块时追加）
- [x] 4.2 CI：`ci.yml` gates job 里紧跟投影漂移闸加 `node scripts/gen-curation-ledger.mjs --check`；台账顶部已由生成块自带"本段由…生成，请勿手改"；验证：手改表格 → `--check` 退出 1 并提示重跑生成；改散文 → 仍 0（用例钉住两侧）
> 原 4.3（证据回填）已拆至 `openspec/changes/close-curation-evidence-rollout` 任务 1.1 / 1.2：它要填的是一个**还不存在**的目录（`ls packs/` 只有四个 pack 目录，无目录文件），而且需要真实上游 commit、逐仓 LICENSE 原文核验与真实审校人——这些是事实，不能脚本猜；把它留在这里会让本变更永远到不了"完成"，`curation-evidence` 的契约也就永远进不了 `openspec/specs/`。

## 5. 收尾

- [x] 5.1 `openspec validate add-curation-evidence-gate --strict` 绿（归档前复跑）；全量扫 16 批 × 40 文件：**607 文件 / 5316 用例 / 5263 过 / 28 红**，对照同树基线（602 / 5263 / 5211 / 27）**本变更零新增红**——新增的 5 个文件里 4 个是本变更的用例文件（37 条全绿），第 5 个是他人新增的 `test-memory-policy-route.mjs`（53 条新增用例＝37＋16）；唯一新红名字 `test-mcp-satellite-sharing` 的「the shareable list contains no member-scoped satellite (env-read audit)」由**他人未提交改动**引入（HEAD 的 `server/fleet-mcp.js` 里 `FLEET_MCP_MEMBER_ID` 出现 0 次，工作树 2 次且都在未提交 diff 的 `+` 行），本变更未触及该面；另把受影响面（引用本变更四个运行时文件的 29 个测试文件）单跑一遍：**275 条全绿**
- [x] 5.2 文档：`docs/ecosystem-curation.md` 增 §7.3「证据字段」——含 JSON 样例、轴/钉点/出网/审校人/三态规则、**证据态与供给态正交**、采集器归属外部仓且人工填写同形合法、两处门与当前 `--warn` 观察轮
> 原 5.3（外部仓立项）已拆至 `openspec/changes/close-curation-evidence-rollout` 任务 3.1：`mcp-gateway-registry` 侧的变更只能在对方仓的会话里提。本仓这边已把形状冻结在 `lib/curation-evidence.js`，14 条形状用例可被对方当契约测试用；出片门从 `--warn` 切阻断也一并拆到那边任务 2.1。
