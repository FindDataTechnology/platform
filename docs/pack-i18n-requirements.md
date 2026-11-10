# pack 与集群市场的多语言供给 · paas/谦面侧需求书

> 交付对象：paas 实施者。来源：2026-10-27 产品线叙面会话——用户裁决明确：
> 「多语言要支持、但中国主市场，命名符合中国用户使用习惯」。即**中文是默认主轨
> （主名、默认呈现、默 认回落），多语言是形态上的副轨**——现在的契约不能让
> content 字段写死到国际化时伤筋动骨。
> 本单尚无对应 OpenSpec change，paas 会话启动时自行 promote 立项；与
> 《集群平台供给开放》《集群主人经营面》是姊妹单，叙面口径承接 finddata 根
> change `reposition-fleet-platform-narrative` 与集群改名词表（见文末 §7）。

---

## 1. 问题

当前 pack 形态的全链都只有单一语言：

- **manifest 层**：`name`/`description`/`tagline`/`guide.steps` 是纯字符串，无 locale 维度；
- **市场条目层**：市场 API 返回单名字段，壹座「设置→功能集」与谦面市场页没有按语言渲染的路径；
- **内容层**：SKILL.md 正文、persona 文本、集群模板岗位描述只有一份（现全为中文）；
- **铸造工具链**：`facet-pack-builder` 的 validate 只检字符串上限，没有「主轨必填、副轨可选、逐 locale 校验」的规则。

如果现在大改名（集群替舰队、能力族命名）继续在单语言字段上写死，将来接国际化（海外供给方见
《集群平台供给开放》）时**每一个存量包都要回炉**。趁命名体系重排，把 locale 结构一并接上。

## 2. 范围

| 编号 | 交付物 | 优先级 | 说明 |
|---|---|---|---|
| A | **manifest 多语言层**：`name`/`description`/`tagline`/`guide` 支持 locale 映射（`{ zh: ..., en: ... }` 或等效形状）；zh 为必填主轨、en 及其他可选；字符串直写视为 zh（向后兼容旧包零改动） | P0 | 形状变更须向后兼容——不接受「旧包上车必须改版」 |
| B | **市场/客户端 locale 渲染**：市场 API 与壹座 store 按请求 locale 选字段；缺该 locale 一律回落 zh；缺 zh 视为非法条目（发布门拦） | P0 | 渲染策略集中一处，各客户端不复写 |
| C | **集群模板与别名的多语言**：场景名（如「政心盯梢集群」）、功能族名、岗位/拍板描述加入 locale 结构；`blueprints/schema.md` 与 fleet 段的显示字段同步扩 | P1 | fleet 段内部字段形状（posts/cadence/kpiSlots/edges）零改动 |
| D | **铸造工具链校验**：`validate_manifest.py`/发布门增 locale 规则（zh 必填、逐 locale 长度/结构一致、回 落表完整）；`publish_pack.py` 接受多语言 manifest | P0 | 校验失败文案须逐字段点名（沿既有风格） |
| E | **存量改名的多语言落地**：即八舰集群模板 + 六共用包的新显示名（含场景命名/能力族命名）按 A 的形状录入（zh 主轨） | P1 | 与改名工作流同一批，别造两轮作者编辑 |

## 3. 不在范围

- **技能正文翻译**：SKILL.md/persona/预告脚本内容只保留一份（主人负责权责与效果），多语言不做标榜性宣称。国际化阶段如需内容翻译另行立项。
- **运行时契约字段**：`packId`、工具面声明、`registryName`、组闸/scope/计费键一个不动。
- **官网/物料双语文案**（fd-official-web / docs/marketing）——已另有 spec 管（product-portal、five-lines-collateral），不叠。
- 任何存量 pack 的强迁：字符串旧写法永久合法（主轨 zh），只在新版时自然升级。

### 3.1 口径增补（2026-11-01，add-mcp-annotation-overlay 推翻记账）

