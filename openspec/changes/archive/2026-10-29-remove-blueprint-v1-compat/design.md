## Context

见 proposal.md「Why」。补充实施相关现状（2026-10-29 实测）：

- `normalizeIncomingContent` 只在两处被调用：`POST /api/blueprints`（创建）与 `PUT /api/blueprints/:id`（编辑）。`server/` 内无其它调用点。
- 写入层唯一的硬闸是 `server/routes/blueprints-db.js` 的 `assertStorable`，目前只跑 `credentialFindings`（凭据禁带），命中抛 422。POST/PUT 路由**不跑** `validateBlueprint`——它们只直接 `store.createBlueprint/updateBlueprintContent`，并附 `dataSourceFindings` 作**警告**（草稿可以是 WIP）。
- 完整校验链 `validateBlueprint` 只在 `/validate`、`/approve`、`/cast` 三处跑，且它总是把 `shape + acceptance + fleet + manifest + toolFace + toolClosure` **全量拼接**。
- 实测：把 finddata 的 v1 样本文档直接喂 `validateBlueprint`（去掉归一化后），得到 5 条错——4 条 `acceptance[N] must be an object` + 1 条无 `entry` 的 `a pack must contain at least one skill, MCP reference, agent, or bot`。`fleet`/`monitoring` 键名 v1/v2 相同故不报错；`boundary`/`dataSources`/`board` 只是静默缺位。
- 实测（归一化现状）：v1 样本经 `normalizeIncomingContent` 后，自由文本断言变为 4 条 `{kind:"llm-judged", rubric:<原文>}`，但整份仍因缺内联物件过不了发布门。即：现状既没让 v1 真正可用，又替作者凭空造出模型判据。
- 契约真源 `finddata fleet-packs/blueprints/schema.md` 已升 v2，且其正文已注明平台读入归一化「视平台版本」——本仓摘除后需在 finddata 侧同步更正那句注记（跨仓，非本仓实施）。

## Goals / Non-Goals

**Goals:**
- 摘净 `normalizeIncomingContent` 与其自由文本归一分支，让 v2 成为唯一接受形状。
- 让 v1 方言「进门即被指名拒绝」，且在写入层与校验链两处都成立（覆盖未来任何写路径）。
- 校验链只报**一条根因**错误，不叠加方言错位派生的散错。

**Non-Goals:**
- 不动 `llm-judged` 第五型及双钥匙（属 `add-blueprint-llm-assertions`）。
- 不转写 finddata 的两份 v1 样例（历史证据）。
- 不改变 v2 蓝图任何正常链行为。
- 不新增第二套校验器/第二形状闸框架——复用既有 `shapeFindings`/`validateBlueprint` 结构。

## Decisions

### D1：拒绝做「前置短路 gate」，不是 `shapeFindings` 的一个分支

**决定**：新增独立判别 `v1FormatFindings(content)`；`validateBlueprint` 开头调用并**短路**——命中即返回 `{ ok:false, errors:[那条v1错], findings:{ v1:[…], 其余空 } }`，不进后续链。

**理由**：`shapeFindings` 的产物是与其他发现**拼接**进错误列表的（`[...shape, ...acceptance, …]`）。若把 v1 判别塞进 `shapeFindings`，用户会同时看到 v1 错 + 4 条 acceptance 形状错 + 包级错，正是要避免的散错。短路是达成 spec「只报一条根因」的唯一办法。

**备选**：塞进 `shapeFindings` 并附加去重/抑制逻辑——更绕且仍可能残留派生错，否决。

### D2：判别条件 = v1 独有键存在 **且** 对应 v2 键缺位

**决定**：命中条件为 `(vertical || sources || boards 任一存在) && (对应 boundary / dataSources / board 缺位)`。

**理由**：单看「出现 `sources` 这类键」会误伤——`sources`/`boards` 这类词在别处（监控、README 副本、`_casting` 附注）可能出现。用「**且**对应 v2 键缺位」的合取，保证仅当一个文档确实是「v1 方言」而非「v2 文档多带旧键」时才触发。一个健康的 v2 文档自带 `boundary`/`dataSources`/`board`，永不误触。

