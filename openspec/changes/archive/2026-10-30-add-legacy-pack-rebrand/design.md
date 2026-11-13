# Design: add-legacy-pack-rebrand

## Context

词表 v4（2026-10-30）五语言显示层已全量落地（`add-agent-teams-first-class` 内），但存量资产三层不齐：
①在仓两个资产的名字带旧词或旧语义（`集群架构师（官方种子）`、`萬星舰队助手`）；②市场长尾三名
（需求单 A1）；③散类目五个（需求单 B1）。既有需求单 `docs/legacy-pack-name-cleanup-requirements.md`
已盘点并划了范围（id 不变、显示名新版、类别归位、分身由徽章承担、不下架），本 change 是它在
v4 词表下的执行案。

## Goals / Non-Goals

**Goals**

- 在仓资产与市场长尾的用户可见名全部符合 v4 词表；类目分面按「线」呈现。
- 改名 = 发新版本（immutable 纪律不破）；类目归位 = 纯展示映射（零数据迁移）。

**Non-Goals**

- 不动 packId/agent id/作者面/版本纪律/价格/分组关系（需求单「不在范围」沿用）。
- 不做主力套件（wire 20 + legal 6）的再洗牌——它们已合规。
- 不做类目值的数据库迁移或 curation 端点语义变更。
- 不下架任何包（需求单 B2 明确「不下架」）。

## Decisions

### D1 · 「集群架构师」→「团队架构师」是语义修正，不只是翻词

该种子编的是智能体团队的组织结构（agent-fleet-core 一等公民），v4 后「集群」一词已不复指常驻组织；
续用旧名会让官方种子自我打脸。agent id（`fleet-architect`）与工具契约零动。

### D2 · 「萬星舰队助手」→「万星机群助手」走机群语义

该助手操作的是萬星的部署机群（agent 目录/部署状态），与桌面 `nav.fleet`=机群同一所指；
需求单 A1 已预裁此方向。en 副轨（Wanxing Ops Assistant）无需动。

### D3 · 类目归位做成读面映射表，不做数据迁移

`category` 是 curation 展示层字段（pack-marketplace「curation state is presentation-level only」），
本就与可见性/安装无关。归位 = 读面（listing 分面聚合 + facet/web 呈现）按映射表翻译 slug；
映射表部署侧可配（默认内置五散类目的归位），未映射 slug 原样呈现——保证未来新类目不被误吞。
curation 写入端点收原 slug 的语义不变，历史数据零触。

### D4 · 在仓改名与 en 副轨合班发版

`add-official-packs-i18n` 的 en 副轨随下一次发版才在市场生效；本次改名的 zh 显示名走同一批新版本，
官方资产不连发两版（tasks 3.2 合班纪律）。

## Risks

- **种子测试钉名**：`scripts/test-fleet-templates.mjs` 等可能断言旧名——改名必须同 commit 同步测试。
- **persona 自称漏改**：技能正文/persona 里的「集群架构师」自称是内容层（不进 overlay），必须逐处
  grep 手改，漏一处就会出现 UI 叫「团队架构师」而自我介绍叫「集群架构师」的分裂。
- **市场改名依赖发版权限**：长尾包属于 admin 账号，须走平台作者面（需求单已注记），运营侧执行。
