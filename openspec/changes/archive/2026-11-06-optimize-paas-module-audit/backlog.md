# 壹座（paas）模块体检 · 第二遍增量对账 backlog（2026-11-06）

> **与第一遍的关系**：同日已有归档单 `2026-11-06-optimize-yizuo-module-audit`（八簇 A–H，253 spec，P0×2+P1×14+P2 批）。本单是同日的**独立第二遍**（十簇 G1–G10，267 模块，卡在 `findings/cluster-{G1..G9,G8b,H7-1..5-6,Ha,Hb}.md`），两遍在关键结论上互印（无系统性漂移、债集中在跨仓归属/措辞滞后/测试网缺口）。**本 single 只列：①第一遍条目在本遍的复核态；②净新增问题；③战役内已顺手修掉的事项。** 第一遍条目不在本单重复列。

267 模块总账 `ledger.md`；评级口径五项检查：spec↔code 对齐 / 测试 / 部署态 / 痛感 / 陈旧度。

## 一、第一遍条目的复核裁定（本遍独立验证）

| 第一遍条目 | 本遍复核结论 |
|---|---|
| P0-1 e2e-testing spec 反向条款（D） | ✅ 已修：align-yizuo-specs-to-reality（90acfaf10）批内改写现役 tab 集 |
| P0-2 supply-store 三重失真 | ✅ 属主会话已收口（38cb9fed 等三连），本遍未复现 |
| P1-1/P1-2 cron-module 单位与补跑矛盾 | ✅ 已修：spec.md:61 现文=补跑容忍窗口径（2× 周期/6h 地板/开关），「SHALL NOT catch up」原文不存在 |
| P1-3 值班环只认 cron 表达式任务 | ⚠️ 复核仍成立（`lib/cell-lifecycle.js:115` 谓词未扩），保持 open |
| P1-4 vertical-packs 权威指针 | ✅ 已修（align 批 90acfaf10 同单） |
| P1-5 chat-input-focus 悬空 | ⚠️ 复核仍成立，保持 open |
| P1-6 caller-preferences 跨仓悬空 | ⚠️ 复核仍成立，保持 open |
| P1-7 跨仓归属无注记成族 | ⚠️ 本遍新增同类一条：ecosystem-access / ecosystem-curation 需求主体在 mcp-gateway-registry 外部仓（见下 N-18） |
| P1-8 Purpose TBD 5 处 | ✅ 已修（align 批 Purpose 回填） |
| P1-9~P1-14 | 本遍未独立复验（不在十簇抽样面），以第一遍为准 |
| P2 批（注释/枚举/名实/卫生） | 本遍未重复；新见 net-new 两条见 N-19/N-20 |

## 二、已销账（11-06 本遍内闭环）

| # | 事项 | 处置 |
|---|------|------|
| ~~S-1~~ | agent-delegation-tools spec stale 35 天 | ✅ 实为行号引用腐烂（10-02 后唯一行为变化=fetch 超时纪律，归属 harden-cell-execution-reliability）；mini change 按名引用修正并归档（72947b040） |
| ~~S-2~~ | agent-cluster-core「测试停摆」 | ✅ 复核推翻：fix 提交 7cd3a4448 自带测试增量，实测 platform 8/8 + tasks 21/21 + boot-guard 2/2 = **31/31 绿**；审计日期法被 fork 全量提交干扰 |
| ~~S-3~~ | agent-runner 代际分裂（runner-b lag 1395） | ✅ manifest 滚 `sha-ca6a7b4`（公开快照线，digest 0e4ee127=真源 417cf71b4 内容），rollout 绿；**决定 replicas 维持 0**（5fc4d8b 缩容前提仍成立：配额墙 ca9f82e 36→38Gi 第十次顶满），runner-c 在役车道不主动滚。途中抓出 relay 缺口：同名 tag 已入 seen 账本即永不重拷（ccr 上 ca6a7b4 曾挂 10-31 旧内容） |
| ~~S-4~~ | G7 chat 面 e2e 老化（chat-history 107 天等） | ✅ 三 spec 实测全绿（history 2/2、layout 2/2、turn @smoke 2/2）；turn 失败=测试漂移（UI 后加 activity-group/turn-usage/头部行 chrome 未剥离），剥离清单已跟上（b3581402e） |
| ~~S-5~~ | G9 挂账「paas e339636e cron 冷启动修复」 | ✅ 祖先律实证已推已出片（origin/main、部署镜像源 dde77c3a、tag 三处全过） |

