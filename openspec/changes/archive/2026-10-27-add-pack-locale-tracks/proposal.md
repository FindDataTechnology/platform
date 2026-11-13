# Change: add-pack-locale-tracks

> 需求书:[docs/pack-i18n-requirements.md](../../../docs/pack-i18n-requirements.md)(产品叙面会话 2026-10-27)。
> 用户裁决:「多语言要支持、但中国主市场,命名符合中国用户使用习惯」——中文为必填主轨,多语言为形态副轨。
> 姊妹单:add-vendor-supply-open / add-fleet-owner-surface / add-fleet-owner-iteration / add-market-revenue-share;
> 命名口径向 finddata 根 change `cluster-vocabulary-and-pack-taxonomy` 认表。

## Why

pack 形态的显示字段(name/description/guide/fleet 模板显示字段)全链只有单语言纯字符串。命名体系大改(集群替舰队、功能族命名)与海外供给开放(add-vendor-supply-open)都在同一张契约上落笔——现在不把 locale 结构接上,改名批次将在单语字段上写死,将来每个存量包都要回炉。趁改名同批把结构一次接好,且不得破坏存量:「字符串直写视为 zh、旧包零改动」是硬约束。

## What Changes

- **manifest 叠加块(P0,A)**:pack manifest 新增可选顶层 `i18n` 块(`{ <locale>: { name?, description?, guide?, skills?, cluster?, card?… } }`,逐字段部分覆盖)。既有显示字段之字符串**永远是 zh 主轨且形状不变**——兼容性由构造保证,而非靠 `string | object` 双形容忍。需求书原文的「逐字段 map」建议经勘察否决:基字段变 object 会令现客户端渲染崩溃,违反兼容性验收(见 design.md D1)。
- **市场/读面 locale 解析(P0,B)**:市场列表/详情投影与 cell 安装包读面按 `?locale=` > `Accept-Language` 首项 > zh 的顺序解析显示字段;缺该 locale 或该键一律回落 zh 基字段。解析规则收敛在一个共享 leaf 模块,各客户端不复写。无参旧请求得到与今天逐字节等价的 zh 响应。
- **fleet 模板显示字段(P1,C)**:`fleet` 段 name、members[].title、kpiSlots[].label 接受同构 overlay(`fleet.i18n`);内置模板的 `nameKey/titleKey/labelKey` 机制原样保留;posts/cadence/kpiSlots/edges 等内部字段形状零改动;promptTemplate/persona 属内容层,**不进** overlay(需求书 §3)。
- **发布门校验(P0,D)**:`validatePackManifest` 增 overlay 规则——locale 键形、逐 locale 长度上限(与 zh 同帽)、结构一致性(guide 三步该 locale 要么全有要么全无)、en/zh 长度比率 ≤3:1、en 副轨禁辞同扫(docs/marketing/audit.py 的 ABSOLUTE_CLAIM_RE 同款);逐字段点名报错沿既有风格。facet-pack-builder `validate_manifest.py` 镜像规则同步。
- **存量改名落地(P1,E)**:八舰集群模板 + 六共用包的新显示名按本形状录入(zh 主轨 + en 副轨),与改名工作流同一批,不造两轮作者编辑。该批属内容工件(fleet-packs 仓),本 change 只交付形状与闸门。
- **需求书偏差记录(用户已拍)**:`tagline` 在 pack manifest 中不存在(需求书 §1 误植 blueprint `vertical.tagline`),本单**不新增**该字段;禁辞扫描现状仅覆盖营销物料审计,pack 发布门 zh/en 皆无——本单只对 en 副轨新设,zh 轨不顺带开扫(存量误报不进本单)。

## Capabilities

### New Capabilities

- `pack-locale-tracks`:pack 内容的 locale 契约——overlay 块形状与字段白名单、zh 主轨/副轨回落规则、locale 解析优先级、旧客户端/旧校验器兼容性不变量。

### Modified Capabilities

- `pack-marketplace`:发布门增 overlay 校验规则(逐 locale 上限、比率、en 禁辞、逐字段点名);市场浏览/详情按请求 locale 解析显示字段。
- `agent-fleet-templates`:模板显示字段(name/title/kpiSlot label)接受 locale overlay,内置模板 Key 机制不变,预校验对 overlay 形状拒非法。

## Impact

- **代码**:`lib/pack-manifest.js`(overlay 校验段)、新增 `lib/pack-locale.js`(解析/回落 leaf 模块,gateway-safe)、`gateway/packs.js`(summaryOf/详情投影接 locale 参数 + 发布门裁决段)、cell 读面(`server/routes/packs.js` mypacks)、`server/fleet-template.js`(fleet.i18n 解析)、web 类型面(`web/src/lib/packs-api.ts`)。
- **跨仓工件**(任务级,非 spec):facet-pack-builder skill 的 `validate_manifest.py` 镜像 + `publish_pack.py` 透传确认;fleet-packs 仓 `blueprints/schema.md` 文档扩 + 存量包改名按本形状录入(E)。
- **兼容**:旧 manifest(纯字符串)永久合法;旧 API 客户端(不传 locale)响应与今天逐字节等价;搜索 v1 保持 zh-only(冗余索引列存 zh 主轨文本,多语检索挂账)。
- **不动**:packId/registryName/工具面声明/组闸/计费键等运行时契约;SKILL.md/persona/promptTemplate 内容层;官网营销双语(另有 spec 管)。
