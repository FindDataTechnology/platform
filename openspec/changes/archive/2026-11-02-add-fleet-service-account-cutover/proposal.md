# Proposal: add-fleet-service-account-cutover

## Why

wire 侧已上线舰队专属服务账号（2026-10-29 交接单，change add-fleet-service-accounts）：Logto 专属组织 `svc-fleet`、服务账号 `svc-fleet-core-1`（billing 落 `svc/fleet-core-1`）、发号/护栏/探针配方固化。这正是我们 10-25 需求单（`docs/wire-logto-grant-policy-requirements.md` 第⑤项「舰队专属服务账号」）要的东西——舰队 wire-customer 链现由人类测试账号 `platform-test@findmail.com` 担观测主体，归因脏、事故连坐、口令不在我方。切换本身是一次重铸，但探索发现照交接单字面做会踩三个结构性坑，必须同批定义清楚：

1. **身份分两层**：`line-credentials` 的 mint 回调按 **platform 会话邮箱**（cell 属主）落行键，token 主体才是 wire 侧归因——行键必须保持 platform-test，只换授权主体；换错层舰队 cell 直接选不中凭据。
2. **周期重铸数学断裂（独立 P1，先于切换修）**：`automation-4665497d` 每 12 天 09:00 查、触发阈 <36h，而稳态下检查点恰落在墙前 48h——阈值永不触发；下一次检查（11-06 09:00）距 11-07 22:37 墙 37.6h > 36h，admin 两行会在墙后约 10 天才被「已过期」分支救回。且中途手工铸币（含本次切换）会让相位偏离，任何固定阈值都盖不住——唯一无相位漏洞的策略是**每轮检查无条件重铸**。
3. **护栏相撞**：wire 侧 `fd-svc-guard.sh` 把浏览器 UA（Mozilla 前缀）的 svc 登录判为敌情告警，而我们的 playwright 铸币默认 UA 就是 Mozilla——切换当天会把自家动作报成人工登录。需铸币脚本统一 tool UA（护栏已认 `mint-line` 前缀）。

## What Changes

- fleet cell（`3fdc7b8e`）的 wire-customer 链用 `svc-fleet-core-1@finddatatech.cloud` 重铸一次：授权主体=服务账号、行键=platform-test（cell 属主）不变、billing 归 `svc/fleet-core-1`；旧 platform-test 舰队链自然弃用（11-07 到点，不再管）。
- `automation-4665497d` 提示词两步改写：①（本批先行）重铸触发改为**每轮无条件**，删除「12 天后无缝衔接」的错误表述；②（切换日）把 fleet 行纳入覆盖范围，措辞区分「行键 platform-test / 链主体 svc / 归我方管」。
- 铸币脚本配方固化 tool UA 约定（`mint-line/paas-1`）+ 新浏览器上下文 + 注入 platform-test 的 `paas_session` cookie（免碰 platform-test 平台口令）→ interactive 腿登 svc。
- 口令收存进 `.env`（gitignored），不入库、不进日志；知会 wire 切换时刻，配合其 §四 复核三点。
- 红线入台账：svc 双号禁任何人工交互式登录、禁改密/禁用（=舰队链全灭，只有周期重铸碰它们）。
- 非目标：cell 属主不迁移（不做 cell 重注册）；`svc-fleet-ops-1` 备用链位本批不启用；不动 wire-tester2 行（仍属 wire）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `line-credentials`：新增需求「舰队无人值守链以专属服务账号铸造，且周期重铸无相位漏洞」——规定两层身份的归因语义、每轮无条件重铸的覆盖承诺、服务账号使用红线。

## Impact

- 运营面：`automation-4665497d`（ZCode cron 提示词）、`.zcode/tmp` 铸币脚本配方、paas `.env`（svc 口令）。
- 生产数据：fleet cell `3fdc7b8e` 的 `user_line_credentials` wire-customer 行被 svc 链原子替换；admin cell 两行仅重铸节奏变化。
- 上游/协作：wire 侧需交付口令（本地 fd-wire 检出停在 10-27，`docs/TEST-ACCOUNTS.md` 未落本机，gitee 远端有新提交）、确认 svc 零角色成员对 wire-customer SPA client 可登录+首连 consent；切换时刻知会；wire §四 复核回填。
- 台账：`docs/registry-maintenance.md` §15.85+ 记录切换与自动化修正；无产品代码改动。