## 三、净新增（第一遍 backlog 未列）

### P0 — 资产/契约险情

| # | 问题 | 证据 | 建议动作 |
|---|------|------|----------|
| N-1 | **伙伴介绍文档含明文 sk- 密钥+密码，且不在任何 git 仓**（单副本、无 diff 审计、误删不可恢复；同文件还是 trial 账号凭据唯一落点） | cluster-G5（`/Users/chengsishi/finddata/docs/ciyuan-intro.md` 7390B，`git rev-parse` fatal；grep 见 12 处密码/sk-） | 11-06 已做防护副本 `secrets/ciyuan-intro-20261016.md`（chmod 600，md5 一致）；**待定**：真源迁受控仓或拆凭据入 secrets+文档脱敏，并评估密钥轮换 |

### P1 — 实质缺口

| # | 问题 | 证据（卡） | 建议动作 |
|---|------|-----------|----------|
| N-2 | auth spec 剪刀差 37 天，期间 29 commit（公开路径白名单/双模身份分支）未回写；身份门面是全平台信任根 | G8 | spec 回写 |
| N-3 | miniprogram-auth 合同与代码形状出入：spec 称共享实现，实为 gateway/index.js:329 与 server/routes/mp.js:26 两套路由并存；spec 38 天 stale | H7-3 | 合并实现或 spec 如实改写 |
| N-4 | forward-auth spec 落后 49 天；auth.js 已成多轨共栖宿主（n=29 f=9，31%），豁免清单每扩一条=新信任边界 | H7-2 | 补「信任边界台账」节奏 |
| N-5 | permission-mode-selection spec 40 天剪刀差（危险确认对话流） | H7-3 | spec 回写 |
| N-6 | registry-market-deployment spec 与生产现实脱节 36 天：读路径已切 facet 投影，spec 仍钉 REGISTRY_URL 直喂 | G8b | 随 W2 存储合并一并回写 |
| N-7 | pack-visibility spec 32 天 stale 且可见性真源分散在其它 change | G3 | 下次触碰以本 spec 为轴收拢 |
| N-8 | fleet-scheduler 是无 spec 的活体控制环（shadow）：gateway/fleet-scheduler.js 257 行在产，specs/ 无在册条目 | G4 | 立 spec（含冷重建/热会话丢弃语义） |
| N-9 | pack-marketplace 单文件 3538 行承载 registry+路由+物化+结算（packs.js 71/15 + facet/ 70/19，34 刀 fix 未收敛） | G3 | 拆分+回归护栏优先 |
| N-10 | marketplace-cluster-view 的 ?agents= 桶滤无任何 e2e/专测（注释自曝同类回归已发生过） | G3 | 补断言测试 |
| N-11 | ciyuan-embedding-lane：spec「维度不符 SHALL 拒绝」整链零校验（grep dimension/1024 零命中），一致性只押账号级 provider 钉扎单点 | G5 | 补维度校验+无价 fail-closed |
| N-12 | 视频/图像生成是已上产 shadow 能力面（/v1/videos*、contents/generations/tasks 在产，9 spec 无一规定协议/计量/失败语义） | G5 | 立 ciyuan-video-lane capability |
| N-13 | project-identity spec 102 天未回访（全簇最旧）+ project-database 43 天（db.js 45 commit 后未跟） | Ha | 后者 store/migration 面先回写；前者刷日期+核对 |
| N-14 | user-runtime-bindings 50 天 / tenant-cell-runtime 35 天 stale（回写导致 spec 反超代码日期） | H7-5-6 | 纳入回写节奏 |
| N-15 | chat-streaming 热点无子契约单测（agent-session.js fix 52%，13 条 Requirement 追修复式演化，全靠 e2e） | G2 | 补 streaming 单测 |
| N-16 | desktop-supervisor 唯一专用测试停 09-13（滞后 45 天），supervisor/ fix 33%；web-operate-states 危险确认零专测 | G7 | 各补定向测试 |
| N-17 | dsh-profile.js n=67 f=24（全簇最高）而定向测试停 10-11~14；dsh-plugin-supply 宿主写穿逻辑零单测 | G9 | 补宿主侧护栏 |
| N-18 | first-run-bootstrap / local-services-launcher：spec 均停 09-08（50/51 天），两模块合计零专测（写坏一次全盘不可启动）；memory-eval 评测无 CI 强制门 | H7-2 / G6 | 重启测+spec 回写；CI 门补或改口径 |
| N-19 | drag-drop-upload（D）：spec 94 天未动，「不支持类型→415」实证 422，「粘贴入文档」无实现点；document-management-ui spec 48 天 stale | H7-1 / G6 | 重新立项对齐或降格条款；spec 回写 |
| N-20 | cell-lifecycle 唯一现网未部署修复 94ec620f（fix(wake) 三 re-arm+205 行专测）正落全簇最痛文件（n=150 f=58）；workspace-selection 同批中招 | Ha | 下次滚镜像销账，滚版时点名验 wake |
| N-21 | blueprint-studio 铸造链死锁连环 5 刀（自愈叠自愈） | G4 | 专项清理 cast 前置闸+provenance 判定矩阵 |
| N-22 | ecosystem-access / ecosystem-curation 需求主体在外部仓 mcp-gateway-registry，本仓仅消费侧可证 | Ha | 记「跨仓能力」+spec 权威指针（vertical-packs 先例） |

