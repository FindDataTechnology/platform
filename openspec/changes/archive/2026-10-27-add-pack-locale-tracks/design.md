# Design: add-pack-locale-tracks

## Context

勘察结论(全部实证,2026-10-27 会话):

- 唯一真校验器 `lib/pack-manifest.js:440` gateway 发布(`gateway/packs.js:107 collectPublishVerdict`)/dry-run/cell 安装三处共用;`facet-pack-builder` 的 `validate_manifest.py` 优先 shell 到它(scripts/validate_manifest.py:78-101),mirror 规则只作兜底。
- 市场存储:`pack_versions` 表把 `name`/`description`/`tags` 冗余为索引列(gateway/packs.js:215-225)+ `manifest` blob 原存;搜索 LIKE 打列(:595-603)。读投影两个收口:`summaryOf()`(:390-419)与详情投影(:68-78)。
- 客户端:壹座 web 已 i18n 化 chrome(zh-CN/en/es/fr/ja,en 为 fallback,见 internationalization spec),pack **内容**原样渲染——PackDetailDialog.tsx:392 注释自承缝位("Guide bodies are the pack's own-language content (zh)")。
- fleet 模板已有 `name ?? nameKey`/`title ?? titleKey`/`label ?? labelKey` 先例(server/fleet-template.js:61-64,81,107):内置模板走 i18next bundle key,pack 模板走字面量。这是 chrome 层机制,与本单的内容层 locale 是两个层次,共存不合并。
- `tagline` 在 pack manifest 不存在;pack 发布门现无禁辞扫描(zh/en 皆无),ABSOLUTE_CLAIM_RE 仅存在于 finddata `docs/marketing/audit.py:131` 的物料审计。

约束:需求书 §2A「字符串直写视为 zh(向后兼容旧包零改动)」与 §4 兼容性验收「旧客户端表现与今天逐一比对等价」是硬约束;用户裁决中文为主轨。

## Goals / Non-Goals

**Goals:**
- overlay 形状一次定死,旧包/旧客户端/旧校验器零改动、零感知;
- locale 解析与回落规则收敛在单一共享模块,gateway 与 cell 读面同源;
- 发布门对 overlay 逐字段点名报错(沿 lib/pack-manifest.js 既有 `fail(errors, msg, entry)` 风格);
- fleet 模板显示字段同构接入,内部字段零改动。

**Non-Goals:**
- 内容层翻译(SKILL.md/persona/promptTemplate)——需求书 §3;
- 多语搜索(冗余列只存 zh,检索面不变);
- zh 轨禁辞扫描、存量强迁、`tagline` 新字段——proposal 已记录偏差;
- 客户端各自实现回落逻辑(违反本单集中原则)。

## Decisions

### D1 — 形状:顶层 `i18n` 叠加块,否逐字段 map

**决定**:manifest 新增可选顶层键 `i18n`,形状 `{ <locale>: { <显示字段路径>: <值> } }`;locale 键不得为 `zh`(zh 住在基字段,写 `i18n.zh` 视为非法——基字段就是 zh,双写必然漂移)。基字段(name/description/guide/…)保持纯字符串、现有规则一行不动。

**否「逐字段 map」(`name: { zh:…, en:… }`)的理由**:基字段类型从 string 变 union,现客户端直接渲染 `name` 字符串——拿到 object 即渲染崩溃,违反兼容性验收;且校验器每个显示字段要改双形,后续每个新显示字段永远背双形状包袱。overlay 把「兼容」从「处处容忍双形」变成「构造上无新形」:不读 `i18n` 键的消费者看到的 manifest 与今天逐字节同形。

**否「平行后缀字段」(`nameEn:…`)的理由**:无骨的键增殖,无逐 locale 归组,移到第三语言即成滩涂。

字段白名单(overlay 内允许出现的键,第一个版本):`name`、`description`、`notes`、`guide.steps[].title/body`、`skills[].description`、`agents[].name`、`bots[].name/description`、`cluster.name/description`、`serving.card.name/description` 及 `serving.card.skills[].name/description`。白名单以「市场与安装面会展示的字符串」为界;`tags` 不进(检索键不是显示文案,多语检索挂账)。overlay 值按**索引对齐**引用数组成员(`guide.steps[1].title`),按**名字**引用命名实体(`skills['<name>'].description`、`agents['<id>'].name`)。

