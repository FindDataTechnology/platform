## Context

动机见 proposal.md；行为契约见 specs/line-credentials（ADDED：服务账号铸造 + 无相位漏洞的周期重铸）。本设计的输入是三个已核实的现状事实：

1. **行键=平台会话邮箱**：`server/routes/line-credentials.js` 的 mint 回调以 `identity(req).email` 落 `user_line_credentials`；fleet cell（`3fdc7b8e`，属主 `platform-test@findmail.com`）的 profile 生成按属主邮箱选行。授权主体（token sub）与行键是两层，切换只换后者不换前者。
2. **周期检查点与墙的关系**：`automation-4665497d` 每 12 天 09:00 触发、条件「临期 <36h」；绝对租约=铸币+14 天。重铸只发生在检查时刻 → 稳态下检查点恒落在墙前 48h，36h 窗永不触发；铸币若在检查相位之间（切换当日即是），固定窗策略照样漏。现网 admin 行墙 11-07 22:37，下次检查 11-06 09:00 距墙 37.6h——不修必断。
3. **护栏 UA 分类**：wire 侧 `fd-svc-guard.sh`（xinru cron 08:50）扫 svc-fleet 成员 `Interaction.SignIn.Submit`，UA 以 `Mozilla` 开头=ALARM，工具类（`fd-svc-probe`/`mint-line`/`curl`）=记录不告警。playwright 默认 UA 是 Mozilla——自家铸币会报成敌情。

## Goals / Non-Goals

**Goals:**
- fleet 链观测主体切到 `svc-fleet-core-1`，billing 归 `svc/fleet-core-1`；platform-test 行键与 cell 归属零迁移。
- 周期重铸对 admin 两行即刻止血（11-06 前），并在切换日把 fleet 行纳入同一无相位漏洞策略。
- 铸币链路对护栏静默（tool UA），对红线合规（新会话、走 platform mint 回调通道）。

**Non-Goals:**
- 不迁 cell 属主/不重注册 cell；不启用 `svc-fleet-ops-1`（备用，本批仅做登录路径彩排）；不动 wire-tester2 行（仍属 wire 自铸）；不做「先铸后切双轨」（新授权原子替换同一行，双轨无意义）。

## Decisions

**D1 行键保持 platform-test，只换授权主体（否决 cell 重注册）。**
备选=把 fleet cell 属主迁到 svc 邮箱：目录哈希、装包、舰队归属、审计 actor 全链迁移，远超交接单要求；且 wire §四复核看的是 grant 主体（`ohvn98ztddjj`）不是我方行键，保持行键即可全过。代价=fleet cell 该行的键与 token 主体不同名，须在台账与自动化措辞里显式写明「行键 platform-test / 链主体 svc / 归我方管」，防止未来会话误读。

**D2 铸币走 headless 注入会话，不走人工浏览器。**
配方：产 pod `/data/auth/session-secret` + `signSession({email: platform-test, groups, exp})` 铸 `paas_session`（免 platform-test 平台口令）→ 全新浏览器上下文塞 cookie → 顶层直接导航 `/api/lines/wire-customer/mint/start` → prompt=none 因无 Logto 会话回 login_required → 既有 interactive 重试路径 → Logto 登录页填 svc 口令（上下文 UA 覆盖为 `mint-line/paas-1`）→ 回调落行。人工浏览器方案否决：同租户 prompt=none 会静默复用浏览器的 platform-test Logto 会话铸出旧主体（白切），且默认 Mozilla UA 触发告警。
wire 10-29 实测追加固定第四腿：**提交口令后 consent 页必现且每次授权都弹（不按用户记忆，wire-console 非第三方也无跳过开关）**——脚本须在 consent 屏点「授权」按钮后再等回跳（`recheck-admin-chains.mjs` 的 mint 循环已加兜底点击，10-29）；纯 API 替代=对该交互会话 POST `/api/interaction/consent` body `{}` 后跟随 redirectTo（Logto 1.42 consent/index.ts）。refresh 轮换不重弹 consent，仅初始授权要批。

