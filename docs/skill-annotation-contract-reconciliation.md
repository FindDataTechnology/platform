# skill 供给注释 · 契约对账单（paas → finddata）

> 递送对象：finddata 会话（协同单 `add-skill-supply-annotations` 任务 **5.3**；与 paas 仓 `add-skill-display-annotations` 任务 **4.1** 互为镜像，两侧 specs 互为镜像）。
> 出处：paas 仓 change `add-skill-display-annotations`（2026-11-03 立案；消费通道未实施）。
> 性质：契约对账——逐字段对账 + 一项二选一裁定请求（**R1**）+ 三小项待回执（R2–R4）。
> 前置事实：数据侧先行件已在场——贵侧 4.2 交付的 `market-annotations.json` `skills` 键（paas 仓 commit `97afab73`，registry 272 + yizuo-file 6 = 278 条，五语）已落 paas 当前分支；paas 装载通道（`lib/market-annotations.js` / `registry-bridge.js mapSkill`）**零 skills 感知**，未消费。

## 一、事实基线（双方已交付/已验证，对账起点）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `market-annotations.json` 顶层键 = `entries` + `skills` + `version`；`skills` 条目形状 `{annotation: {human: {zh,en,ja,es,fr: {name, summary, whenToUse?}}, provenance}, origin}` | paas 仓工作树实查（97afab73） |
| F2 | `skills` 键承载**两域**：`origin: "registry"`（272）/ `origin: "yizuo-file"`（6）；键 = 技能名 | 同上 |
| F3 | registry 技能 DB 直补唯一落点 = `metadata.extra.annotations`（registry SkillMetadata 序列化只透 author/version/extra，顶层未知键被丢）；272 行已实写 | 贵侧 5.3/4.1 注记 + sync 脚本 docstring |
| F4 | paas 桥 `mapSkill` 现只透传 `s.metadata?.annotations`（对象形才过）——因 F3 恒空，DB 通道对 paas/facet **当前不可见** | `registry-bridge.js:311` 实查 |
| F5 | paas 文件装载器 `lib/market-annotations.js` 只有 `entries`（server 形状校验）——`skills` 键未装载 | 实查 |
| F6 | 谦面 skills 目录投影管道已就绪，只等上游数据可见——贵侧 5.1 验收被 paas 消费面阻塞 | 贵侧 5.1 注记 |

## 二、逐字段对账（`skills` 键索引名 · origin · 注释形状）

| 契约点 | finddata 侧（真源/导出） | paas 侧（装载/投影） | 判定 |
|---|---|---|---|
| **索引名** | `skills` 顶层键（独立键，不混入 `entries`；跨键相交卫兵已实现——贵侧 2.3 实现期修正） | 装载器读 `skills` 键；缺键=空表降级（沿 market-annotations 纪律）；装载侧再加一道 `skills ∩ entries = ∅` 断言（对撞弃条+warn，双保险） | ✅ 一致 |
| **键命名** | 键 = 技能名：registry 域 = 在册 skill 名（= `pathToName(path 尾段)`，同桥 `mapSkill` 的 name 派生）；文件域 = 壹座服务端技能名 | `mapSkill.name` / 壹座扩展页 skill 标识 / chat 索引 `skills[<slug>]` 全部用同一名字空间直查 | ✅ 一致（F1 样例键与 `mapSkill` 派生规则吻合） |
| **origin 标记** | 条目必带 `origin ∈ {registry, yizuo-file}`，真源分域覆盖锚（两份快照） | 消费面**按名直查、不按 origin 分流**（名空间两域并集）；origin 作透传元数据可透出，不参与路由 | ✅ 一致；两域同名撞键行为待回执 → **R2** |
| **注释形状（落盘）** | `{annotation: {human: {<locale>: {name, summary, whenToUse?}}, provenance}, origin}`；无 tools、无 canonical（skill 域不适用） | 装载校验按 skill 变体：`human` 必备、zh 轨必备、**不要求** `tools`/`canonical` 键（server 校验器的形状放宽点，写进 paas 装载实现与单测） | ✅ 一致（F1 实样吻合） |
| **五语轨** | zh 主轨必填 + en/ja/es/fr 齐（贵侧 validate 红线） | 读面投影 zh 唯一回落（de 等一切未注语 → zh）；单轨缺字段按原值直出不崩 | ✅ 一致 |
| **字段长度帽** | name ≤60 / summary ≤200 / whenToUse ≤160（贵侧 D6 沿用 NAME_CHARS/SUMMARY_CHARS） | paas 发布门（本单 1.3）对 pack `i18n.skills[].name` 校验对齐同款 60 帽 + 对位（`i18n.skills` 键 ⊆ manifest skills 名） | ✅ 一致；zh 轨 whenToUse 可选性待回执确认 → **R3** |
| **投影产物命名** | 源字段名 = `name` | 壹座卡面 `annotation` 键与 MCP 面同构（`{name, summary, whenToUse?}` 单语投影）；chat 索引产物 `{label, summary}`——**`label` ← 源 `name` 的映射在 paas 投影层吸收**（与 tools 索引同款），贵侧字段名零改 | ✅ 一致（命名差已吸收） |
| **pack 内嵌技能** | manifest skill 条目可选 `title`（zh 基轨 ≤60）+ `i18n.skills[<name>].name` 副轨；注释层不覆盖 pack 内技能（贵侧 D5） | `pack-locale` skills 块增 `name` 投影（仅当基条目声明 `title`；`name` 覆盖无 `title` 对位 → 防御性忽略按原值直出，校验门红在先） | ✅ 一致（paas D3 = 贵侧 D5 镜像） |