### D2 — 解析:单一 leaf 模块,gateway/cell 同源

新增 `lib/pack-locale.js`(零依赖 leaf,仿 lib/rhythm.js、server/fleet-orchestration.js 的 gateway-safe 模式):

```
resolveLocale(requestLocale)            → 规范化 locale 标签(小写、zh* → zh)
pickLocalized(baseValue, overlayEntry, locale) → string
projectManifestForLocale(manifest, locale)     → 展示用 manifest 副本(基字段被 overlay 命中键覆盖;不含 i18n 块)
```

**解析序**:`?locale=` 查询参数 > `Accept-Language` 首项 > `zh`。`zh*` 一律归一 `zh`(命中基字段,overlay 永不参与)。回落:locale 无该块 → 基字段;块有而键缺 → 基字段。**不存在 per-locale 内再回落到 en**——zh 是唯一回落终点(用户裁决主轨)。

接入点:gateway `summaryOf()` + 详情投影 + cell `server/routes/packs.js` mypacks 读面。三处调同一 `projectManifestForLocale`;客户端(壹座/谦面)只传 locale,永不自行回落。详情投影返回副本时**剥掉 `i18n` 块已解析的部分**?(否——保留原样返回 `i18n` 原块,客户端作者工具可展示多语编辑;「已解析字段」只覆盖基字段。)→ 修正为:基字段被覆盖,`i18n` 原块随行透传,一去一回皆合法(manifest 契约不变)。

### D3 — 冗余列策略:zh 主轨入列,搜索面不变

`pack_versions.name/description/tags` 冗余列继续存 **zh 基字段**文本:发布写入路径零改动(基字段本来就是必填 zh),列表 SQL/LIKE 搜索逐字节不动,旧索引零迁移。列表/详情按 locale 投影在**读时**从 manifest blob overlay 覆盖列值。en 文本不可检索是本版本的明示边界(需求书未要求,挂账国际化阶段)。

### D4 — 发布门 overlay 规则(validatePackManifest 新增段)

按既有 `fail(errors, msg, entry)` 风格逐字段点名,entry 形如 `i18n.en.guide.steps[1].title`:

1. `i18n` 须为对象;locale 键须匹配 `/^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/` 且 ≠ `zh`;
2. 每 locale 块只许白名单键;数组 overlay 引用越界/命名实体引用不存在 → 点名非法(防「翻了一个不存在的岗位」);
3. 每个被覆盖值:非空字符串,遵守**与基字段相同**的长度帽(复用 PACK_LIMITS 同一常数,一帽两轨);
4. 结构一致性:`guide.steps` 在某 locale 下要么三步 title+body 全有,要么整组缺省(回落 zh);半步散件 → 报错——需求书「回落表断裂」即此;skills/agents/bots/card.skills 的数组 overlay 不受整组规则约束(逐项独立回落);
5. en/zh 长度比率:对 `description`、`guide.steps[].body` 两处长文,`|en| ≤ 3 × |zh|` 且 `|zh| ≤ 3 × |en|`,越界报错(3:1 理据:英译正常膨胀 1.5–2.5×,3 倍只拦「贴错内容/语种错位」,不伤合法翻译);短字段(name/title/label)帽已足够,不设比率。实施补丁(1.1 落地实证):比率设 20 字符**地板**——任一侧短于 20 字符即跳过比率(3 字 zh 标签合法译成 12 字),否则极短字段被系统误伤;spec 场景同步;同时适用于任意 locale 块(非仅 en);
6. **en 副轨禁辞同扫**:对 en 块全部字符串跑 ABSOLUTE_CLAIM_RE 同款(从 finddata `docs/marketing/audit.py:131` 移植,绝对化替代表述中英同轨——需求书 §5);违例逐字段点名。zh 基字段本版本不扫(proposal 偏差记录)。

`validate_manifest.py`:真校验器自动获得规则(shell 透传),mirror 段同步镜像(沿既有 lockstep 注释纪律);`publish_pack.py` 纯 JSON 透传,零改动(勘察实证)。

