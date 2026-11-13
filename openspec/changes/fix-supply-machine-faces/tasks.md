# Tasks — fix-supply-machine-faces

## 1. facet 宿主：机器路径不再被壳兜底

- [x] 1.1 在 `facet/index.js` 抽出机器面路径拒答清单（`/llms.txt`、`/llms-full.txt`、`/catalog.json`、`/robots.txt`），在 SPA 兜底之前判定并返回 404（`text/plain` 空体），清单导出为常量供测试复用 —— 验证：`node --test scripts/test-facet-machine-paths.mjs` 四路径均 404 且 body 不含 `<!doctype`
  - 实证：清单与中间件在 `facet/machine-paths.js`（`MACHINE_SURFACE_PATHS` / `isMachineSurfacePath` / `machineSurfaceGuard`），`facet/index.js:41,311` 在 `express.static` 与兜底之前挂载；`node --test scripts/test-facet-machine-paths.mjs` → **6 tests / 6 pass**（含大小写与尾斜杠变体、HEAD、POST 不误判）
- [x] 1.2 反向验证：把拒答清单临时清空 → 同一用例必须转红（四条路径回到 200 HTML）；恢复即绿 —— 验证：改前改后各跑一次，记录红/绿
  - 实证：把 `isMachineSurfacePath` 改为 `return false && …` → **2 条转红**（`matching ignores case…`、`machine paths answer 404…`），其余 4 条仍绿；恢复 → 6/6 绿。红的是「机器路径」那两条，不是无关用例
- [x] 1.3 人类路由回归：`/`、`/#/docs` 直链、未知路径仍返回壳文档；`/api/**` 仍走 API —— 验证：既有 `e2e` 壳用例与新增断言同绿
  - 实证：同一测试内 `human routes still reach the shell`（`/`、`/docs`、`/packs`、`/some/unknown/path` 均 200 text/html 且带 `<!doctype`）与 `the API plane is not intercepted`（`/api/ping` 200 JSON）绿

## 2. plaza 宿主：根路径四件套真的存在

- [x] 2.1 `scripts/deploy-plaza.sh` 发布步骤把 `generated/{llms.txt,llms-full.txt,catalog.json}` 与 `robots.txt` 落到站点根，并用目录内原子替换（先写 `.tmp` 再 rename）避免半套文件在线 —— 验证：脚本 dry-run 输出四路径与目标目录，无写入遗漏
  - 实证：落位逻辑独立成 `scripts/plaza-stage.sh`（deploy 通过 ssh stdin 送同一文件，本地测试跑同一文件）：解到同级 staging → 三份导出物 + robots.txt 写成 `.tmp` → 缺任一份 exit 1 → 站点内容覆盖 → 四个机器面最后逐个 `mv`（同 fs 原子）。原脚本只拷 `llms.txt`+`robots.txt`，`llms-full.txt`/`catalog.json` 从未落到根——这就是线上 404 的一半原因
- [x] 2.2 发布后自检：脚本末尾对四个根路径做 `curl -fsS` + content-type 断言（`text/plain` / `application/json`），任一不符即非零退出 —— 验证：故意删一个文件后脚本退出码非零且点名该路径
  - 实证：`deploy-plaza.sh` 新增 ③b：逐条 `curl -fsS -w '%{http_code} %{content_type}'`，断言 200 + 类型 + 非空 + body 不含 HTML 壳，任一失败 `exit 1`。单测 `scripts/test-plaza-machine-faces.mjs` → **2/2 绿**：①四件套逐字节等于 `generated/`；②缺 `catalog.json` 的包 → 落位 exit 1 且站点根上一版文件未动（原子性判据）
  - 附带修：`plaza-stage.sh` 里 `$f：`（变量名后接全角冒号）在 C locale 会把冒号字节吃进变量名 → unbound；统一改 `${f}`
