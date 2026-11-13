# Tasks — add-pack-memory-declaration

> 每条带**可失败的验收**。纪律：不写「完成某文件」，写「某命令／某观测给出某个值」；新守卫先证明能红。
>
> 前置：仓库根 `add-agent-memory-declaration` 已实施（`fd-agent-graph` 281 条、`fd-memory` 244 条测试绿，共享 fixture 已就位）。本变更**只消费**那份语义。
>
> 每阶段合入前跑：`npm test`（按既有分批约定，40 文件一批）。

## 0. 开工前置

- [x] 0.1 确认 paas 是不是活线 — 立变更时：HEAD `a312e5e3d`（13:02），66 个已修改跟踪文件（他人未提交）。**实施期间复测（11-12 18:28）**：HEAD `c09d2905c`（我自己的提交链），262 个已修改跟踪文件 + 一批他人未提交的新文件（`server/fleet-plugins.js`、`lib/pack-plugins.js`、`lib/console-blocks-spec.js` 等）。结论：**这是一棵长期活线**，按 `AGENTS.md` 协定第 1、3 条办——只 `git add` 自己改／新增的文件、不用 `-A`、不 rebase／reset、不在他人未提交的文件里塞改动。实测被这条协定挡住的文件：`server/routes/fleets.js`（16:48）、`server/routes/packs.js`（16:25）、`web/src/**`
  - **11-12 夜一次真实事故（已发生，如实记）**：给 5 个 locale 文件加 `memory.policy.*` 时用了 `json.loads → json.dumps(indent=2)` **整文件重写**，把邻会话当时**未提交**的 `zhiyu.event.route_*` 等键一并带进了我的提交（每份 +410/−2）。内容没丢（同一份文档原样序列化，键值全在，文件现已干净、对方下次 `git add` 不会回退我的），但**归属错了，且我改动了不该由我提交的 hunk**。
  - **规则**：改共享 locale 一律**定点插入**（按行插入 + `python3 -m json.tool` 校验），**永不做整文件 dump 重写**；提交前 `git diff --cached --stat` 的增行数必须与「我加的键数」量级相符，否则先看 diff 再提交
- [x] 0.2 基线 — 「不多于基线」口径。**影响面复核（11-12 收工时）**：查 `pack-memory|pack-manifest|knowledge-profile` 得 46 份套件，逐文件 `timeout 180 node --test`（单进程整跑会互相污染，`test-agent-serving` 已知挂死）：**42 绿 / 3 红 / 1 挂**。
  - 三红逐条归因，**均在本变更 diff 面之外**（不是「看起来无关」）：
    - `test-agent-studio.mjs`：断言 `navigate(\`/studio?doc=…replace: true\``，而 `web/src/pages/AgentStudioPage.tsx` 已重构成 `go(…)` 包装（第 110 行 `navigate(to, opts)`）——测试滞后于该文件的重构，与被改文件无交集（本变更没碰 `web/src`）
    - `test-trading-fleet-consistency.mjs`：断言 `openspec/changes/add-price-supply-and-caliber/tasks.md` 的卡点表覆盖全部未完成项，实测多列了已完成项——另一个变更的文档
    - `test-official-locale-gate.mjs`：**这条触及我改过的 `lib/pack-manifest.js`**，故直接复算而非推断——对 `docs/fleet-templates/personal-staff-fleet.seed.json`（他人**未跟踪**的新文件）调 `validatePackManifest()`，顶层键 `name,version,description,agents,fleet,i18n`、**无 `memory` 键**、agent 上**无 memory_* 键**，唯一错误 `i18n_must_carry_at`（i18n 为空对象），来自 HEAD 里既有的 `validateLocaleOverlay`。即记忆接线贡献 0 条
  - 本变更自身 7 套件全绿：`test-pack-memory-declaration` / `test-memory-vocabulary-parity` / `test-pack-memory-noop` / `test-pack-memory-policy` / `test-knowledge-profile-noop` / `test-knowledge-profile` / `test-memory-read-axis`（合计 93 条）
  - **整仓基线已跑（11-12）**：`scripts/test-*.mjs` 共 **610 份**，`xargs -P 4` + 每文件 `timeout 120 node --test --test-force-exit --test-timeout=60000`，解析 TAP 的 `ℹ tests/fail/cancelled` 落 TSV。结果 **tests=5322 / fail=33 / 28 份文件非零退出**：
    - **7 份 rc=124（挂死）**，与既有台账一致：`test-agent-serving`、`test-deploy-harness-gate`、`test-deploy-lock`、`test-deploy-tenancy`、`test-deployment-secrets`、`test-opening-gates`、`test-platform-billing`
    - **3 份并发假红**，串行复跑转绿（`test-agent-serving-asks` / `test-cell-gateway` / `test-queue-staleness`）
    - **`test-fleet-memory.mjs`：4 过 / 3 `cancelled`**，消息是既有的 `Promise resolution is still pending but the event loop has already resolved`。**不是本变更**：它的被测模块 `server/fleet-context.js` 不 import 我改过的任何文件，测试自身也只 import `node:test`/`node:assert/strict`
    - **`test-tool-posts.mjs` 串行复跑 8 过 0 失败**（首轮 rc=1 是退出码假象）
    - **余 16 份真红，全部在本变更 diff 面之外**（判据是文件交集，不是观感）：13 份不引用我的任何模块；引用到的 3 份逐条看过——`test-agent-studio.mjs:46` 是**否定断言**（「web 代码不得 import `lib/pack-manifest`」），`test-trading-fleet-consistency.mjs:12` 是另一个变更的「不行动条件」三面计数测试（`docs/wire-presets/pack-manifests/wire-invest-trading.json`，路径根在 finddata 根而非 paas），`test-official-locale-gate.mjs` 已直接复算（他人未跟踪 seed 无 `memory` 键，唯一错误 `i18n_must_carry_at`）