### D5 — fleet 模板:`fleet.i18n` 同构 overlay,Key 机制不动

`fleet` 段新增可选 `i18n`:`{ <locale>: { name?, members: { <ref>: { title?, kpiSlots: { <key>: { label? } } } } } }`,按 ref/key 定向,成员级逐项回落。`parseFleetTemplate` 现状是「取串即显」(`name ?? nameKey`),改为:模板返回的规范化显示字段仍是 zh 基串,overlay 由 `projectManifestForLocale` 同一路径在展示投影时套用——模板校验只增形状门(ref/key 必须存在、值非空、长度帽),不做解析。**内置模板的 `nameKey/titleKey/labelKey` 原样保留**(i18next bundle 层机制,与内容层 overlay 是两个通道,不合并不互转)。`exportFleetToTemplate` 导出现役集群时 overlay 随行(现役显示字段已物化为 zh 串,导出即基字段;无 overlay 可导——导出物天然合法)。

需求书 §2C 的「岗位/拍板描述」落点即 members[].title 与 kpiSlots[].label;`promptTemplate` 属内容层(岗位工作内容,同 persona 待遇)不进 overlay。blueprints/schema.md 的 `vertical.name/tagline`、`boards[].title` 是 fleet-packs 仓文档形状,同构约定写进该文档(任务级),不在本仓校验器内(蓝图书不经 validatePackManifest)。

### D6 — E(存量改名)的协同界面

本 change 只交付形状与闸门;八舰模板 + 六共用包的新显示名录入是 fleet-packs 仓的内容批,与 `cluster-vocabulary-and-pack-taxonomy` 同一作者编辑批。协同界面一句话:**内容批以本形状为录入格式**——本 change 上产前,改名批按 zh 字符串直写(旧写法,永久合法);上产后,en 副轨自然补录。不做强迁、不造两轮编辑。

## Risks / Trade-offs

- [overlay 与基字段双写漂移(作者改了 zh 忘改 en)] → 比率门( D4-5)拦长文错位;短字段靠 en 禁辞与作者自检;不做内容等价校验(机器判不了翻译质量,需求书亦未要求)。
- [旧客户端收到含 `i18n` 键的 blob 是否安全] → JSON 消费者遇未知键忽略;壹座/谦面消费顶部被投影覆盖的基字段,不触 `i18n`。cell 安装面重校验走同一 validatePackManifest——含 overlay 的 manifest 过装无误。
- [Accept-Language 首项质量参差(如 `en-US,en;q=0.9` 带权重)] → 只取首项粗解析(对照 internationalization spec 的 exact→primary-subtag 归一),不实现完整 q 值排序——市场 API 的精排收益不抵复杂度;`?locale=` 显式参数永远是作者/客户端的精确通道。
- [比率 3:1 误伤极短字段(zh 2 字 → en 合法 8 词)] → 比率只施于两处**长文**字段(description、guide body),短字段豁免(D4-5)。
- [ABSOLUTE_CLAIM_RE 移植后两套漂移] → 正则以注释互链两仓文件路径,沿用本仓「同源注释」纪律(如 lib/rhythm.js 头注);国际阶段若开品牌词表另行立项。

## Migration Plan

无数据迁移:`pack_versions` 既有行的 manifest blob 保持纯字符串(=zh,永久合法),冗余列语义不变。部署序:gateway + cell 同代滚动(校验器与读面同包),web 类型面随后;facet-pack-builder 镜像规则先行合入不影响任何在役包。回滚=回版本,overlay 块随旧校验器「未知顶层键?」——注意:`validatePackManifest` 现状**不拒**未知顶层键(只校验已知键),回滚后含 `i18n` 的存量版本仍可安装/重校验,无滞留毒数据。

## Open Questions

- 谦面市场页何时开始传 `?locale=`——谦面侧排期,不阻塞本单(服务端默认 zh 对旧客户端透明)。
- 第三语言(日/西/法)开放节奏:契约已任意 locale 键,运营上架节奏挂国际化阶段。
- en 可检索性(详情页 en 文本是否入搜索索引):挂账,随多语搜索一并立。