- [x] 2.3 线上实测记录：`agent.finddatatech.cloud` 四路径 200、类型正确、`/llms.txt` 首屏可读 —— 验证：curl 输出贴进 tasks 实证行
  - 修复前（2026-11-09）：agent 四路径全 404；facet `/llms.txt`、`/catalog.json` **200 text/html**
  - **facet 侧修复已上线并复测通过（2026-11-10）**：`/llms.txt`、`/llms-full.txt`、`/catalog.json`、`/robots.txt` 四条全部 **404 `text/plain; charset=utf-8`**（不再软 200 HTML）；同时 `/api/packs` 仍 **200 `application/json`**，机器路径规则没有误伤 API 面
  - 为什么已在线上：生产镜像 `law-bench/platform:sha-deb4b87` 的源码基线是 `0e80d9a17`，而我的提交 `68db953e` **已是它的祖先**（`git merge-base --is-ancestor 68db953e 0e80d9a17` 通过；`facet/machine-paths.js`、`web/src/lib/boardTabs.ts` 两边**逐字节相同**）——这批改动已随既有出片上产
  - **plaza 侧已补齐（2026-11-10）**：`agent.finddatatech.cloud` 四路径复测全 **200**——`/llms.txt` `text/plain`、`/llms-full.txt` `text/plain`、`/catalog.json` `application/json`、`/robots.txt` `text/plain`，内容首行正确
  - 做法与根因：上机看 `/srv/agent-plaza-site` 里**只有 `generated/` 下有三份导出物，根目录一份都没有**（旧脚本只拷过 `llms.txt`，另两份从未落根）——正是任务 2.1 修的缺口。补的办法是 `plaza-stage.sh` 那段逻辑的原子子集（`.tmp` → `mv`），**没有重跑导出**，因此不会把 11-05 的旧快照再写一遍
  - 遗留：plaza 快照内容仍是 2026-11-05（市场已有 114 个包，快照 82）。要更新内容需要跑完整 `deploy-plaza.sh`（导出+落位+自检）或配 `PLAZA_DEPLOY_*` 让 `plaza-refresh` 定时档接管——那是任务 4.2

## 3. plaza 导出：计数唯一口径 + 可重跑

- [x] 3.1 `scripts/plaza-export.mjs` 的 `llms.txt` 抬头改为按物种枚举逐项计数（pack / skill / mcp / facade / data-anchor），删除「agents」合称 —— 验证：生成物里 `grep -c "agents" ` 为 0，且五个物种名各出现一次
  - 实证：`buildLlmsTxt` 改为 `Five species: N packs, N skills, N MCP servers (N public tools), N facades, N official data anchors`；分节也拆成 Packs / Skills / MCP servers / Facades / Official data anchors 五段（原来 Packs+Facades+Anchors 合成一个 "Agents (577)" 段）。`catalog.counts` 补 `facades` / `officialData` 两键，与 `counts.json` 的 byCategory 同源
- [x] 3.2 `catalog.json` 与 `llms.txt` 的同一物种计数相等，且与 `counts.json` 相等 —— 验证：新增断言脚本，三个来源逐一比对
  - 实证：断言并入 `scripts/test-plaza-export.mjs`（复用既有 fixture，不复制夹具）新增用例 `llms.txt reports every species separately and no merged total`：五物种计数与 `catalog.counts` / `byCategory` 逐一等值，且 `/\b\d+ agents\b/` 与 `## Agents (` 均不得出现
- [x] 3.3 `generatedAt` 同时写进 `llms.txt` 抬头与 `catalog.json` 顶层，取自同一次导出 —— 验证：两处时间戳逐字节相等
  - 实证：同一用例断言 `llms.includes("As of: " + catalog.generatedAt)`；两处都来自 `runExport` 里同一个 `generatedAt` 变量
- [x] 3.4 现有 G1/G2/G3 门禁在计数口径改动后仍全绿（不合规即不写盘） —— 验证：跑一次导出，故意篡改一个物种计数 → 导出失败且目录未被改写
  - 实证：`node --test scripts/test-plaza-export.mjs` → **17/17 绿**，其中既有 G1 对账红例（`count reconciliation gate: any species mismatch red, zero artifacts`、`G1 facade count mismatch fails the build with zero artifacts`）继续绿，红例仍断言 `catalog.json` 不存在
  - 附带修：既有断言 `deepEqual(r.counts, {packs,skills,mcpServers,tools})` 因新增两键而红，改为含 `facades: 0, officialData: 0`