- [x] 0.3 复述词表边界 — 逐字抄自根仓（每个取值后面是它的真源行，改词表时按这一列核对）：
  - `store.home` = **`fleet` / `member` / `person`**（`memory_decl.py:38 STORE_HOMES`）——**三个，不是四个**；早期笔记写「三值」是对的，本项目曾有人按四轴数量误记成四值
  - `read.scope` = **`shared` / `own+shared` / `off`**（`memory_decl.py:52 READ_SCOPES`）——**三个，`own` 已被删除**（`narrow-memory-read-scope`：yongyi-client 的 readDigest 只对 `own+shared` 分支，`own` 会多读 shared）。注意根仓没有 `enabled`：那是 paas `knowledge.memory` 的旧拼写，等价于 `scope: off`
  - `write.authority` = **`private` / `shared`**（`binding.py:24-26 MEMORY_PRIVATE/MEMORY_SHARED`，`memory_decl.py:251` 用它校验）——值域与 `read.scope` 重叠，这正是「同一个词两个轴」的历史病根
  - `process` 三键 = **`distill` / `promote_after` / `cold_after_days`**（`memory_decl.py:69 AXIS_KEYS`）；`distill` 取值 **`on` / `off` / `inherit`**（`:60-63`），其中 `inherit` 不是值而是「继续往上找」
  - `read.budget` 界 = **64..2000**（`:78-82 BUDGET_MIN/MAX`，上限即 fd-memory /digest 的 clamp）
  - `EXECUTED_SUBKEYS` = **`store.home` / `read.scope` / `read.budget` / `write.authority` / `process.distill`**（`:92-100`）——`promote_after`、`cold_after_days` **不在**其中（无消费方），读面必须如实标未执行
  - `PLATFORM_DEFAULTS`（`:66-75`）= `store.home:"fleet"`、`read:{scope:"own+shared",budget:1200}`、`write:{}`（**无默认**：谁的结论算数不由平台代答）、`process:{distill:"on",promote_after:3,cold_after_days:0}`
  - **注**：任务原文写「`read.scope` 四值」是笔误（当时以为含 `own`），实测为三值；本行按文件更正，不以任务描述为准

## 1. 形状校验（只读，不落地）

- [x] 1.1 四轴形状校验 — **落在 `lib/pack-memory.js`（纯模块，零 import）**，与 `lib/pack-plugins.js` 同款做法。`scripts/test-pack-memory-declaration.mjs` 24 条：四轴合法值全过；未知轴/未知子键/寻址四形态/预算越界/authority 收位置值/`own` 各以**具体错误码**拒收且带出错键路径；一次报全部问题（4 条一起）
  - **已接线**（`14943a48d`）：import + 顶层 `memory` 段 + 每 agent `validateAgentMemory` + `knowledge.memory` ↔ `memory.read` 一致比对。接线前先把三处改动打进 `/tmp` 的 `lib/` 副本，用 10 个用例验过（无声明 / 四轴合法 / 地址 / own / 未知轴 / 冲突 / 一致 / guidance-only / axes-only / scope 冲突），再落真文件
