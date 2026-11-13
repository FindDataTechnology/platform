# add-legacy-pack-rebrand

## Why

词表 v4（集群→智能体团队 / 阵列→小组 / 能力包→智能体 / 能力市场→智能体市场）落地后，存量资产出现
三类不齐：①**在仓种子/官方包的显示名**仍带旧词（`集群架构师（官方种子）`、`萬星舰队助手`）；
②**长尾市场包**的旧名（`萬星舰队助手`、dash 型 `数据-指标工坊`/`数据-自助分析`）与散类目
（daas/docs/data/authoring/company）不归位；③官方种子的中文显示名在词表 v4 后语义漂移
（「集群架构师」编的是团队，不叫集群）。承接 `docs/legacy-pack-name-cleanup-requirements.md`
（2026-10-27 需求单）的 A1/A2/B1 项，按 v4 词表执行。

## What Changes

- **在仓资产改名**（id/packId 零动，显示名走新版）：
  - `docs/fleet-architect.seed.json`：`集群架构师（官方种子）`→`团队架构师（官方种子）`，
    agent 显示名 `集群架构师`→`团队架构师`（en 副轨已是 Team Architect）；
  - `docs/official-packs/wanxing-fleet-assistant-manifest.json`：`萬星舰队助手`→`万星机群助手`
    （机群=桌面/部署机群语义，与 `nav.fleet`=机群一致；en 副轨 Wanxing Ops Assistant 不变）；
  - persona/技能正文里的自称同步（架构师 persona 的「集群架构师」→「团队架构师」等）。
- **长尾市场包改名**（市场操作，非代码）：`萬星舰队助手`→`万星机群助手`、
  `数据-指标工坊`→`数据 · 指标工坊`、`数据-自助分析`→`数据 · 自助分析`，以「id 不变、显示名走新版、
  发新版本」执行（作者身份纪律沿需求单：admin 账号包走平台作者面）。
- **category 归位**：散类目（daas/docs/data/authoring/company）向「线（供给域）」语义统合的
  展示映射——市场浏览按类目筛选时呈现归位后的线词，历史 category 值零迁移（展示层映射，
  curation 端点写入仍收原 slug）；`company` 六分身由 badge=facade 承担，不在主货架按类目展示
  （需求单 B2 的展示面部分）。
- **六自种子显示名**：已在 `add-ai-native-lexicon` 裁定的新名（AI 公司/内容流水线/晨报情报站/
  投研晨会/客服班组）确认在仓种子与市场同步；本次只补「架构师」种子与万星助手两个漏网。
- **不改**：packId/作者面/分组关系/版本纪律/价格（需求单「不在范围」全数沿用）；已发布版本的
  immutable 语义（改名=发新版本）。

## Capabilities

### New Capabilities

- `pack-category-line-mapping`: 市场浏览的类目→线归位展示映射（散类目统合到线词、分身由徽章承担、
  历史值零迁移）。

### Modified Capabilities

- `native-lexicon`: 官方种子显示名按 v4 词表更新（架构师=团队架构师、万星助手=机群语义）。
- `pack-marketplace`: 长尾包改名走「id 不变、显示名新版、发新版本」通道（既有纪律的执行案，
  无新语义；类目展示走 line-mapping）。

## Impact

- **在仓**：两个 seed/manifest 文件的显示名与 persona 自称 + en 副轨核对；`scripts/test-fleet-templates.mjs`
  等种子测试若钉了名字需同步。
- **市场（运营）**：三个长尾包发新版改名；category 归位为 facet 市场浏览的展示映射
  （`facet/web` 列表分面 + `marketplace-json.js` 的 category 投影，读面映射、零数据迁移）。
- **验收**（沿需求单 §5）：市场 listing/search 无「舰队」字样包名；dash 两名换新；分面不再出现
  daas/company/docs/data/authoring 散词；主力套件零变化。
