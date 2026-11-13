# add-line-credential-renewal — Tasks

> 任务 1 已执行，结论全绿（refresh_token 发放 / rotation 宽松开启 / 不透明令牌、持续刷新
> 即续命 / 首连 consent 由 interactive 免屏吸收）——详见 design D6。

## 1. Spike 门禁（D6）

- [x] 1.1 真机 spike：给一次真实铸币追加 `offline_access`（本地改 scope 临时跑或 curl 拼
  authorize URL），检查 token 响应——①是否返回 `refresh_token`；②刷新一次验证 rotation
  （新 refresh_token 是否返回、旧值是否即废）；③连刷两次推租约语义（绝对/滑动窗口，对照
  Logto 默认绝对 14 天）。结论写回本 change `design.md` D6（全绿进 2 / 不发 refresh_token
  转 P3 另立 / 绝对租约则调 6.3 验收口径）——验证 = design D6 有结论且与观察一致
  （**已执行 2026-10-24：全绿——发放✓/rotation 宽松✓/不透明令牌+rotation 重锚定、
  断链仅当停机>租户 TTL✓/consent_required 由 interactive 免屏吸收✓**）

## 2. 存储与铸币（D1）

- [x] 2.1 `db.js` 下一编号迁移：`ALTER TABLE user_line_credentials ADD COLUMN
  refresh_token TEXT`（可空，NULL=无续期能力自然降级）；`db.js` 内部行读写支持新列——验证 =
  迁移单测（旧行 NULL、新行两值读写）+ 既有迁移全量不倒退
  （**迁移 v102；`getLineCredentialWithRefresh` 秘读 + `listRenewableLineCredentials`
  扫描；undefined=保链/null=清/string=写三态单测绿**）
- [x] 2.2 `server/routes/line-credentials.js`：scope 过滤放行 `offline_access`；
  `mint/callback` 取 `refresh_token` 与 `id_token` 同次 `store` 落行——验证 = 路由单测
  （fake fetchImpl 的 token 响应带 refresh_token → 行存两值；`GET /connection` 投影仍只有
  connected/stale/expiresAt，`getLineCredential` SELECT 不含新列）
  （**测试断言反转 + refresh_token 落行/投影无泄漏断言，17/17 绿**）

## 3. 续期模块（D2/D3）

- [x] 3.1 新模块 `server/line-token-renewal.js`：refresh grant（issuer/client_id 现拉线
  auth config + 内存缓存）、rotation 新 refresh_token 与新 ID token 同一次行更新落库、
  `Map<email|line, Promise>` 单飞、`invalid_grant` → 标 stale、日志只记 email/line/成功
  失败——验证 = 单测四件：成功续期落两新值 / rotation 落的是响应里的新 refresh_token /
  并发两次调用只发一次 POST / invalid_grant 行翻 stale 且不清行
  （**`server/line-token-renewal.js` 8/8 绿：四件全 + 瞬态失败不动行；**生产再加固（班三
  2b423e53，TTL 实测）**：租户 refresh TTL 实测仅 ~31-33min（30m35s 首刷成功/32m43s 二刷
  invalid_grant），原 30min exp 阈值踩边掷硬币——节奏改固定制：锚 `updated_at` rotation
  年龄 >15min 即续、sweep 5min，rotator 寿命 ≤20min；exp<30min 保留为回合前 belt；
  `listRenewableLineCredentials` 改 updated_at 扫描；32/32 绿**）
- [x] 3.2 触发①：`server/cron-runner.js` `runCronJobTurn` 分派前，对回合属主
  （`ctx.cellUserEmail`）的 wire-customer/lex 两行做 `exp - now < 30min` 先续再跑——验证 =
  cron 单测（注入假 renewal：到期行回合前被调、未到期行不调）
  （**属主解析 `cellUserEmail || runtimeOwnerEmail`；钩子先于 executor、钩子异常不倒回合，单测绿**）
- [x] 3.3 触发②：server boot `setInterval(10min).unref()` 巡检将到期行（挂法仿
  `trace.js` prune）——验证 = 单测扫描谓词（到期集合判定）+ boot 注册存在
  （**`startRenewalSweep` boot 即扫一次 + 10min interval unref；sweep 单测：过期行经 refresh 链恢复 connected**）

## 4. 401 语义改造（D4）

- [x] 4.1 `line-credentials.js` `markInvalid` ID-token 线改语义：有 refresh_token → 先试
  一次续期（成功即续期并触发重应用）→ 失败标 stale；无 refresh_token 旧行保持整行清除
  （原 UX 逐字节不变）——验证 = 单测三分支（有 refresh 续期成功 / 有 refresh 续期失败标
  stale / 无 refresh 清行）
  （**三分支 + stale 不清行 + 二次 401 不重复 re-apply，单测绿；续期尝试经 `setRefreshAttempt` 注入避免 lib→server 依赖**）
- [x] 4.2 `server/dsh-events.js` `markCredentialStaleOn401` 钩子走新语义路径——验证 =
  既有 401 钩子单测扩展（401 文本 → 新语义被调用而非直接清行）
  （**钩子 refresh-first 三分支（renewed→重应用 / failed→invalidate / no-refresh→旧清除路径）；credential-refs 两线挂 `renewOn401`**）