**D3 周期重铸改每轮无条件，否决调大阈值/缩短周期。**
阈值类（含 72h）只修稳态相位，修不了「中途铸币」相位——切换本身就制造一个。无条件重铸顺带多送一层安全：轮中铸币失败时旧链仍在墙前半程，下轮重试即可，而条件式在临期才铸=失败即断。12 天周期+无条件=行龄恒 ≤12d < 13d 验收口径。

**D4 切换单次原子执行。**
mint 回调成功才 `store` 替换行（token+refreshToken 同行原子写），失败路径不动旧行；旧 platform-test 舰队链自然弃用至 11-07 到点，无人再碰（它也只剩这一行在用）。

**D5 口令收进 paas `.env`（已验证 gitignored）。**
备选=1Password/k8s secret：自动化提示词按本机 env 读取即可，引入新凭据设施不值当；纪律=不入库、不进日志、不回显。

**D6 彩排——已由 wire 代跑闭环（10-29 回复 §三）。**
ops-1/core-1 全链：登录→授权 code→offline_access RT 发放→refresh 轮换 全 ✓；client=`i0oxdswqxv4x7te99iukv`（wire-console SPA，即我方 `/api/console/auth/config` 下发给 mint 用的 client）；UA `mint-line/paas-1` 归 ok(tool)；即弃 token 未落持久行。此结论**修正 10-24 spike 的「首连免屏」**：consent 每次授权交互必弹、不按用户记忆——按 D2 固定四步吸收即可，paas 侧无需再自跑彩排。

## Risks / Trade-offs

- [svc 零角色对 wire-customer SPA client 的授权面] → **已消解（wire 10-29 代跑彩排）**：登录/授权/RT 发放/轮换全 ✓；残留仅 consent 每弹=已由 D2 兜底点击吸收，脚本载体 10-29 已加固。
- [无条件重铸每轮杀旧链换新链] → 同行原子替换、续期网按新 rotator 接管；换来的是零墙空窗，trade-off 可接受。
- [fd-wire 本地检出落后（10-27），TEST-ACCOUNTS.md 不在本机] → 执行第一步 fetch/pull 核对；拿不到即请 wire 带外交付，切换日前置阻塞。
- [admin 行轮中重铸失败] → 旧链距墙 ≥2 天，下轮自动重试；期间续期网正常。
- [platform-test 在别的 cell/线仍有活链] → 自动化只点名指定行；svc 铸币属不同 user+client，机理上不互杀（10-24 23:57 反例已证）。

## Migration Plan

1. ~~fd-wire fetch~~ → **带外送达（10-29，wire 回复§一：TEST-ACCOUNTS.md 设计上不进任何仓）**：口令核对在册后入 `.env`——已完成。
2. ~~ops-1 登录探针彩排~~ → **wire 代跑完成（10-29 回复§三）**，consent 必弹结论入 D2 固定四步。
3. 切换日（11-01–11-05，wire 已确认）执行 D2 铸币：断言行 stale=0/hasRefresh=1/exp 全新、日志无 token 本体。
4. 同批改 `automation-4665497d`：fleet 行纳入覆盖 + 措辞按 D1（无条件重铸部分已先行上）。
5. 知会 wire 切换时刻 → wire §四 三点复核 → 台账 §15.85 回填 + 红线入册。
6. 回滚策略：无回滚需求——svc 行 stale 时按同一配方重铸即恢复；platform-test 旧链弃用是终态。

## Open Questions

- ~~切换时刻窗口~~ → **已定**：11-01–11-05，单次原子切换，wire 10-29 回复§二确认；platform-test 旧链切换后自然闲置至 11-07 22:58 壁钟到点，无需处置。
- `svc-fleet-ops-1` 何时启用（运维巡检需要第二链位时按交接单 `provision` 语义自行取用，不在本批）。