用户裁定（2026-11-01 explore 会话）**推翻本需求书 §3 第一条的排除面**：多语言范围**扩到供给内容的显示层**——MCP server / MCP tool / skill 三类对象增加「供给注释层」（human 五语言轨，zh 必填主轨；canonical brief 面向智能体）。具体口径：

- **仍排除**：SKILL.md/persona **正文**翻译（注释层只做显示名/一句话/何时用的策展，不改内容本体）。
- **新增的注释真源与优先级**：registry 行 `metadata.annotations`（JSON 透传，registry 侧零改码；两平面共读）> 仓库供给目录 `market-catalog.json` 的 `annotation` 键 > 上游原文。读时合并投影、零源行写；locale 解析与 zh 唯一回落复用 `lib/pack-locale.js`。
- **形状契约**：`lib/supply-annotations.js`（validateAnnotation/mergeAnnotations/projectAnnotation）——human.zh 必填（name≤60/summary≤200/whenToUse≤160 可选）、canonical.brief≤300、tools 子注释按叶名递归。
- **pack manifest 联动**：`mcpServers[]` 增可选 zh 主轨 `description`（≤300），`LOCALE_OVERLAY_KEYS` 增 `mcpServers`（按声明 registryName 覆盖），沿 `pack-locale-tracks` 既有校验器（同一校验器、无双规则）。
- **展示面**：壹座 MCP 卡/市场卡/聊天工具块/规格书工具桶与 facet 目录卡/深度页/技能卡按 locale 渲染注释；无注释对象逐字节照旧（「缺字段如实渲染、不发明」既律不变）。

## 4. 验收口径

1. **兼容性**：含 A 结构的 manifest 发布后，旧客户端（不读 locale 字段）表现与今天逐一比对等价；旧字符串 manifest 走新发布门照样通过。
2. **渲染正确性**：拿一个 zh+en 双语包：`locale=zh` 呈现中文名，`locale=en` 呈现英文名，`locale=ja`（缺） 回落中文名——市场 API 与客户端两处同口径。
3. **集群模板**：一个双语场景模板，壹座总览坞（见 owner 面需求书）与市场专辑页按 locale 显示对应名。
4. **发布门**：缺 zh、en 与 zh 字段长度差超过阈值、回落表断裂——三类失败各一条可读报错。
5. **禁辞同扫**：en 副轨文本走 docs/marketing/audit.py 同款 ABSOLUTE_CLAIM_RE 检查（中文主轨已扫）。

## 5. 命名口径（与本单绑定的用户裁决）

- 中文是主轨：场景名/功能族名等**主名用中文习惯**（用户原话「符合中国用户的使用习惯」），英文是副轨等义翻译，不是主导设计。
- 「舰队」词退场：对外只说「集群」（entry 名、类目名、文案统一），内部运行时标识不改（packId、字段名、spec id）。
- 岗位族→功能族词表：巡检员→监视/采集、主编→提炼/合成、投稿岗→产出/落稿、拍板→主人闸、构造师→编译、KPI 槽位→遥测槽位（字段 `kpiSlots` 不变）。
- 对外语气承接诚实口径：**「接管重复性工作、人退到主人位」**，禁绝对化替代表述（中英同轨）。

## 6. 与既有资产的锚

- manifest 形状契约主体：paas `lib/pack-manifest.js`（PACK_LIMITS）+ facet-pack-builder `validate_manifest.py`（真校验器）。
- 市场/商店渲染：壹座「设置→功能集」+ 谦面市场条目端点（台账在 MCP-REGISTRY）。
- 改名批次源：`fleet-packs/` 仓（六共用包+八舰模板），铸造配方见其 README，packId 台账不动。

## 7. 配套（不需要本单做的）

- finddata 根叙面 change `cluster-vocabulary-and-pack-taxonomy`（我会立项）：管辖**命名规则本身**——货架三分类、集群 vs 舰队遣散、场景/功能族/供给域命名法，本单把「结构能不能多语言」落在 paas 形态上，两边对表时认对方口径。