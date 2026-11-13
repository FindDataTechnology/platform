## Context

现状四块地基（探查实证）：① pack manifest（`lib/pack-manifest.js`）已有 skills/mcpServers/agents（persona+serving 契约含 rhythm 节奏）/cluster 段，发布与安装两侧同源校验；② 舰队模板（`server/fleet-template.js` + `fleet-provisioner.js`，spec agent-fleet-templates）已支持 pack `fleet` 段=members+requires，六份官方种子在 `docs/fleet-templates/*.seed.json`，守恒测试钉住；③ 编导代数（`server/fleet-orchestration.js`，spec agent-fleet-orchestration）只在活舰队写面生效，事件源只认 `bot:<botId>`；④ bot 面（`server/bots.js` + `bots/adapter.js`，BOT_TYPES=telegram/feishu/wecom/wechat-oa）是运营者 admin 配置的通道适配器，webhook 走路径 secret 信任边界。市场侧：facet 独立部署（`facet/`），现存 69 pack，三类重复（同名建重 3 对 / 数据域双线 6 包 / CRM 两市场包+内置种子），演示验收包 3 个公开在列。

约束：fleet-template.js 被 gateway 进程 import（不能引入任务引擎模块图）；pack 哲学=不自带端点/凭据、单向不覆写外来内容；「未声明段逐字节等价」是既有 spec 铁律。

## Goals / Non-Goals

**Goals:**
- 装包即得完整混合舰队：模板带编导、bot 可声明、tool 岗可声明。
- bot 成为与 skill/MCP 并列的第三原语，通用 bot 平台托管、pack 只引用+挂技能。
- 市场目录单一事实源：同名防呆闸治本，存量重复/演示包治理清账。

**Non-Goals:**
- 不做 pack 自带 bot 实现/通道凭据（安全边界不动）。
- 不做模板新版自动迁移现役舰队（既有铁律不变）。
- 不做法律样例包（法律-合同/法律-案件）与识律套件的合并（用户未裁决）。
- 不动 cluster 段与 fleet 段的既有分工（cluster=会话小队，fleet=岗位组织）。

## Decisions

**D1：bot 原语形态=「通用类型引用+单技能挂载」，不是自带 bot 定义。**
备选（pack 自带通道参数/适配器定义）违反 pack 无凭据哲学且跨 cell 不可移植。v1 通用类型集只有 `channel`（出站投递+入站事件源；挂技能后入站先经技能会话作答）——出站复用既有四种通道适配器，入站复用既有 webhook 守卫（尺寸/频次/路径 secret）。后续类型（如通知类）平台演进追加，pack 生态渐进受益。

**D2：bots 物化落点=既有 bot 存储 + 目录 bot 面，冲突策略克隆 agentOwner。**
新增 `botOwner(botId, excludePackId)`（另一个已装 pack 或 cell 既有 bot 占用→skip 带原因），安装报告/卸载预览镜像 skills/agents 的形状。通道凭据未配置→bot 以待连接+禁用态存在（启用是运营者显式动作，webhook 攻击面不因装包扩大）。数量上限 `PACK_MAX_BOTS`（默认 3，env 可调，与 PACK_MAX_* 同族）。

**D3：模板编导校验单源=validateOrchestration，岗位域换成模板成员集。**
`parseFleetTemplate` 增解析 `orchestration` 段；发布预校验（gateway）与实例化共用 `validateOrchestration({members: 模板成员投影})`。前提：`fleet-orchestration.js` 保持纯校验模块（无任务引擎副作用 import）——任务里先钉这个纯度（import 面检查+测试），不满足则把纯校验抽独立文件。provisioner 落编导走既有舰队写面的 orchestration 写路径，不直写第二格式。

**D4：tool/bot 目标进模板=加法枚举，缺位运行期如实判定。**
`TEMPLATE_TARGET_KINDS` 增 `tool`（target.id=工具名）与 `bot`（target 引用 pack bot id 或既有 bot id）。解析复用活舰队 `resolveTarget` 既有分支；缺位→待补岗降级（与 a2a 同哲学），编导边引用的是岗位 ref，不因目标缺位而丢失。