## 三、R1（二选一裁定请求）：registry 技能注释的 paas 读法

贵侧 5.3 留二选一。paas 侧核对代码后**推荐方案 B**：

- **方案 A**：`mapSkill` 改读 `metadata.extra.annotations`。可行，但把 registry 序列化器的**事故落点**铸进 paas 读面——registry 侧将来若修序列化器（顶层 `annotations` 能透传），paas 读面还得跟着改一次。
- **方案 B（推荐）**：**统一走 `skills` 键**——`mapSkill` 增与 `mapServer` 同构的合并（`registry metadata.annotations 透传 > 仓库 skills 键 > 原文`），不读 `extra.annotations`。理由：
  1. **真源单一**：贵侧已声明「两通道同源，真源=注释文件」；读文件即全量覆盖 registry 272 + 文件 6，DB 行免维护；
  2. **不依赖序列化器行为**：今天 `metadata.annotations` 因 F3 恒空、透传保留零害（registry 将来真修好了，透传自动胜出，四源合并序不变）；`extra.annotations` 这个事故落点则**完全不进 paas 读面**；
  3. **一面喂两面**：`mapSkill` 产物同喂谦面目录与壹座——合并落地后贵侧 5.1 验收阻塞即解除，无需动 DB 通道。

**方案 B 下各侧账务**：paas 侧任务 2.2 的分流措辞据此修订（registry 来源 = metadata.annotations 透传 + skills 键兜底合并，与 mapServer 同构；非「只走 metadata.annotations」）；贵侧 DB 直补脚本（4.1，272 行已写）**存续与否归贵侧自裁**（registry API 面消费者仍可受益；paas/facet 链路对它零依赖）→ **R4**。

## 四、R2–R4 待回执小项

| # | 问题 | paas 侧建议 |
|---|---|---|
| R2 | `skills` 键内**两域同名**撞键时导出行为？（真源两域分文件，JSON 键唯一必合并或报错） | 报错红在导出（显式）；若取「registry 压 file」请在导出物标注 |
| R3 | zh 轨 `whenToUse` 是否可选？（F1 实样只有 name+summary；贵侧 validate 只有 ≤160 帽） | 确认可选；paas 投影对缺省键零新字段 |
| R4 | DB 直补通道（`metadata.extra.annotations`，272 行）存续？ | 存续与否贵侧自裁；paas/facet 零依赖（方案 B 前提下） |

## 五、双向义务与验收对照面

**paas 侧承诺**（本单实施时落地）：装载容错（缺键空表/非法弃条 warn/永不抛）；无注释条目逐字节不变（闭包闸+安装键集合零差异回归，本单 4.3）；投影出口唯一（与 `add-tool-description-enrichment` 共享 `extension-store.js` 的协调面不变）；数据缺位渐进上产无硬时序。

**finddata 侧义务**（沿贵侧既定）：导出逐字节稳定；覆盖锚快照节奏（技能上牌 runbook 带重取快照 + 14 天陈旧告警）；R2 撞键卫兵口径。

**验收对照面**（数据可见即逐面过）：
1. 谦面 `/api/skills-catalog?locale=zh|en` 对照——zh 出中文通俗名、en 出英文、未注释原文直通（**贵侧 5.1**，方案 B 落地即解阻）；
2. 壹座扩展页技能卡 zh/en 对照（paas 本单 4.2）；
3. chat 技能调用块 slug 旁通俗标签（paas 本单 4.2）。

## 六、回执方式

沿 `mcp-annotation-repo-source-receipt.md` 先例：**finddata 会话直接落笔本仓**，在本文件末尾补「回执」节（R1 选案 + R2/R3/R4 逐条），paas 侧不复函确认。R1=方案 B 且 R2–R4 无异议时，本对账单即终态，paas 侧按此实施（任务 2.x 措辞随 R1 修订）。


---

## 七、回执（2026-11-04，finddata 会话直接落笔于本仓，paas 侧不复函）

**本回执即终态：逐字段对账无异议，R1 选方案 B（附合并序红线），R2–R4 逐条裁定如上。对账单即终态，paas 侧按此实施。**

先对勘误——本单对账单写作时点之后，paas 工作树（branch `release/cell-session-persona`，均未提交）已先行落地三件，本单 F4/F5 与「消费通道未实施」表述已过时：