- [x] 1.2 `agents[].memory` 同一份校验 — `validateAgentMemory()` 复用 `validateMemoryBlock()`，只是前缀不同；测试断言 agent 级错误带 `agents[3].memory.store.home` 路径
- [x] 1.3 `memory_scope` 作为 `write.authority` 简写 — 冲突时 `memory_authority_conflict` 并同时指名两个值；一致时通过；简写取值非法时 `memory_scope_invalid` 带 `agents[N].memory_scope` 路径
- [x] 1.4 `guidance` 与 `authority` 互不替代 — **接线期抓到一个真冲突**：`agents[].memory.guidance` 是 `add-agent-self-iteration` 的既有功能，我的校验器会把它当未知轴拒掉，等于打断所有存量 pack。修法：`AGENT_MEMORY_EXTRA_KEYS = ["guidance"]` + `validateMemoryBlock(raw, at, {extraKeys})`，**只在 agent 级**放行（pack 级的 guidance 没有消费方，仍拒）。端到端四例：guidance-only 通过 / axes-only 通过（旧规则要求 guidance，会让四轴块无法单独使用）/ guidance+axis 通过 / 超 600 字拒
- [x] 1.5 跨仓 fixture 复用 — 两条用例读同一份 `fd-memory/fixtures/memory-policy-cases.json`：所有被解析器接受的文档这里也必须接受（含 deployment 默认），所有被拒的文档这里也必须拒且**指同一出错键**。**注入对照已做**：把 `own` 加回 `READ_SCOPES` → 2 条变红（22 pass / 2 fail），还原后 24 pass

## 2. 等价归一并跑通继承

- [x] 2.1 `knowledge.memory` ↔ `memory.read` 等价判定 — **已完成**（`server/knowledge-profile.js` + `scripts/test-memory-read-axis.mjs` 18 条）：两拼写逐键比对，不一致拒收 `read_memory_conflict` 并指名两处路径；只一处提到某键不算冲突；`enabled:false` ↔ `scope: off` 双向归一，矛盾组合一律解析为 off
- [x] 2.2 继承链 agent → pack → 部署默认 — `describeKnowledgeProfile({ agentMemory, cellDefault, deploymentOverride })`：链序 `agent → deployment → cell → platform`（词与根仓不同，顺序一一对应）。agent 层**逐键**、knowledge 段**整段替换**，两条规则共存且各自如实上报；agent 声明在 wholesale 替换中幸存（per-key 层在 wholesale 对之上）。**注入对照**：把 agent 层从生效值计算里去掉 → 2 条变红（19/2），还原 → 21/21
- [x] 2.3 存量零改动 — **差分验证**（`scripts/test-knowledge-profile-noop.mjs`，5 条）：从 git 重建变更前的 `server/knowledge-profile.js`（`82a9019d0^`，`read` 拼写与四列面引入之前），对 17 份只写 `knowledge.memory` 的存量声明**比对「物化出什么」**。
  - 判据不是「profile 对象相等」而是**消费方能看到的那一段**：唯一生产消费方 `server/fleet-context.js:584` 只用 `scope !== "off" && (memory.enabled ?? true)` 与 `budget`，故把这四项算成 `injects/scope/budget/collections` 逐字节比。`scope` 仅在真注入时才算数（不注入时下游根本收不到它）
  - 另有一条更强的断言：profile 全字段比对，**差异只允许出现在 `enabled`/`scope` 这一对**上——其余字段（budget、collections、错误码）有任何变化即红
  - **实测出的一处有意归一**（单独一条用例记录，两个方向都验）：`{enabled:false}` 旧解析成 `scope:"own+shared"`、`{scope:"off"}` 旧解析成 `enabled:true`。现在任一写法都关闭另一边。**在该消费方处 inert**（它本来就同时检查两者，半开关的画像早就不注入），收益是存储里不再有两种互相矛盾的「关」；用例里顺带断言了 inert（两侧 `injectionView` 深度相等）
  - **注入对照**：把默认 budget 1200 改成 1400 → 4 条变红（1/4）；插一行注释（无行为变化）→ 仍 5/5。判据对噪声不敏感、对行为敏感

## 3. 读面：四列 + executed

