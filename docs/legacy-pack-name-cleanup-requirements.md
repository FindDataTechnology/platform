# 长尾 pack 旧名清扫与类别归位 · paas 侧需求书

> 交付对象：paas 实施者（含平台种子维护者）。来源：2026-10-27 市场 76 包全盘点——主力套件（wire 20 + legal 6「〈域〉 · 〈套件〉」）与 cluster 改名批次（14 包）已经合规；本单是剩余的**长尾道的杂项清扫**。姊妹单元：《集群改名与货架分视图》《pack-i18n》《蓝图工作室》。词表真源=本仓存档 change `add-ai-native-lexicon`（lexicon-map.md）。
> 若 change 承接后本单作验收视图；实施以 paas 会话为准，勿对修本单（任务台账防撞车）。

---

## 1. 问题

两类长尾不干净：

**A. 旧名不干净**（与现行词表不一致）：
- 仍在用「舰队」旧词的包：`INdsRWpgpp2Q03I0z3XoFA` **萬星舰队助手**（badge=助手）。
- 仍在用 dash 型旧式命名的包：`oGURb41bdyAotVGOeBHZUA` **数据-指标工坊**（v3）、`50Tp176hW0HYTTWXZbarKA` **数据-自助分析**（v3）（主轨道是「〈域〉 · 〈名〉」点式）。
- 六自种子（官方）的旧名：客服护航舰队 / 公司式舰队 / 情报站舰队 / 投研晨会舰队 / 内容工厂舰队 / 舰队架构师——已由 archived change `add-ai-native-lexicon` 裁过新名（AI 公司/内容流水线/晨报情报站/投研晨会/客服班组），**等下次铸造上架才生效**，本单只强调需日期可追。

**B. 类别不干净**（category 与线归位不一致）：
- `daas` 类目包（ev5E…快讯/Aqag…生态版/oGUR…指标工坊/50Tp…自助分析）+ `docs`/`data`/`authoring` 散项：词组为 DaaS 时代目录；2026-10-23 用户已裁 DaaS 为柏讯（wire）线产品， category 与线归位应统一至「线（供给域）+ 功能字眼」而非零散自造类目。
- `company` 类目×6（分身 demo 物）已可被 badge 识别，但该类目对市场是误导性：考虑在分货架下统一由 badge=facade 承担，类目就收为单个展示词。

## 2. 范围

| 编号 | 交付物 | 说明 |
|---|---|---|
| A1 | **长尾改名批次**：上列三老（萬星舰队助手→萬星机群助手 或沿新词典词；数据-指标工坊→数据 · 指标工坊；数据-自助分析→数据 · 自助分析）以「id 不变、显示名走新版、pool 名别」发新；**作者身份杂项注意**：admin@finddatatech.cloud 账号的包须走平台作者面（非 aloadtree 人名面） | 市场发新版 |
| A2 | **种子上架时点**：六自种子按 `add-ai-native-lexicon` 的新名在下一次铸造上架（同纪律：id 不动），本单验收=市场上旧名消失、新名齐警 | 与种子铸造仓镜像对齐 |
| B1 | **category 归位**：现行散类目（daas/docs/data/authoring/company）向「线（供给域）」语义统合；考虑新增/复用线词（wire/daas→wire、dash 散项归 wire/facet）+ 老类目别名校（必要的辄面回涵） | 不影响安装计账 |
| B2 | **分身 demo 在教育块展示**：company 六分身与 badge=facade 统一呈现到分身专位，不再在市场主货居式（待 paas 老板品相：可在发现页分块），**不下架** | 与 owner 面角色的牌架边对口 |

## 3. 不在范围

- packId/作者面指派/分组关系·版本纪律，零改；
- 主力套件（wire/legal/dash 之外散套）的名称再洗牌；
- 市场/badge 机制本身（`add-ai-native-lexicon` 仅是落点）；
- 供应商供给开放/分成账（姊妹单在魏）。

## 4. 已执行（finddata 侧备份备忘）

上架 admin 直连 facet store（备份=/data/facet/packs.db.bak-unpublish-20261027），已下架两整合前旧件：

- **`J9sO_wRCgUVjbYVEqD4Pog` 法律-合同 v1**（被 `识律 · 合同审查套件` v4 替代）
- **`_r1lL81mBSMTtvjraEwkJA` 法律-案件 v4**（被 `识律 · 诉讼文书套件` v5 替代）

下架=unlisted=1（规格语义：公开面隐藏、版本不倒、作者与管理员可见、无流水涂改）。若后续要恢复，将 unlisted 置 0 即可，**可逆操作，备份文件在库旁**。

## 5. 验收口径

1. 市场在 listing 与 search 结果中不再有**任何**「fleet/舰队」字样包名（种子上架后齐达）；
2. dash 旧式两名换新名在市场可检、旧名可经台账对追；
3. category 分面在浏览 tab 下不再出现「daas/company/docs/data/authoring」猥项字眼；
4. 不窜案：主力套件的类别、版本、安装订阅在本单执行期间零变化。