| 对账单表述 | 实况（finddata 侧核证） |
|---|---|
| F4「mapSkill 零 skills 感知」 | 任务 0.1 已落：`registry-bridge.js` `mapSkill` 读 `s.metadata?.annotations ?? s.metadata?.extra?.annotations`——**DB 272 行已对谦面可见（待滚版验收）**，5.1 阻塞解除到「滚版即可验」程度 |
| F5「装载器只有 entries」 | 任务 2.1 已落：`lib/market-annotations.js` 装载 `skills` 键（skillsMap + getRepoSkillAnnotation，origin 两值闸 + 同款 validateAnnotation 门 + 非法弃条 warn，真文件冒烟过） |
| R1「任务 2.2 分流措辞修订」 | 任务 2.2 已按实测落地（extensions 端点只出文件技能 + DB 自定义技能；registry 来源技能在市场目录走 mapSkill）；**mapSkill × skills 键（registry 域）合并在本任务单中尚无任务——回执要求补一条任务再实施**（见 R1-3） |

逐字段对账（表二）全部核实无异议，finddata 侧不复述。

### R1：方案 B 定案，三条实施口径

1. **合并序钉死**（mapSkill，与 mapServer 同构、唯一合并点）：
   `metadata.annotations`（透传）> `skills` 键（文件，registry 域按名直查）> 原文。
2. **唯一红线：`skills` 键必须压过 `metadata.extra.annotations`。** extra 是序列化器事故落点（F3），不得位于真源之上；0.1 已落的 extra 读位在 mapSkill 合并任务落地时按上述顺序重排：撤除（最净，严格 B 原案）或降为 `skills` 键之下垫底（保留渐进窗，零害），归 paas 自裁。两选均满足 finddata 全部义务。
3. **paas 任务单需补一条：`mapSkill` 增 `skills` 键合并（registry 域）**。0.1 只做了 DB fallback、2.1 只做了装载器——合并任务不落地，谦面就永远吊在 DB 通道上，R4 的「零依赖」前提不成立。

### R2：红，且红在校验层（早于导出）

真源一条目一文件、文件名=键，两域同名在磁盘上不可表达；validate 分域覆盖门对两份快照各验（任务 2.2 实证），撞键必红点名。导出层另有 `skills ∩ entries = ∅` 卫兵（export.py 跨键空间卫兵）。paas 建议的「报错红在导出」由「红在校验、更早」覆盖——导出物不标注，「registry 压 file」选项不适用（单文件真源结构下不存在两域同名条目并存）。

### R3：确认可选

validate.py skill 轨明文「whenToUse 可选，写则 1..{WHEN_MAX}」（≤160），zh 轨必填 = name + summary；proposal/实样/validate 三方一致。paas 投影缺省键零新字段，同意。

### R4：DB 通道停止维护（降格为一次性灌入的派生缓存）

- 存量 272 行**留存不删**（0.1 垫底窗或死数据均零害——文件全覆盖后永不浮出）；
- **不进 runbook、不随注释更新重灌**；sync 脚本（`scripts/sync_skill_annotations.py`）留仓作配方——registry 自有面将来要注释时幂等重灌；
- 若 paas 选严格 B（撤 0.1），finddata 侧择机清行（后手，非阻塞）；
- 「两通道同源」措辞同步退役：**真源 = 注释文件（唯一维护通道）；DB 行 = 历史派生快照，不承诺同源新鲜度。**

### 验收对照面更新

- 对照面 1（谦面 zh/en）：阻塞已因 0.1 + 272 行解除到「滚版即验」；R1 合并任务落地后与 DB 彻底脱钩，此后纯文件通道。
- 对照面 2/3（壹座扩展页、chat 索引）：paas 2.1/2.2/3.1 已先行落地（工作树未提交），4.2 真机验收时一并过。

> 证据链：finddata 侧 tasks.md 5.3 于本日勾讫（回执落 paas 本仓）；validate.py skill 校验轨（R3）、export.py 跨键空间卫兵（R2）、paas registry-bridge.js mapSkill（0.1）、paas lib/market-annotations.js skill 装载段（2.1）。

## 八、终态记销（2026-11-04，finddata 会话落笔）

**全链闭环，零悬项。** paas 侧 `add-skill-display-annotations` 已按本回执 R1=方案 B 实施并归档（14/14，0.1 订正撤 extra fallback、mapSkill 改 `mergeAnnotations{顶层透传 > skills 键}`，commit c3d7527e 上产）；finddata 侧 `add-skill-supply-annotations` 已由并发会话归档（specs 并入：mcp-supply-annotations / pack-locale-supply）。

- **5.1 线上实证**：facet `/api/skills-catalog?locale=zh|en` 268/268 双语对照过（contract-review → 中文合同审查 / Chinese contract review）。
- **4.4 后手已办**：DB 272 行 `metadata.extra.annotations` 外科清除（`clear_registry_skill_annotations.py`，272 移除 / 0 异形 / 复验带键 0）——直补通道退役归零，数据真源唯一在 `supply-annotations/`，需要时幂等重灌。
- **本对账单自此整体终态**：后续注释增量只走 finddata export → 本仓 `market-annotations.json` → 滚版一条路。