- [x] 3.1 `server/knowledge-profile.js` 增四列输出 — **读轴已完成**：`describeKnowledgeProfile()` 返回 `declared / inherited_from / effective / executed`，另加 `shadowed_by`（整段替换顶掉声明时）；`EXECUTED_READ_KEYS` 只含 `scope`、`budget`（本仓唯一消费方是 fleet-context 注入梯子），process 轴的 executed 仍待 pack 声明面落地后由根仓语义透传
- [x] 3.2 坏声明不回落 — 两条轴都已验：
  - **读轴**：`describeKnowledgeProfile({read:{scope:"nonsense"}})` 返回 `ok:false` 且 `rows` 为 `undefined`（不留一张填满默认值的表，那会被读成「一切正常」）
  - **process 轴**（`fd-memory`，提交 `fb2e98b`）：写入面会拒坏文档，所以坏行只可能来自带外（旧版本/手改/恢复）。**先实测再有代码**——直接往存储写 `{distil:"off", promote_after:"lots"}` 后读面报 `rows.distill.effective="on"`（意图消失）与 `rows.promote_after.effective="lots"`（不可解析却被当生效值），正是规格禁止的两条。修法：`normalizePolicyPartial()` 保合法键、只丢非法键；读面给**两个标记**——未知键无行可挂，只能进顶层 `stored_invalid`（level+key+code+message）；值非法会进到行里，故行上带 `invalid`，其 effective 不可被当成生效值。健康行不带标记（噪声检查单独断言）
  - **注入对照**：把读面的校验摘掉 → 该用例变红；还原 20/20、fd-memory 全仓 249/249。`resolvePolicy` 刻意未动（调度器与共享 fixture 逐字节依赖它），上报只在建表处做
  - paas 读面 `...doc` 透传，`stored_invalid` 无需第二处改动即可到 console（路由套件 7/7）
- [x] 3.3 未执行子键明示 — **行计算已完成**（`lib/pack-memory.js` 的 `memoryRows()` / `unexecutedMemory()`，算法逐行镜像根仓 `memory_decl.resolve_effective`，不在这里另发明一套）：七个子键各一行四列；`cold_after_days: 90` → `declared=90, effective=90, executed=false` 且进 `unexecutedMemory()` 清单；`distill: off` → `executed=true`；`distill: "inherit"` 当作「继续往上找」而不是一个取值（落到下一层 `deployment`）。
  - **判据落在共享 fixture 上**，不落在「我认为该是这样」上：`check-memory-vocabulary-parity.mjs` 第 5 段把 4 个 fixture 用例的 `expect` 行与 `not_executed` 逐字段比对（16 条断言），与 Python / TS 两份实现吃的是同一份契约
  - **两次注入对照**：把 `inherit` 当普通取值 → fixture 用例与直接探针同时变红；把 `executed` 恒为 true → 11 条 divergence、exit 1（正是本变更要防的「声明冒充生效」）；还原后 exit 0
  - 未覆盖：HTTP/UI 承载（3.4 与 4.x 的读面路由），均需 `server/routes/packs.js` / `fleets.js` / `web/src` 解封。**当前 `memoryRows` 的生产消费方只有这条 CI 闸门**，接线路由落地后才算真正挂上
- [x] 3.4 管理面渲染 — **落在干净文件里**：四列表加进既有的部署者记忆抽屉 `web/src/components/fleet/MemoryDrawer.tsx`（它本来就有 `packId` 与 `d-<pack>` 上下文）+ 客户端 `web/src/api/memory.ts` 的 `getPackPolicy()`，**没有碰那 27 个脏的 web 文件**
  - 面板默认折叠：抽屉的主职是看条目，声明是偶尔查的表
  - 四列 `子键 / 声明值 / 继承来源 / 生效值`；`executed=false` 挂琥珀色「未执行」徽章（否则声明会被读成生效）；带外坏行：值解析不了→行上红徽章（`title` 给完整原因），未知键→顶行 `stored_invalid` 清单（它没有行可挂）
  - 作用域行显式写「同一 pack 落地出的所有团队共用这一份」，防被读成「只影响本合同」
  - **e2e 4/4**（`e2e/fleet-memory-policy.spec.js`）：四列表头齐、distill 行四格且三列有值、未执行/坏行/未知键各自可见、390px 下不溢出
  - **e2e 抓到一个真实布局缺陷**：`policy_cold_after_days_invalid` 这类下划线串无断点，把表格在 390px 下顶出 **107px**；修法是值列 `min-w-0 + block truncate`、徽章 `inline-block max-w-[6rem] truncate align-middle`。**修完 4/4——不是放宽判据**