## 4. 新鲜度：定时再生成

- [x] 4.1 在部署面新增定时任务调用同一 `deploy-plaza.sh`，并发策略不可重入，周期值写在清单里可审 —— 验证：清单可读，周期与并发策略明确
  - 决策变更（D2 落地形态）：任务原文写的是「GitOps CronJob」，实际改为 **GitHub Actions 定时档** `.github/workflows/plaza-refresh.yml`。理由：导出器只读 facet 的公开 HTTPS 接口（`/api/packs`、`/api/skills-catalog`、`/api/mcp-catalog`、`/api/facades-catalog`、`/api/data-anchors-catalog`），不需要集群内网；而落位目标在雷池机的 Caddy 静态目录，集群内的 Job 反而要额外持有同一把 ssh 私钥与仓库检出。db 定时档复用 `deploy-plaza.sh` 全链路（导出→打包→上传→原子落位→四路径自检），不另写发布逻辑
  - 实证：`cron: "17 2,10,18 * * *"`（日三次，避整点）、`concurrency.group=plaza-refresh` + `cancel-in-progress: false`（不可重入）；密钥只需 `PLAZA_DEPLOY_HOST` / `PLAZA_DEPLOY_KEY`，缺 host 时**主动失败**而不是空跑
- [ ] 4.2 首轮自动跑通：记录 job 成功实例与产物 `generatedAt` 前进一次 —— 验证：两次 `generatedAt` 相差一个周期，且市场新增条目出现在 `catalog.json`
  - **机制已换（2026-11-10 实做）**：GitHub Actions 这条路走不通——私有仓被计费挡住（派发后 job 不启动，注解 "recent account payments have failed or your spending limit needs to be increased"，run 42765681983），且 `workflow_dispatch`/cron 要求 workflow 在默认分支上，而镜像仓虽有 workflow 却没有 `deploy-plaza.sh`（EXCLUDE_PATHS 第 154 行）与 `site-plaza/`。改落 **cheap1 主机 cron**：`/opt/fd/plaza-refresh.sh`，`17 4 * * *`，不装 node（一趟 `docker run --rm node:22-alpine`），落位直接调仓里那份 `plaza-stage.sh`
  - 首轮实测（2026-11-10 06:06Z）：`plaza-export OK: 735 materials (packs 100 / skills 108 / mcp 26 / tools 789), stale=false`；外部四路径全 200（llms/llms-full/robots 为 text/plain、catalog 为 application/json）；线上 `generatedAt=2026-11-10`、`count=735`
  - 验收时钟（记死，别猜）：2026-11-10 06:50Z 记录基线 `generatedAt=2026-11-10`；下一轮 cron 为 **2026-11-11 04:17Z**（相距 21.4h）。届时判据两条：`/tmp/plaza-refresh.cron.log` 有输出、线上 `generatedAt` 前进到 2026-11-11。两条都成立即可勾这项
  - 环境依赖已排除（2026-11-10）：`systemctl is-active cron` = active；用 cron 的最小环境原样跑 `env -i /bin/bash /opt/fd/plaza-refresh.sh` → EXIT=0、四路径全 200、`plaza-export OK: 735 materials …, stale=false`。即这条不依赖我的交互 shell 的 PATH/HOME，定时那轮不会因环境差异失败
  - **未勾的原因**：验收要「两次 `generatedAt` 相差一个周期」，而 `generatedAt` 是日期→同日重跑值不变，须等 04:17 UTC 那一轮自跑才算；届时看 `/tmp/plaza-refresh.cron.log` 与线上日期前进一天即可
  - 备用通路已备（计费恢复即用）：私有仓 main 提交 `2c7489041`（补 `plaza-stage.sh`+`plaza-refresh.yml`）、Secret `PLAZA_DEPLOY_HOST`/`PLAZA_DEPLOY_KEY`、专用密钥 `~/.ssh/plaza_deploy`（注释 `plaza-refresh@github-actions-2026-11-10`，已授到 root@cheap1）
  - 阻塞：需先在仓库 Secrets 里配 `PLAZA_DEPLOY_HOST` / `PLAZA_DEPLOY_KEY`，并合并到默认分支后定时档才会调度
