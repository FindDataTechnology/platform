## 1. 前置：凭据到位 + 登录路径预演

- [x] 1.1 口令到手——**gitee fetch 路径作废**（wire 10-29 回复：凭据总表 `docs/TEST-ACCOUNTS.md` 位于 finddata 根 docs/，设计上不进任何 git 仓），带外直送已随转发单送达；核对=两号 email/口令与在册 sub `ohvn98ztddjj`/org `kfq3i47bv5p8` 对应确认（2026-10-29）
- [x] 1.2 svc-fleet-core-1 与 svc-fleet-ops-1 口令入 paas `.env`（`WIRE_SVC_FLEET_CORE1_PASSWORD`/`WIRE_SVC_FLEET_OPS1_PASSWORD`，gitignored 实证），全程不回显、不入库不进日志（2026-10-29）
- [x] 1.3 登录路径彩排——**wire 侧代跑完成（10-29 回复§三）**：ops-1+core-1 全链 登录→授权 code→offline_access RT→refresh 轮换 ✓，client=`i0oxdswqxv4x7te99iukv`（即我方 wire-customer 线 client），UA `mint-line/paas-1` 归 ok(tool)，即弃 token 不落行。**新事实覆盖 10-24 spike**：consent 非免屏、每授权交互必弹（不按用户记忆）——铸币固定四步=登录→授权页批准→code→token

## 2. 自动化改写

- [x] 2.1 `automation-4665497d` 重铸触发改**每轮无条件**（行龄恒 ≤12 天），删除「<36h 临期才铸、12 天后再查无缝衔接」的相位漏洞表述，并预防性写入「禁止改回条件触发」——完成判据=11-06 09:00 那轮总结见两行均重铸、stale=0、exp≈+14d，11-07 22:37 墙不再裸奔（已实施，2026-10-29）
- [x] 2.3 铸币载体脚本加固（`recheck-admin-chains.mjs`）：上下文 UA=`mint-line/paas-1` + **每 mint 的 consent 兜底点击**（落在 ISSUER 原点=授权页，点批准再等回跳 `/settings/connections`）+ ERROR 分支不再让 `new URL` 崩——语法校验过（2026-10-29；11-06 无人值守轮即依赖此载体）
- [x] 2.2 （切换日）改写 `automation-4665497d` 范围：fleet cell `3fdc7b8e` 的 wire-customer 行纳入覆盖（措辞显式区分「行键 platform-test@findmail.com / 链主体 svc-fleet-core-1 / 归我方管」），仍属 wire 的其余行保持排除——完成判据=提示词行清单与两 cell app.db 实际行逐一对得上（已实施 2026-11-01：CronList 实证提示词含 fleet 行管辖段+铸币/验收配方三脚本 `forge-cookie.mjs`/`mint-svc-fleet.mjs`/`read-row.mjs`；wire-tester2 保持排除）

## 3. 切换执行

- [x] 3.1 知会 wire 计划切换时刻（窗口 11-01–11-05 wire 已确认、无需双轨；UA 约定 mint-line/paas-1 已被接受并实测归 ok(tool)）——完成判据=wire 回复收到切换时刻（2026-11-01：切换时刻 19:34 CST 已达 wire，其 A3 收口报告 §八记载「3.1 所候『收到切换时刻』即此条」）
- [x] 3.2 切换铸币：全新浏览器上下文（UA=`mint-line/paas-1`）+ 注入 platform-test 的 `paas_session`（产 pod session-secret 免密码通道，不碰 platform-test 平台口令）→ 顶层导航 `/api/lines/wire-customer/mint/start` → interactive 腿登 svc → **固定四步=登录→授权页批准（consent 每次必弹，wire 实测）→ code → token**——完成判据=该行 token 主体=`ohvn98ztddjj`、stale=0、hasRefresh=1、exp≈+14d、`[line-credentials]`/`[mcp-delivery]` 日志正常且无 token 本体（**2026-11-01 19:34 CST 完成**：wire 只读复核 行 updated_at=11:34:11.930Z、stale=0、RT len=43、行键未动、sub=`ohvn98ztddjj`；Logto SignIn.Submit 该 uid 24h 恰 1 条 19:34:07 CST=单发无重试，与全新上下文一次铸币自洽。壹座侧独立行读因 prod 取证 SSH 隧道当日断路顺延至 4.2 证据轮，带连通性兜底）。**11-02 补记**：该链当夜 20:48:59 被行外刷新竞争杀死（同窗 admin 两行齐死，详见台账 §15.123 补记），07:42:28 已重铸复活（行读 stale=0/sub 不变，墙=11-15 07:42）；死因定谳待 wire Logto 审计
- [x] 3.3 wire §四 三点复核：新 grant accountId=`ohvn98ztddjj`／platform-test 其余活跃链不受影响／用量归属 `svc/fleet-core-1`——完成判据=wire 侧 change 台账回填并同步确认（**2026-11-01 wire A3 收口**：①grant accountId ✓ ②其余链零受扰（admin 真人行 19:50/19:54 自然重铸照常、fleet lex 行 10-23 未动）✓ ④护栏口径 mint-line/paas-1=ok(tool) ✓；`add-fleet-service-accounts` 12/12 归档 c2cccf9 推 gitee main；**③用量归属→4.2 随首轮巡线补录（双方约定）→ 已随 4.2 补录（11-02 壹座侧真回合证据在案；billing 归因行由 wire 台账承载）**；另事实修正采信：token_exp 列=ID token exp（mint+1h）、14 天墙在 RT 侧，旧链 10-31 起已断供——切换兼修复）

## 4. 收尾

- [x] 4.1 `docs/registry-maintenance.md` 台账更新：切换记录（时刻+两行对照）、两层身份措辞、红线入册（svc 双号禁人工交互登录/改密/禁用，只有周期重铸碰它们）、自动化新策略（每轮无条件）——完成判据=§15.85+ 成文（**2026-11-01 §15.123 成文**，台账号跳至 15.123 避让 agent-builder 线在用的 §15.122，循跨 worktree 同号异题去重律）
- [x] 4.2 切换后一轮巡线回合自然落观察：巡线 ok、`wire_artifact_get` 200、无 stale——完成判据=巡线回合证据一两条（含 billing 归 svc/fleet-core-1 的用量行抽样）（**2026-11-02 过门**：巡线岗真回合 **status=ok**（fleet jchvsd/m_8vv79l，10:04:16-10:05:27 CST，usage 917/607=真实 LLM 回合）；09:00 miss 系 cell 闲置 cron 缺席，唤醒后 boot 补跑+repair-queue 重入队+手动 run（POST cron/:id/run 未改配置）落地。行侧双证：10:04 boot sweep `[line-renewal] wire-customer renewed`（+wire-ops 入 profile+mcp-delivery attempt 1 重启）与 11:28 周期续期 stale=0/sub=ohvn98ztddjj/RT 在。billing 归因=wire 侧台账承载（其已核 svc 三客户零行，待自然消费转行））