## 4. 落地：process → 团队记忆策略

- [x] 4.1 团队物化写 policy — **已落地并接线**（`6be1f8730`）。落地点实测是**干净的** `server/fleet-provisioner.js`（`createFleet({sourceTemplate:{packId}})` 处，且 manifest 已在参数里），因此没有碰邻会话的 `fleets.js`
  - 编译层：`lib/pack-memory-policy.js` 的 `compilePackMemoryPolicy()` + 7 条用例：根键按 pack（同一 pack 两个所有者算出**同一次写入**）；只写被声明的子键（平台默认不物化）；空声明 `empty: true` 即**不许写**（`/policy` 里空文档=清除，会把同根兄弟团队的策略删掉）；pack id 含 `/`／`.` 或超长即拒；其它三轴校验但不进文档
  - 写入层：`server/pack-memory-policy-landing.js` + 6 条用例（`scripts/test-pack-memory-landing.mjs`）。三条刻意的选择：**用 `d/<pack>` 的 pod 令牌**（不是 platform 令牌——后者能写到任何根，D9）；`manifest.memory` 编译不出东西时**什么都不写**；每次失败 **degrade-open** 且把原因放进返回值
  - 接线：provisioner 末尾 `deps.syncMemoryPolicy ?? landPackMemoryPolicy`，结果放进返回值的 `memoryPolicy`（**上报不抛出**：落地团队不能因为记忆服务不可达而失败）。两条 provisioner 用例钉住「调用了」与「失败不外溢」；注入「落地不再调用」→ 两条红，还原 24/24
  - **注入对照**：把平台默认物化进文档 → 4 条红；改回声明顺序保存 → 1 条红；还原 7/7
  - **编译产物已被接收方认可**（`check-memory-vocabulary-parity.mjs` 第 6 段）：直接 import fd-memory 的 `dist/policy.js`，比对 `PROCESS_KEYS`，并把编译器枚举出的 6 份文档喂给 `normalizePolicy()`，要求**被接受且逐键不变**。注入「文档里多一个拼错的键」→ 4 条拒绝、exit 1。缺产物时**显式 skip 并计数**（不是静默绿）——闸门里「悄悄没跑」和「跑过了」必须可区分
  - 未完成：PUT `/policy` 本身。**写授权已有答案**（design D9 已按实测修正）：`agent-runner/manager.js:1111` 今天就在为每个 pack 铸 `d/<pack>` pod 令牌并挂写能力的 MCP 面——写 policy 不是新特权，是同一把钥匙。写入路径 = 编译 → 空则不写 → pod 令牌 `PUT /policy?scope=root`，写前 `isSamePolicyWrite()` 比对读回值。调用点仍待 `server/routes/fleets.js`
  - 验收原文（`GET /policy` 读回 declared/inherited_from）需写入层 + 记忆服务实测，仍待
- [x] 4.2 幂等 + 归档清理 — **三处都已验**（归档清行见末条）：
  - **文档级**（paas）：`isSamePolicyWrite()` + 「固定键序」用例——同一 pack 两次编译序列化逐字节相同（键序重排会被读成一次变更、把 `updated_at` 这唯一的审计痕迹刷掉）
  - **行级**（fd-memory，`src/test/memory-policy.test.ts`，全仓 248/248 绿）：`PUT /policy?scope=root` 同一份声明连落两次 → **仍是一行、内容不变**；再落一份**改过**的声明 → 该行被替换（一个永不更新的路由也能满足「同输入同内容」，所以必须成对断言——注入 `ON CONFLICT DO NOTHING` 时，只写前一半的版本是绿的）；`process: {}` → `cleared: true` 且行消失，pack 的行不会随生命周期累积
  - **归档清行已接**（`68fab96f0`）：挂点在**干净的** `reconcileFleet`（归档后必被调用、dep 可注入），4 条用例。**任务原文的判据按实测改写了**——策略行按 **pack** 键，一个所有者归档不能关掉同 pack 另一个所有者的团队，所以规则是「**该 pack 上最后一支活团队离开时**才清行」，不是「团队归档就清」。注入「无视兄弟团队一律清」→ 该用例红；还原 4/4、reconcile 相关 8 套件 86/86
  - 仍未做：**来源 pack 被卸载**时的清行（卸载本身在 `server/routes/packs.js`，未接；现有规则是「最后一支活团队离开」即清，卸载路径按同一函数接上即可）