- [x] 4.3 失败可见：故意让导出失败一次，旧快照继续服务且时间戳不变（不发布半套） —— 验证：失败实例日志 + 线上时间戳未变
  - 已具备的机制：导出器 G 门禁失败即 throw 且**不写盘**（`writeArtifacts` 在门禁之后）；`plaza-stage.sh` 缺件即 exit 1 且不动站点根
  - **真实失败实例（2026-11-10，基址指向 `http://127.0.0.1:1`）**：
    1. 无 `--allow-stale` → **EXIT=1**、`fetch failed`、**写盘 0 个文件**
    2. `--allow-stale` 但输出目录无上份快照 → **EXIT=1**、`--allow-stale: no previous snapshot at … and the registries are unreachable (fetch failed)`
    3. `--allow-stale` + 有上份快照 → EXIT=0，回放 864 条，**`generatedAt` 保持旧值 2026-11-05**，`snapshot.stale = true`（诚实降级，不伪造新时间）
  - 线上时间戳全程未变（`generatedAt = 2026-11-05`、`count = 864`），因为测试只写 `/tmp`，没碰站点目录
  - 过程中自查出的坑：第一次用 `… | tail -8` 取 `$?`，拿到的是 `tail` 的 0 而非 node 的 1——**差点把"失败退出码 0"记成事实**。改为重定向到文件再读 `$?` 才拿到真值

## 5. CLI：不知道 id 也能走到 install

- [x] 5.1 `facet list` 读 `/api/packs`，输出 `id / name / version / category`，支持 `--base / --line / --limit / --json` —— 验证：`node --test facet/cli/test/list.test.js` 覆盖表格与 `--json` 两种输出，id 与 `install` 接受的形式逐字节一致
  - 实证：`facet/cli/facet.js` 新增 `listRun` / `fetchListing` / `printListing`；测试改为 `scripts/test-facet-cli-discovery.mjs`（跑真 CLI 子进程 + 本地 stub 目录，比单测函数更接近用户）：表格输出含 `id  v3  名称 · 线`，尾部给出 `install <id>` 且自部署时带 `--base`；`--json` 输出为服务端原始行（`rows[0].id` 与目录 id 相等）
- [x] 5.2 `facet search <query>` 复用市场查询语义，支持同上开关 —— 验证：`search 合同 --line lex` 只返回该线命中项；空结果输出显式「无匹配」而非空表
  - 实证：同一测试文件 `search` 用例：命中只出 lex 项；无命中输出 `无匹配：<base> 上没有匹配「…」的功能集`，且**不打印 install 提示**
- [x] 5.3 上游不可达：报出尝试的 base 与原因，且不打印半截目录 —— 验证：指向 `http://127.0.0.1:1` 跑 `list --base`，退出码非零、输出含该 base
  - 实证：`fetchListing` 捕获后抛 `目录不可达：<base>（原因）——未打印任何半截目录`；用例用一个已关闭端口验证退出码非零、输出含该 base、不含任何目录行
- [x] 5.4 `help` 与 `#/docs` 的命令表同步新增两条子命令（单一来源在 `cliFacts`） —— 验证：`facet help` 输出含 `list`/`search`，且 `DocsView` 渲染同一文本
  - 实证：USAGE 增两条用法行 + 一段子命令说明；`facet/web/src/cliFacts.ts` 增 `FACET_LIST_COMMAND` / `FACET_SEARCH_COMMAND`；`scripts/test-facet-docs-facts.mjs` 新增用例断言两个常量**确实对应 CLI 会分发的子命令**（`opts.command === "list|search"`）且 help 里有对应行——常量指向死命令即红
  - 差额（明记，不静默缩小）：`#/docs` 安装段的视觉编排（把 list/search 插进「找包→装」动线）未做——那是 UI 面，属 ②/市场收口那一批，需 locales 五语与 impeccable 流程
  - 补（8.2 收口时发现）：CLI 的**用户手册** `facet/cli/README.md` 原本没有 `list`/`search`，也没有 `update` 的来源市场说明——已补两节（含「目录不可达时点名地址、不打印半截目录」「自部署装的不被换成官方同名包」两条口径），否则功能只有 `--help` 里能看见

