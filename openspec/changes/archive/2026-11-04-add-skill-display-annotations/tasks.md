# add-skill-display-annotations — Tasks

## 0. bridge 读位修复（实施期实测发现）

- [x] 0.1 `registry-bridge.js` `mapSkill` 注释透传补 fallback 读位：registry API PUT 把自定义 metadata 键收纳进 `metadata.extra`（实测落点 `metadata.extra.annotations`，262+10 卡已灌）——`plainMetadataAnnotations(s.metadata?.annotations ?? s.metadata?.extra?.annotations)`；mapServer 同位置一并核对（server 卡不受影响则零改）。**后续订正（R1=方案 B 回执，docs/skill-annotation-contract-reconciliation.md §七）：extra 落点系序列化事故、不进读面——本项 fallback 已废弃，mapSkill 改为与 mapServer 同构 `mergeAnnotations{registry 顶层 metadata.annotations > 仓库 skills 键}`**

## 1. pack-locale 投影（腿3）

- [x] 1.1 `lib/pack-locale.js` skills 块增 `name` 投影：读 `i18n.skills[<name>].name`，仅当基条目声明 `title`；**实施期语义修正——overlay 的 name 值落 `title` 显示字段而非覆盖 `name`（slug 是运行时身份永不移动，zh 逐字节直出、zh 显示名=基轨 title）；正反用例+fleet/official-locale 测试 15/15 过**
- [x] 1.2 单测：双语技能显示名投影（title 承接）、未声明 `title` 零改、`name` 覆盖无 `title` 对位防御性忽略、zh 请求原对象直返（内联用例全过）
- [x] 1.3 发布门 lockstep：`lib/pack-manifest.js` 基轨 title 校验（≤60）+ overlay `name` 对位闸 + `lib/pack-locale-coverage.js` titled 技能 `.name` 覆盖义务（与 finddata validate_manifest.py 同口径；official-locale-gate 5/5、en-merge 5/5 过）

## 2. 壹座扩展页投影（腿2a）

- [x] 2.1 `extension-store.js` 增文件技能注释装载：仓库注释源 `skills` 键（服务端技能名索引），装载失败降级空表（沿 market-annotations 既有纪律）——落点 `lib/market-annotations.js`（skillsMap + getRepoSkillAnnotation，origin 两值闸 + 同款 validateAnnotation 门 + 非法弃条告警；真文件冒烟过）
- [x] 2.2 `server/routes/extensions.js` `GET /api/extensions/skills` 接 locale 解析（显式参数 > Accept-Language > zh）+ 分流投影（**实测该端点只有文件技能+DB 自定义技能——registry 来源技能在市场目录不走此端点**，故文件技能走仓库注释源 yizuo-file 域；DB 自定义技能属用户内容不注释），注释条目增 `annotation` 键、无注释逐字节不变（test-external-source-endpoints 6/6 过）
- [x] 2.3 单测：见 scripts/test-skill-display-annotations.mjs（投影回落+弃条+降级 5/5 过；端点级两路分流以 external-source-endpoints 6/6 回归兜底）
- [x] 2.4 市场目录技能卡同规则渲染（spec「市场目录条目 SHALL 同规则渲染注释」补位）：`MarketSkill` 类型增可选 `annotation` 键（与 MarketMcpServer 同形）；`SkillMarketCard.tsx` 注释存在时 human 通俗名替代裸 `displayName`、等宽 slug 保留旁显、summary 替代裸 description，无注释逐字节原渲染；数据链实测=桥 mapSkill（`skills` 键 mergeAnnotations）→ mergedMarketCatalog 两域合流 `annotation` → `GET /api/extensions/market` 既有 project() 覆盖 skills → web tsc 全绿

## 3. chat 索引扩 skills 键（腿2b）

- [x] 3.1 `getSupplyAnnotationIndex(locale)` 产物增 `skills` 键（技能名 → `{label, summary}`，文件技能←仓库注释源 yizuo-file 域；索引失败降级空键，test-supply-annotation-store 4/4 过）
- [x] 3.2 技能调用块渲染：`SkillBlock.tsx` 注释存在时 slug 旁显通俗标签（label 引领 + 等宽 slug 保留），索引查无渲染不变；tsc 全绿
- [x] 3.3 单测：test-skill-display-annotations 覆盖索引键数据源与投影；块渲染不变式=查无 ann 时走原分支（SkillBlock ann null 分支）

## 4. 联调验收

- [x] 4.1 与 finddata 协同单对契约（paas 侧收讫）：以真实 `market-annotations.json` 装载断言——`skills` 键按技能名索引、`origin ∈ {registry, yizuo-file}`、形状走同款 `validateAnnotation`（`test-skill-display-annotations.mjs` 用例 1/3 过）；与 finddata 5.3 双侧互验全绿
- [x] 4.2 真机验收：facet 滚 sha-c3d7527 后线上实测——谦面 skills 目录 `?locale=zh` 268/268 中文、`?locale=en` 268/268 英文（contract-review→中文合同审查/Chinese contract review）；壹座扩展页与 chat 块随 platform 镜像（sha-1d3ebf6 源 c3d7527e ⊇ 本单）同源生效
- [x] 4.3 回归对账：投影全部是「有注释才加 `annotation` 键、无注释逐字节原样」的加性形状（代码分支断言+弃条用例过）；既有测试面回归：registry-bridge 9/9、supply-annotation-store 4/4、official-locale-gate 5/5、en-merge 5/5、fleet-template-locale 10/10、external-source-endpoints 6/6、web tsc 全绿；安装键/闭包闸零改（slug 与 identity 字段未动，projection 仅落 title 显示字段）。无注释面线上全量逐字节比对并入 4.2 真机验收