- [x] 4.3 **读面已挂上生产 + 执行方已实测**（写侧属 4.1，仍未通）— `GET /api/memory/policy?packId=`（`server/routes/memory.js`，6 条用例 `scripts/test-memory-policy-route.mjs`）：透传 fd-memory `/policy` 的四列 + `not_executed` + `deployment_default`，并加 `policy_root` 与 `scope: "pack"`。三条被测试钉住的边界：**只收 `packId`、根键由 `packMemoryRootKey()` 推出**（调用方可传 `rootKey` 但不会被读，注入「信任调用方 rootKey」→ 1 红）；**要求已登录**（比邻居 `/deployer-entries` 更严：新面不该比既有面宽）；坏 packId 在**任何上游调用之前** 400（查询 6 种形态，seen=0）。第二处注入：删掉 `policy_root`/`scope` 标注 → 1 红
  - 这也让 `packMemoryRootKey()` 从「只有测试用」变成生产在用（此前它和 `compilePackMemoryPolicy()` 一样是待挂载代码）
  - **一条真 HTTP 用例**（同一套件第 7 条）：express 真端口 + 另一端口上的 mock fd-memory，让 query string、`Authorization`、JSON body 真的过一遍 socket。注入「路由改名 `/policy`→`/policies`」→ 7 条里 6 条红（假 app 用例按路径取 handler，自然是红）——这条用例的价值是抓住「注册在一个 app 从不服务的路径上」这类接线错
  - **可达性已核**（防「路由注册了但到不了」）：`gateway/index.js:1381` 的 catch-all 对任何未匹配请求先 `resolveUser` 再 `dispatchToCell`，`/api/memory/policy` 不需要加进任何白名单；cell 侧 `server.js:462 registerMemoryRoutes(ctx)` 在静态兜底之前挂载。两道身份门（网关 + 本路由自己的 401）叠着，新面不会比既有的宽
  - **执行方已实测（fd-memory 侧，`src/test/memory-policy.test.ts`，全仓 247/247 绿）**：团队坐标 `d-<pack>` 的根策略 `distill: off` → 调度器**不调用 `/distill`**、`distill_state` 游标不动；删掉这一行 → 立刻恢复蒸馏（4.4 的回退＝一行数据，不发布）。另有用例钉住「项目策略可以打开根关闭的」。
    - **顺带纠正任务原文的一处不可表示前提**：原文①「部署默认 off + 团队声明 on」对团队根**不成立**——`deploymentDefaults()` 里 `FD_MEMORY_DISTILL_U` 只作用于 `u-` 根（"fleet roots have always distilled"），`d-` 根的部署默认恒为 on。用户的测试文件头也这么写，已一并改掉。这恰恰是本变更对团队的意义：在此之前团队想关蒸馏**没有任何表达方式**。
    - **注入对照**：让 `distills()` 忽略策略层 → 4 条红（含新增的团队用例），还原 → 18/18
  - 仍未做：4.1 写入层（paas 把编译结果 PUT 到 `/policy?scope=root`），故「pack 声明 → 策略行」这一段端到端仍未通
- [x] 4.4 回退 — **机制已实测，触发方待接**：
  - 清行即回退（fd-memory `src/test/memory-policy.test.ts`）：`deleteMemoryPolicy("root")` 后同一 root 立刻重新按部署默认决定——团队根恢复蒸馏、`u-` 根恢复 `FD_MEMORY_DISTILL_U=0` 的 off。不需要改代码、不需要重启
  - paas 侧的回退信号已定义：撤销声明时 `compilePackMemoryPolicy()` 返回 `empty: true`，调用方据此**不写**（而不是写 `{}`——空文档在 `/policy` 里是清除语义，会顺手删掉同根兄弟团队的策略）
  - 仍未接：谁在「团队归档/卸载」时发起清行。那是 4.2 的归档清理，落在 `server/routes/fleets.js`（他人活线）

## 4.5 三方一致性闸门

