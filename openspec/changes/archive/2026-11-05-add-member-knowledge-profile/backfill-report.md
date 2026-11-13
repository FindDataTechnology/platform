# 生产存量回填报告（add-agent-memory-foundation 回填命令）

- 执行时间：2026-11-05 10:0x CST
- 执行位置：`cheap-ts` 集群 `fd-prod/fd-memory-8cff5f98b-7w74m`（镜像 sha-636e5ea，FD_MEMORY_DATA=/data）
- 命令：`node scripts/backfill-metadata.mjs`（地基单回填命令，经 /tmp dist 副本加 `PRAGMA busy_timeout=30000` 后执行；未动产 dist，跑毕已清 /tmp 临时件）

## 三跑记录

| 跑次 | roots | scanned | files | backfilled | skipped_with_metadata | unmatched |
|---|---|---|---|---|---|---|
| dry-run | 66 | 6868 | 6882 | 6 | 2171 | 4691 |
| 实跑 | 66 | 6868 | 6882 | 6 | 2171 | 4691 |
| 幂等复跑 | 66 | 6868 | 6882 | **0** | **2177** | 4691 |

## 判读

- 命中 6 页 = 地基上产前遗留的 `[kind][memberId] ` 前缀存量页，已补 metadata（标题零改写，双轨读成立）。
- 2171 页已自带 metadata = 地基写面上产后新页天然一等化，无需回填。
- 4691 unmatched = 非舰队事实标题（词表外，宁漏不过原样跳过）。
- 复跑 backfilled=0 且 skipped 增 6——幂等铁证，符合 spec「回填幂等」场景。
