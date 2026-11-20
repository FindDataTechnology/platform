# 集群改名别名与货架分视图 · paas 侧需求书

> 交付对象：paas 实施者。来源：finddata 根 change `cluster-vocabulary-and-pack-taxonomy`（2026-10-27，strict 绿）——「舰队」对外退场说「集群」、八集群模板+六共用包以「显示名走新版、id 不动」改名上架（市场新版已发 v2–v6）。本单管**平台侧怎么接住这次改名**；与《pack-i18n-requirements》《fleet-owner-surface-requirements》《fleet-platform-supply-open-requirements》四份互为姊妹，spec 以立项稿为准。

---

## 1. 问题

改名按「packId/内部 id 不动、显示名走新版」原则完成：

- 13 个在册 pack 已发新版（6 能力包+7 集群模板，见 `fleet-packs/README.md` §packId 台账新旧对照），**市场条目 id 不变**。
- 但平台侧有两处会被旧名卡住：
  1. **模板的 `_casting.packDependencies` 以包名为引用键**——共用包已改成「能力包·族·题」新名，集群模板新版的依赖键同步为新名；平台在做同 cell 安装/依赖解析时若按名查找，必须能在市场回新旧名（否则查不到「fleet-brief-report」旧引用，也理不出「能力包·合成·简报与报数」新绑定）。
  2. **在跑集群实例外显名**——实例绑定的是模板 packId 与岗位 `title`（如「指标巡检员」）。岗位 title 已在模板新版改为职能词（监视位/合成位/产出位/闸位/归账位/构造位），但**已实例化的集群对象的既有 title 存储不动**；owner 面/总览坞显示的实体名如果直接读历史 title，就会出现新旧两种词同时在线上。
- 市场货架需要一个「我要集群」和「我补零件」的**分门视图**：集群模板/能力包/供给包 三类要独立入口（当前只有 category 字段粗栅栏）。

## 2. 范围

| 编号 | 交付物 | 优先级 | 说明 |
|---|---|---|---|
| A | **名称别名服务**：平台侧对每个在册 packId 提供「当前显示名 + 历史名」映射（来源=市场条目最新版名与台账旧名）；**依赖解析以 packId 为主、按名查找带别名回落** | P0 | 13 个 pack 的对照表由 finddata台账提供（README §packId 台账），其余包退化为现名即别名 |
| B | **显示名取最新版**：市场条目/壹座商店页/总览坞渲染 pack 名一律取该 packId **当前已发布最新版的 manifest.name**，不缓存旧版名 | P0 | 不许出现「装到新版本还显旧名」 |
| C | **在跑集群实例的岗位显示名别名**：owner 面/运行面显示岗位名时，按「模板最新版 title」显示；实例内部绑定（ref/kpiSlots/orchestration edges）零改动 | P1 | 别名读改不改键——历史 ref（如 `zx-patrol`）绝不变 |
| D | **市场货架分视图**：集群模板（category=fleet）与能力包（category=fleet-shared）与供给包各占独立专辑入口；壹座「设置→功能集」同名视图 | P1 | category 字段无非空兼容；专辑标题用「集群模板/能力包/供给域」三字头 |
| E | **owner 面骨词统一**：owner 面 UI/文档新版文案以「主人/主人闸/遥测槽位」骨词组为中英主轨（「拍板」可作等义并现），不再出现巡检员/主编/投稿岗类岗位称谓指 agent 位 | P1 | 内容洗词在 finddata 侧台账完成后对齐 |

## 3. 不在范围

- packId/市场条目 id/ref/kpiSlot 键/orchestration 字段形状——一个不动；
- 运行时校验与动作闸/提案制语义——照现有规则；
- pack 内容的多语言形态（属《pack-i18n-requirements》单）；
- 任何存量 pack 的强制重发（自然向新版涌即可）。

## 4. 验收口径

1. **别名回落**：在测试 cell 装一台仍以旧依赖键（「fleet-board-contribution」）的集群模板能解析到 `Mo3_aWe7tF2eFVzkqFT9mA` 并完成同 cell 安装；
2. **显示一致**：市场页/壹座商店页对该 pack 展示新名「能力包·产出·看板投稿」，同一 id 下看不到旧名残留；
3. **实例不换名**：改名后已注册在册实例的 ref/kpi 键原样，owner 面显示其岗位 title 为新职能词；
4. **分门视图**：市场专辑三视图准确（集群模板=7+31±、能力包=6、其余=供给包），无串台；
5. **骨词扫描**：owner 面新文案上对「巡检员/主编/投稿岗」按 agent 位零命中、对「拍板」只作等义副词（对主人闸）。

## 5. 与 finddata 侧台账的对供关系

- 新旧名对照表：`fleet-packs/README.md` §packId 台账（13 行），可用作别名初值；
- 词表：spec `pack-taxonomy-and-naming`（finddata 根）为主轨；
- 别名原则已在 spec 写明：**id 不动、显示名走新版、实例靠别名**——本单的实现细节（HTTP 契约/存储字段形状）由 paas 会话自行决定，不依赖 finddata 侧再开面。