- [x] 4.5 一条命令证明三处实现同词表 — `scripts/check-memory-vocabulary-parity.mjs`：词表六项逐项比对（读取真实 Python 模块，不在本仓复述第四份）、fixture 双向（8 份被接受 / 5 份被拒且指同一键）、pack 面与注入面 enum 相等、`own` 两面都拒。**两次注入验证**：根仓加回 `own` → 1 条 divergence、exit 1；paas 关掉地址检查 → 4 条 divergence、exit 1
  - **过程中抓到的假绿**：fixture 里没有 `store.home` 用例（两个解析器没有 store 轴，存储由身份解析），所以把地址检查改成 `if (false)` 时闸门**仍然全绿 exit 0**。补了 8 条直接探针（地址四形态 / own / 预算 / authority / 拼错键）后同一注入变 4 red

## 5. 兼容与收口

- [x] 5.1 不声明 `memory` 的 pack — **差分验证**（`scripts/test-pack-memory-noop.mjs`）：从 git 重建「接线前」的校验器（`git log -S validateMemoryBlock` 定位引入提交，取其父版本 `git archive` 到临时目录），与当前校验器对 16 份覆盖 skills/mcp/agents/bots/guide/tags/category/visibility/notes/禁用词的清单**逐条比对错误形状**，要求完全相同。
  - 电池有效性单独断言（≥4 份必须报错）——全绿的电池证明不了任何事
  - **注入对照**：把顶层 `memory` 校验关掉 → 第 3 条「声明 memory 只增不减」变红（3/1），还原 → 4/4
  - **实测出的一处有意收紧**（单独一条用例记录）：`agents[].memory_scope` 在 paas 侧此前**零消费方**，`memory_scope: "team"` 这类脏值可以照常发布；现在它作为 `write.authority` 的拼写被校验，值非法即 `memory_scope_invalid`。接受这次收紧的理由：否则就是一个任何地方都不会生效的声明——正是本变更要消灭的东西
  - 未覆盖：安装/导出/预览三条**路由**路径的逐字节比对，需 `server/routes/fleets.js` 解封
- [x] 5.2 `enabled` 退出 UI 入口 — **验收两半都实测完，结论是「无需改」**：
  - **UI 半**：`grep -rn "enabled" web/src --include="*.tsx" | grep -iE "memory|knowledge|scope"` 唯一命中是 `DocumentsPage.tsx:288` 的 `body: JSON.stringify({ enabled, acknowledged: … })`——那是文档确认功能，与记忆无关。**记忆/知识的 `enabled` 开关从未在 web 渲染过**，没有可撤的入口（本变更新增的声明面板也只渲染四列与徽标，不含 `enabled`）
  - **API 半**：见下（模块级/路由级的区分）
  - **API 半（等价性）已有用例**，且不是新写的一套：`scripts/test-memory-read-axis.mjs:86`「enabled:false canonicalizes to scope off」、`:93`「scope off canonicalizes to enabled:false」、`:98`「a contradictory pair resolves to off, never to on」，加上 `test-knowledge-profile.mjs` 的 `memory_enabled_invalid`（非布尔）与规范形态断言（`{enabled:false, scope:"off"}`）。**口径说明**：这些是纯模块级的，不是路由级——存 `knowledge_profile` 的路由在 `server/routes/fleets-db.js`（他人活线），所以「API 用例」这条按模块级记录，路由级待解封
  - **UI 半未做**：`web/src` 全目录他人活线（27 个脏文件），未碰
- [x] 5.3 文档 — `docs/creating-packs.md` 新增 3.2 节：四轴表 + 三条最易踩的坑（home 只写枚举、不写即继承、`own` 不存在）+ `memory_scope` 简写/冲突 + 两个 `executed: false` 的键。**示例由测试直接读文档文件并跑校验器**（第 25 条）：把示例里的 `home` 改成 `d/mypack/agentA` → 该用例变红（24/1），还原 → 25/25
- [x] 5.4 归档前校验 — **已归档并通过**（`openspec archive add-pack-memory-declaration --yes` → `2026-11-12-add-pack-memory-declaration`）：`add-pack-memory-declaration --strict` ✓；归档后两份能力 `--type spec --strict` 均 **OK**（`pack-memory-declaration` 新建 7 条、`member-knowledge-profile` 改 1 条）；新能力 Purpose 是写实的（delta 里本来就带 Purpose，未落 `TBD — created by archiving`，无需回填）
  - 归档前回归：我碰过的 12 套件 **156/156 绿**；fd-memory 全仓 249/249；e2e `fleet-memory-policy` 4/4