### P2 — 卫生/观察（净新增）

- **registry-lineage 自家 compose 浮动 tag**：docker-compose.prebuilt.yml:603 `mcpgw:${MCPGW_VERSION:-latest}` 撞自家铁律；fork HEAD 与生产 /opt checkout 对应关系未证实。
- **市场令牌链路不可证**：MARKET_REGISTRY_TOKEN 只在带外 Secret，DEPLOY.md:681 续期注记停 09-25，缺 token 时静默回落 bundled catalog；:694 示例键名与 manifest 读键不一致。
- **落地页精选悬置**：landing-config.yaml 只挂空 featured.json，「仅改文案不出镜像」需先补 ConfigMap。
- **H7-5/6 期望态 14 模块 spec 全缺失**（有实现无契约）——先立 spec 或反向提炼。
- **隐私合规零实证**：personal-information-protection / privacy-compliance-audit 无导出/删除/最小化收集/合规报表实现点（product 拍板）。
- **chat-chart-rendering 31 天 / chat-plan-progress 39 天 stale**；chart-refresh 已迁 chart-data-binding 但本 spec 未回链。
- **doc-studio 零模块专测**；agent-fleet-cockpit 专测未随定稿演进；agent-teams-overview / agent-builder-hub 无断言型专测；agent-service-config 唯一 e2e 26 天未动。
- **artifact-contract** remote fork 契约行未含 save_to_library 同回合入库教学（只在 SKILL.md）。
- **release-pipeline / ci-pipeline（C）**：60 天 23/33 修集中 windows/桌面/装机验收腿——腿基建固化。
- **browser-use** 60 天 6 连同类 fix（截图输出路由）——配置面收敛。

## 四、修复建议分组（在第一条建议之上追加）

1. **纯 spec 文本批**：第一遍的 P0-1/P1-2/P1-4/P1-8/P1-9~14 已由 align 批消化；本遍追加 N-2/N-3/N-4/N-5/N-6/N-7/N-13/N-14/N-19(部分)/N-22 → 一个 align 批。
2. **代码微批**：N-11 维度校验、N-15 streaming 单测、N-16/N-17 测试护栏、N-20 滚版即销、N-10 桶滤测试。
3. **立项批**：N-8 fleet-scheduler spec、N-12 video lane、N-21 cast 矩阵、N-18 CI 门/启动测。
4. **资产处置**：N-1 凭据文档真源归位+轮换评估。