**D5：同名防呆=发布闸拒绝，不做自动并版，不开 admin 发布豁免。**
自动并版对内容做语义假设（危险）；豁免会重新打开建重口子。清理既有建重走管理面 unlist。闸的 author 匹配用 authorEmail 精确匹配（作者身份必须精确匹配是既有教训）；跨作者同名放行（归 curation）。

**D6：数据域收编映射表（先并版、后 unlist、不删版本）。**

| 退役包 | 承接的柏讯套件 |
|---|---|
| 数据-股票估值 v3 | 柏讯·估值套件 |
| 数据-股票 v3（老样例） | 柏讯·估值套件（样例技能差异并版） |
| 数据-区域经济 v3 | 柏讯·区域经济套件 |
| 数据-行业企业 v3 | 柏讯·行业与企业套件 |
| 数据-宏观分析 v3 | 柏讯·宏观研究套件 |
| 数据-中国经济 v4（老样例） | 柏讯·宏观研究套件（样例技能差异并版） |

保留（产品工具面假设，未收编）：数据-指标工坊、数据-自助分析、数据研究·生态版、市场快讯·一页速览。

**D7：CRM 合一。** 保留「CRM 客服套件」（category crm，承接内置 `packs/crm-desk-suite` 铸造源），unlist「CRM 客服接待套件」；仓内 `packs/crm-desk-suite` 仍是清单真源，市场为唯一分发更新通道。

**D8：演示/验收包 unlist 清单**：向导验收·双子、一键流验收、部署演示·FingPt 分析师。保留：谦面工坊/谦面助手/谦面市场助手（平台自身功能面）。category 补齐以既有 slug 惯例（fleet/daas/legal/crm/facet/docs）。

## Risks / Trade-offs

- [fleet-orchestration 被 gateway import 拖入任务引擎模块图] → 实施第一步钉纯度（import 面静态检查+无副作用测试）；不纯则抽 `fleet-orchestration-validate.js` 纯文件，活舰队写面改 re-export。
- [bot 物化扩大 webhook 攻击面] → pack bot 出生=禁用+待连接；启用与凭据是运营者显式动作；既有 webhook 信任边界（路径 secret/尺寸/频次守卫）零改动。
- [市场清理误伤既有订阅者] → 所有动作用 unlist 不删版本；清理前导出订阅数与版本快照留档；re-list 可逆。
- [同名闸误拒正当改名场景] → 错误信息带既有 packId 与升版路径；真改名走「unlist 旧包→发新包」运营动作。
- [种子升级与守恒测试互相踩] → 种子编导升级与守恒测试扩展放同一任务交付。
- [模板编导与活舰队写面校验漂移] → 单源决策 D3 + 「模板落地边与手写边行为一致」对照测试。

## Migration Plan

1. 代码面（paas 仓）：校验器单源→模板编导→bot 原语→种子升级，全测试绿后出片。
2. facet 先行灰度上同名闸（独立部署，先堵新增建重）。
3. 市场清理（管理 API）：建重 3 对→数据域六包（先柏讯并版升版、后 unlist）→CRM 合一→演示包 unlist→category 补齐；每步留快照，可 re-list 回滚。
4. 官方种子 v2 铸造上架（带编导），生产探针验证装包→实例化→编导生效→bot 唤醒全链。
5. 回滚：代码回滚不影响市场数据；市场动作逐项可逆；已实例化的编导舰队在代码回滚后按「未声明段等价」语义退化为无编导（岗位与节奏不受影响）。

## Open Questions

- 通用 bot 类型集 v1 之后的第一批类型（通知/巡检提醒等）——不阻塞本 change，平台演进追加。
- `PACK_MAX_BOTS` 默认值（暂定 3）——实施时可按真实套件需求微调，不影响契约。