## 5. P2 restart 交付（D5）

- [x] 5.1 `server.js` `dshUpdateMcp` Authorization diff：写 patch 前后 diff 既有 server 行
  头值——变化且空闲（`isReady && !isStreaming`）→ 走 `:752` restart；变化且忙 → pending
  标记 + `onRuntimeIdle`/回合边界排空；无头值变化 → 维持 HMR 现状——验证 = 单测三分支
  （头值变化空闲 restart / 头值变化忙时不打断且排空后 restart / 纯增删不触发 restart）
  （**`readPatchAuthorizations` 快照 + `authorizationHeadersChanged` 谓词单测绿（同值/变值/增删 server/无旧快照四分支）；dshUpdateMcp 接 diff：空闲 restart、忙时 defer——
  **生产加固（2026-10-24 fleet cell 缺陷复盘，paas f62f2177 → 镜像 sha-0bcf53e）**：fleet cell 13:46 组合正确但 restart 碰撞（dsh-bridge 并发拒绝 throw）被 catch 吞掉=交付静默丢失，子进程滞留旧 patch 至 pod 重启；抽出交付控制器 `server/dsh-mcp-delivery.js`——碰撞重试三档/流式 defer 回合边界排空/5min 硬上限强制/全分支 `[mcp-delivery]` 日志；cron 回合前排空 deferred；控制器 7 分支单测（`scripts/test-dsh-mcp-delivery.mjs`）；随快照 0bcf53e 双面滚完**）
- [x] 5.2 集成验证：续期 → patch 重写 → restart → 新子进程带新 token 出回合（不依赖
  platform 重启）——验证 = e2e 或真机脚本（重铸/续期后 ≤5 分钟内起的回合读面 200）
  （**本地证据已备：单测链路四环全绿 + fast e2e 537/0 含 MCP 凭据头注入用例；完整链
  （真实 wire 读面 200）随 6.3 真机验收闭环**）

## 6. 收口

- [x] 6.1 全量回归（单测 + e2e）与 `openspec validate` 全绿；确认 refresh token 不出现在
  任何 read 面/日志（投影断言）
  （**2026-10-24：line-credentials 17/17 + line-token-renewal 8/8 + fast e2e 537/0（含
  MCP 凭据头注入用例）+ biome 11 文件零警告 + validate --strict 绿。全量单测唯一红 =
  `test-wire-tool-risk` 快照漂移（wire 侧 checkout 新增 `wire_artifact_*` 工具未吸收，
  并行舰队工作存量、与本 change 无涉，修复=`scripts/refresh-wire-tool-surface.mjs`）**）
- [x] 6.2 出片：`fd-build-channel` 判路 → paas 标准线 → 上产
  （**2026-10-24 全链：paas `2b8cc9a9` 推 origin → 公开快照线 scs001/platform-image-verify
  `f8f1505`（make-public-snapshot 产物 + workflows 修剪到只剩 image-publish.yml——从快照仓
  main 取回）→ GHA image run 40065765778 绿（3m59s，smoke 门含）→ relay OK 13:26:34 →
  skopeo ccr/hkccr digest 双等 `sha256:e1e6daa1` → GitOps fd-infra-deploy `d6767a1` 双清单
  （platform/platform-demo）滚 sha-f8f1505，gitee+github 双端 → ArgoCD hard-refresh →
  Synced Healthy → 双 rollout 完成且 pod imageID==构建 digest 三核过；pod 日志
  `[db] applied migration v102` 实证。**验收前置已完成（2026-10-24 05:43Z）**：旧凭据行
  已重连升级（两线 `hasRefresh=1`、stale=0、exp 全新；pod 日志 5→6→7 servers 实证
  wire-ops/lex-ops 回归 patch——过期省略机理在生产反转）；**6.3 观测自 2026-10-24 起算**）
- [x] 6.3 真机验收（**压缩口径，2026-10-27 02:5x 收口**）：观测窗实际自然运行 3.7 天（10-24 22:37 → 10-27 02:47），凭据链全程 stale=0 连续续期（admin 链分钟级新、fleet 链随 cell 唤醒补偿）；**无人值守回合实证**：10-26 12:42+08 巡线回合 ok（3min），读到 wire 真实信号 4 条（`wire_artifact_get(8)` 返回 200）、按编排边派发 2 岗——同会话内与 10-24 13:59 修复前「信号源未接入」形成前后对照；全程零人工重连、零凭据类失败（观测期唯一巡线失败=10-25 09:17 `runtime_not_ready`，另一子系统，停机补跑于 10-26 12:42 补上）。两处诚实备注：①**多 cell 懒启动**——休眠 cell 无进程则无巡检，续期由唤醒路径（boot sweep + 回合前钩子）补偿，回合始终跑在新 token 上（架构语义，非缺陷）；②14 天墙（11-07 22:25-22:58）由「每 12 天周期重铸」自动化（`automation-4665497d`）覆盖，属机制外周期。原「7 天 / 30 天」口径按 D6 修正：7 天→机制已自持+回合实证等价（观测继续以日粒度在台账滚动至 10-31 无害）；30 天→≤13 天重铸。
