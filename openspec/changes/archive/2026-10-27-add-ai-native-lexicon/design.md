# Design: add-ai-native-lexicon

## Context

见 proposal.md §Why。关键现状约束：① 词汇老律（2026-10-24 已上产）= 键/API/字段零改、只翻可见值；② web 端用户可见文案集中在 `web/src/locales/zh-CN/common.json` 与对应 en locale，快照 CI 有 locale 闸；③ 市场条目由 facet/registry 服务供给，manifest 是徽章推导的唯一真源；④ 五枚官方种子在 `docs/fleet-templates/*.seed.json`，其 `name` 字段是清单真源的一部分、有测试锚钉；⑤ CMS 双语课程（documentId ialhphcq8nk7n2qvcqk9fkk2）已发布，改版属内容侧动线。

## Goals / Non-Goals

- Goals：用户侧词位统一（集群/阵列/能力包/能力市场）；市场徽章结构化推导并可读时生效（存量条目免重发）；供应商命名规约成文，作为 `add-vendor-supply-open` 的前置口径。
- Non-Goals：不改任何代码键名、API 路径、事件名、spec 目录名；不回改历史台账与已归档 spec；不改 zhiyu 词汇v3 / 分身口径 / 运营者终词；不重命名/改 packId 任何已发布条目。

## Decisions

1. **徽章在读取时推导，不在发布时物化。** 市场列表/详情响应按需计算 `badge`（依据 manifest 有无 fleet/cluster 组织块、有无 facade serving 契约角色、有无 agents），不落库、不进 manifest。
   - 备选：发布时计算并存储 → 否决：存量条目需要重发才获得徽章，且结构变更（后续版本改 manifest）会与存量记录漂移；读时推导零迁移、天然单调正确。
   - 代价：列表查询每行多一次轻量结构判断——O(1) 字段存在性检查，无量化成本。
2. **locale 只改值、键逐物清点。** 每张改动表（zh/en 对照）在 tasks 里落成「键 → 旧值 → 新值」清单供翻译闸与 review 核对；`技能包`（zip 上传物）显式列入不动清单，防止顺手误翻。
3. **种子显示名换名不换文件。** `docs/fleet-templates/*.seed.json` 的 `name` 改为新显示名，文件名/packId/占位符契约不动；钉住「清单真源」断言的测试只需同步期望值，不放宽断言。
4. **供应商规约 = 徽章制，不审后缀。** 发布门对 display name 不做词汇校验（除既有的长度/注入守卫），类型表达的唯一通道是徽章。这避免开放供给后永无止境的命名审查。
5. **CMS 课程改版只出清单。** 本 change 的 tasks 产出改版项（zh/en 两文档、哪些段落/截图涉及「舰队驾驶舱」），重发动作由内容侧执行，不阻塞出片。

## Risks / Trade-offs

- [en 侧 Fleet→Cluster 与外部文档/截图时差错位] → 出片备注在台账记账，CMS 改版清单同窗执行，过渡期内旧截图视为冻结历史不追回。
- [「萬星集群」等外部 a2a 集群旧用法与新「集群=常设组织」撞词] → 语义顺势兼容（外部集群即集群平台的对外成员），不改名，仅在新增对外文案中沿用新义。
- [老动态 cluster 的既有用户心智（我创建的「集群」列表一夜之间变「阵列」）] → 空态/列表文案一次性换新即可，无迁移成本；如用户社区有反馈，以 changelog 口径解释「你创建的集群现在叫阵列」。
- [并行在途 change（add-pack-locale-tracks 的 E 改名、供给开放四单）撞同一批 locale 键] → 本 change 先行落地者为准，后到者 rebase；tasks 里显式标注联动顺序。

## Migration Plan

单次向前滚动、纯展示层：① locale 值更新 + 徽章推导上线（同班镜像）；② 二次铸造时五枚种子换显示名（不强制立即——下次任一原因重铸即带走）；③ CMS 课程改版清单移交内容侧。回滚 = 回滚镜像，无数据迁移、无残留状态。

## Open Questions

- 徽章是否需要进入市场搜索过滤（filter=badge:蓝图）？可后续单独立项，不阻塞本批。
