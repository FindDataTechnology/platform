# Proposal: add-unified-memory-and-outputs

## Why（用户原话收口）

三部分人话合并成一条主线：

1. 「壹座的产出和资料库的界面急需一个统一的记忆系统解决方案，而且要萬星也能用」——记忆已在多产品流动，但没有任何界面看得见它、没有产品间的一致缝。
2. 「我希望有一个整体的记忆和产出的解决方案，包括输入和输出」——输入面（记住手势）与输出面（召回读缝 + 浏览面）一起统一。
3. 「产出很多，文档也可以存储，但是没有分类和分等级，这个蛮伤的」——成果/资料库存量只有文件扩展名九个机械组，草稿与终版报告同权重；需要分类与分等。

**既有架构底盘**（不为本提案重述）：memory-architecture-v2（ADR-0030）定案「底座自有 + 引擎开源 + 零 LLM 热路径 + supersede 不覆盖 + 四平面正交收编」。本提案是新线——**库不合并，缝统一**：四平面仍正交（转录/轨迹/资料库/工作记忆保持各自物理库），但写入手势、记忆服务、读取车道、浏览界面在所有产品上收敛到同一套。

## What

一条主线配五大件，其中四件是本 change 的实施范围：

1. **类别与分等数据模型进 fd-memory**（`fleet-memory` + `memory-distiller` 修改）：新增 `reference` 页型（资料库/成果薄索引：标题、摘要、tags[]、tier、来源指针）；**三级分层** `draft|stable|canonical`（草稿/成果/正典——人机同读，AI 可读激励语义：canonical=可信任引用，draft=可复用别当准）；tags 由蒸馏车道自动提议（预算门），人类/AI 在面上一键修正，修正动作本身写回记忆使蒸馏器学词表；降级用现成 supersede 链（可下钻、可撤销）。
2. **壹座成果页升级**（`resource-library` + `resource-library-ui` 修改）：成果/资料库页新增 tags 列与筛选、tier 徽章与三层收纳、「记住/钉正典/改 tag」三手势；存单元行携带 tier/tags 的去规范化快照（真源在 fd-memory reference 页，行存镜像以支撑列表高效查询）。
3. **记忆浏览面**（`memory-visibility` 修改 + `memory-portal-ui` 新建）：壹座 web 新增「记忆」面板（owner 看自己的 u/），萬星 console（fleet surfaces）部署者看自己部署的 d/（Q3 权利终上桌），共用一个读取面与筛选语义（scope/layer/tier/tags/time）。
4. **召回读缝全消费方对齐**（`chat-memory` 修改 + fd-memory digest 规则）：digest 读缝加 tier 优先 + citation-by-name 规则（资料库命中引用名份而非拖正文，控 token）；facade/智语回合接入同一条读缝（与壹座 chat 同一预算纪律）。
5. **文档底座**：ADR-0030 v2 → v2.1（统一入口/出口/分类分级收编为长期真源）+ 部署文档预算分表。

## Capabilities

### New Capabilities

- `memory-portal-ui`：人类可读的记忆浏览统一面——壹座 web「记忆」面板（owner 看 u/）+ 萬星 console 部署者 d/ 浏览，共用 visibility 读面的筛选语义与空态治理；修正手势（改 tag/tier）从浏览面写回记忆。

### Modified Capabilities

- `fleet-memory`：新增 `reference` 页型（薄索引：标题/摘要/tags/tier/来源指针）与三级分层语义 `draft|stable|canonical`；digest 读缝加 tier 优先与名份引用（citation-by-name）规则。
- `memory-distiller`：成果/资料库打标支线——tags 提议与 tier 候选写回 reference 页（「AI 提议」标记、per-owner 预算门）；人类修正 note 回灌学习词表。
- `memory-visibility`：读取面扩至 reference 页并支持 tier/tags 筛选；person/rootKey 语义不变，agent 零扩权。
- `chat-memory`：facade/智语回合接入同一 digest 读缝（同预算纪律），游客与登入居室各回各 owner。
- `resource-library`：成果/资料库存单元行携带 tier/tags 镜像字段（真源为 reference 页）；手势写面（记住/钉正典/改 tag）；auto capture 建时自动落 reference 页。
- `resource-library-ui`：成果页三层 tier 收纳、tags 列与筛选、tier 徽章、「记住/钉正典/改 tag」三手势（AI 提议徽标明示）。

## How（主线 succinct）

```
输入面: 记住手势三处 (chat 消息钉 / 资料库勾 / 成果标)
        + 会话边界 observation (已在产) + 成果产出 → experience/reference 页
              │
fd-memory: reference 页 + tier/tags + supersede 链  (真源)
              │  digest 读缝 (tier 优先 + 名份引用)        │  visibility 读面 (filter=scope/layer/tier/tags)
输出面: 壹座 chat ✔ / cron ✔ / fleet ✔ / facade ○新    壹座记忆面板 ○新 / 萬星 console ○新
                                        + 成果页 UI 读镜像列
```

## Non-goals（红线，FAQ 位）

- **本体不搬家**：资料库文件与成果文件继续住在原仓，fd-memory 只存薄索引页。
- **四平面不收编**：转录/轨迹/资料库/工作记忆仍物理正交；统一的是缝与面，不是库。
- **L3 profiles 不进本版**；共享 namespace 不作为 Scope+Grant 声明机制以外的方式出现。
- **agent 不因可见性面扩权**：person 令牌看 u/、deployer 经 platform lane 看自己 d/，agent 不动。
- 本版不做 L2 graphiti 时态图、不做「记忆版对外供应」（一个是独立姊妹单）。

## Impact

| 面 | 触及 |
|---|---|
| fd-memory 仓 | src/distill + http/digest 规则 + reference 页型 + tier/tags 模型；单测扩展 |
| paas 仓 server | resources/service 写拔（tier/tags 镜像 + 一概手势路由）; memory 读缝（facade/zhiyu 消费者） |
| paas 仓 web | ResourcesPage 大幅升级 + 新「记忆」页（u/）+ 部署者视角页入口 |
| 万星 console | fleet deliverable 同款 tier/tags 徽章与浏览面（d/ via platform lane） |
| OpenSpec | 修改 `fleet-memory / memory-distiller / memory-visibility / chat-memory / resource-library / resource-library-ui`，新建 `memory-portal-ui` |
| 文档 | docs/memory-architecture-v2.md → v2.1；docs/site-deploy-requirements.md 预算分表 |
| 风险 | 蒸馏打标成本（必须 per-owner 预算门）；成果页去规范化镜像与真源一致（memory 单写纪律）；facade 读的规模门（智语游客千万读面须在限流里） |

## 验收方向（精炼）

1. 成果页三层收纳与 tags 筛选在真机上可见、可手势修正，修正即回灌记忆。
2. digest 读缝在壹座 chat 与萬星 facade 同一条线上可见 tier 优先生效（canonical 先），资料库命中为名份引用。
3. 记忆浏览面板在壹座 web 与萬星 console 两个入口同一份读取面数据。
4. 蒸馏打标日耗有预算门证据（usage_logs 可归因）。