## 6. CLI：自部署不被带回官方市场

- [x] 6.1 `install` 把解析后的 base 写进 `installed.json` 的每条记录 —— 验证：`--base X` 安装后 `cat ~/.facet/installed.json` 含该 base
  - 实证：`install` 的 `recordInstall` 增 `base` 字段；用例断言 `recs.installs[0].base === <stub base>`
- [x] 6.2 `update` 按记录解析 base（显式 `--base` > 记录 > 官方），逐包报告实际来源 —— 验证：装自自建源后再 `update`，抓包里无官方域名请求（stub 断言）
  - 实证：`parseArgs` 增 `baseExplicit`；`update` 逐包解析 `opts.baseExplicit ? opts.base : rec.base || DEFAULT_BASE`，并打印 `来源 …（--base / 随记录 / 记录无 base，默认官方市场）`。用例把官方基址指到一个死端口，再跑无参 `update`：**成功**且 stub 收到请求、输出含「随记录」——若回落官方就会失败，所以绿灯本身是证据
- [x] 6.3 旧记录（无 base）回落到官方并在报告中明说 `base 默认` —— 验证：手写一条无 base 的记录，`update` 输出含该提示
  - 实证：用例手写 `{installs:[{…无 base…}]}`（注意记录文件形状是 `{installs:[…]}`，不是裸数组——第一版测试按裸数组写，CLI 读成"无记录"，是测试自己的错），断言输出含 `记录无 base` 与 `默认官方市场`
- [ ] 6.4 发版：走 OIDC trusted publishing 出 `@finddatatechnology/facet` 新版本 —— 验证：`npm view @finddatatechnology/facet version` 为新值，且 `npx ... facet list` 在干净 home 下可用
  - 阻塞（2026-11-10 查清，非权限而是血缘）：版本已 bump 到 0.4.0，trusted publisher 注册在 `FindDataTechnology/platform`·`facet-cli-publish.yml`，但那个仓 HEAD `204033005` 里 CLI 仍是 0.3.0、无 `list`，本批提交在该仓 `422 不可达` → tag 发不出 0.4.0
  - **2026-11-10 用户裁决：暂缓**——第 2 步（推公开仓 main）与第 3 步（打 tag 发 npm）一律等确认，期间不得动公开仓。执行序/回滚锚点/版本占用风险见 `docs/handoff-last-four-steps.md` 的「⏸ 执行闸门：暂缓」一节
  - 先决：公开快照要从**含本批提交的线**（生产线 `0e80d9a17` 或更新）重出，之后才能打 tag；重出是发布动作，需点头
  - 明记的禁路：本机 `npm whoami`=`finddatatechonology`（有发布权），手工 `npm publish` 能成，但**不带 provenance** 且会永久占住 0.4.0 版本号，之后 OIDC 再也补不上出处——不走

## 7. 文档：死链与自部署形态

- [x] 7.1 把 `docs/ecosystem/client-matrix.md` 同步到公开仓（与既有六份 guide 同目录） —— 验证：公开仓该路径 200
  - 实证：**本就已在公开仓，且与本地逐字节相同**——本地 `git hash-object` 与公开仓 blob sha 同为 `1eadea34`（6817 B），`blob/main` 与 `raw` 均 200。原先「公开仓 404」的判断是错的，起因是这份文件在 `make-public-snapshot.mjs` 的 `EXCLUDE_PATHS`（第 236 行）里，被误读成「没发布」
  - 已核对另两条深链同样 200：`docs/creating-packs.md`、`docs/ecosystem/skill-market-registration.md`
  - 差额（明记）：该文件被排除是**故意**的（第 232-233 行注释：文内含私有仓名作发布门判据），所以公开副本**冻结在排除之时**，以后改本地这份不会自动同步——这是静默分叉，另案见 `docs/handoff-last-four-steps.md`