**备选**：只按"存在 v1 键"判——误报风险高；只按 acceptance 是否字符串判——漏掉结构性键错位。均否决。

### D3：写入层拒绝落在 `assertStorable`，与凭据同级

**决定**：`assertStorable` 同时跑 `credentialFindings` + `v1FormatFindings`，任一命中抛 422（附 findings）。

**理由**：`assertStorable` 的本意就是「结构性不可存储」，遍历所有写路径（路由、脚本、未来执行器）。v1 方言和凭据属于同一族——不是「还没填」，而是「填的是另一套键名，怎么补都补不出来」，必须结构性挡在门外。这样 POST/PUT 不必各自加判别，天然一致。

**区分「WIP 草稿」与「错方言」**：空字段的 v2 草稿仍是合法 WIP（现状允许）；v1 方言不是 WIP 而是错格式，不该进门。这条界线正是把 v1 放进 `assertStorable` 而非放进「警告」的理由。

**备选**：只在 `validateBlueprint` 拦——则 v1 会被存成空壳草稿，只在验证时才报错，用户旅程是「存了→点验证→才看到 v1 错」，否决。

### D4：`/validate`、`/approve`、`/cast` 仍要短路防线

**决定**：`validateBlueprint` 内的短路保留，即使写入层已挡。

**理由**：纵深防御——历史库若曾直接塞入 v1 形状（本仓无此记录，但可能有人手工写库/未来迁移），校验链仍须报一条根因而非散错。成本极低（一次纯形状判别）。

### D5：测试翻成「v1 被指名拒绝」，并补「v2 不受影响」回归

**决定**：改写 `scripts/test-blueprints.mjs:461`。

**理由**：原用例断言的是旧行为（归一化 + acceptance 全变 llm-judged），且**从未断言 `ok:true`**——它锁的正是"半绿"状态。翻成两条：① v1 粘入 → 写入/校验被拒且只报一条 v1 错；② 一带无害旧键的 v2 文档不被误拒。原用例的 v2 正常路已由 `test-blueprints.mjs` 其它用例与 `VALID_CONTENT` 覆盖。

### D6：错误文案保留多行迁移指引，但 UI 需允许换行呈现

**决定**：错误文案沿用需求书 §3 那段（含 v2 字段清单 + 迁移指引，多行）；同步在 `BlueprintStudioPage` 的错误项上允许保留换行（`whitespace-pre-line`），否则 `\n` 会塌成一条长串。

**理由**：迁移指引的价值在于可读的分行清单；`ErrorList` 的 `<li>` 无 `white-space` 处理会让它变成一整段连排，削弱"一条可读的指名错误"。

## Risks / Trade-offs

- [误伤合法 v2 文档] → D2 的合取条件保证 v2 文档（自带 v2 键）不触发；补一条「v2 带无害旧键不被拒」的测试锁住。
- [生产库有隐性 v1 记录被阻断] → 实测四 cell 仅一条 v2、余 0 行；且拒绝只挡"写入 v1"，不阻断已有 v2 文档的读取/试跑。回滚：还原三处代码即恢复旧归一化。
- [`finddata schema.md` 注记与本仓脱节] → 属 finddata 仓一次性文案更正，登记为跨仓跟进项（不在本仓 tasks 实施），不阻塞本单。
- [UI 换行缺失削弱文案] → D6 一并处理；如暂不改 UI，错误仍可见，只是排版差，不影响"被拒"这一行为。

## Migration Plan

1. 落地三处代码 + 测试翻转；跑 `test-blueprint*.mjs` 与 `openspec validate` 全绿。
2. 出片滚产（走既有镜像链，遵 AGENTS.md 纪律）。
3. 生产无感验证：唯一 v2 蓝图在总览坞显示、试跑报告读取正常。
4. 回滚：三处代码改动可原子还原（无数据迁移、无 schema 变更）。

## Open Questions

（无——已确认的取舍均落在上文 Decision；finddata 侧文案更正为跨仓跟进，不影响本仓 spec/approach/tasks。）