- [x] 7.2 删除 `DocsView.tsx` 里 no-op 的 `.replace(/client-matrix\.md$/, "client-matrix.md")`，改由 `cliFacts` 单一来源产出矩阵链接 —— 验证：渲染出的 href 与 `cliFacts` 常量相等
  - 实证：`cliFacts.ts` 新增独立常量 `FACET_CLIENT_MATRIX_URL`（注释里点名它取代的那个 no-op 表达式）；`DocsView.tsx` 改为 `href={FACET_CLIENT_MATRIX_URL}`。反证：把 no-op 写法塞回去 → `scripts/test-docs-links.mjs` 的「matrix 单独常量 + 无 no-op replace」那条**转红**，恢复即绿
- [x] 7.3 `#/docs` 安装段并列展示官方与自部署（`--base`）两种命令 —— 验证：断言页面文本含 `--base`
  - 实证：每个客户端安装卡在官方命令下新增 `docs-install-selfhost-<target>` 一行，渲染 `${FACET_INSTALL_COMMAND} <packRef> --target <t> --base <your-facet-url>`；文案 `facetDocs.install.client.selfHost` 五语齐备（注意：facet 壳的文案在共享的 `web/src/locales/*`，不在 `facet/web/src/locales`——写错路径会静默不落盘）。`scripts/test-docs-links.mjs` 断言该形态存在
- [x] 7.4 链接存在性测试：docs 视图发出的每个深链路径都要在公开仓存在（在线查树，离线回落到签入的镜像清单） —— 验证：新增 `scripts/test-docs-links.mjs`，故意指向不存在路径 → 红
  - 实证：`scripts/test-docs-links.mjs` **4/4 绿**。判据是「链接指向的文件在不在」而不是「字符串长得对不对」：目标集从 `cliFacts` 的客户端表读出（六份指南一份不缺，`docs/ecosystem/` 是公开仓的镜像来源），再加矩阵指南、creating-packs、自部署一栏三条。反证两条已跑（no-op 表达式回归 → 红；缺指南 → 同一用例点名）

## 8. 收口

- [x] 8.1 `openspec validate fix-supply-machine-faces --strict` 绿 —— 验证：命令输出 `is valid`
  - 实证：`Change 'fix-supply-machine-faces' is valid`
- [x] 8.2 `npm run typecheck` + `npm run lint` + `npm run check:locales` 绿 —— 验证：三条命令退出码 0
  - 实证：typecheck 干净；biome 对 `facet/web/src/{DocsView.tsx,cliFacts.ts}` 零 finding；`check:locales` → `all 5 locales OK`（新增 `facetDocs.install.client.selfHost` 五语非空）
- [x] 8.3 线上走查表：四 root 机器路径（plaza 200 / facet 404）、`#/docs` 矩阵链接可达、`facet list/search` 各一次真实输出 —— 验证：逐条贴输出
  - **四机器路径（2026-11-10 实测，两宿主对照即契约本身）**：
    ```
    facet  llms.txt       404 text/plain; charset=utf-8
    facet  llms-full.txt  404 text/plain; charset=utf-8
    facet  catalog.json   404 text/plain; charset=utf-8
    facet  robots.txt     404 text/plain; charset=utf-8
    agent  llms.txt       200 text/plain; charset=utf-8
    agent  llms-full.txt  200 text/plain; charset=utf-8
    agent  catalog.json   200 application/json
    agent  robots.txt     200 text/plain; charset=utf-8
    ```
    即：**拥有机器面的宿主给文件、不拥有机器面的宿主给 404**，两条都不是软 200 HTML。另测 `facet/api/packs` → `200 application/json`，证明拒答清单没有误伤 API 面
  - `#/docs` 矩阵链接可达：客户端 `FACET_CLIENT_MATRIX_URL` 已替代 no-op 表达式（`e2e`/单测钉住）；公开仓那份**本就存在且字节相同、返回 200**（详见 7.1 实证——此处原写「线上 404 依赖公开仓镜像、仍是待办」，是误读，2026-11-10 订正）
  - `facet list/search` 真实输出：CLI 0.4.0 已备（`facet/cli/package.json`），**但要 `npx` 拿到新版必须先发 tag（6.4）**；已用本地 `node facet/cli/facet.js list --base …` 与 stub 目录验过（`test-facet-cli-discovery.mjs` 5/5，覆盖表格/`--json`/`--line`/不可达点名地址）
