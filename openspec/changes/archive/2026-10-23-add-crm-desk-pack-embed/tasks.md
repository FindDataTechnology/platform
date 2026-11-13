## 1. 前置事实与活体

- [x] 1.1 Chatwoot SPA 登录态持久化形态活体探测（cookies vs localStorage、字段名与作用域）：用演示账号真登录 desk 一次，记录 SPA 会话存储与请求头形态，定 D6 注入法——embed-probe.md：cw_d_session_info cookie（devise 头 JSON）+ user.id/expires_at；SAMEORIGIN 同源 iframe 合规；注入法=服务端 sign_in+构造 cookie+按用户注入 devise 头
- [x] 1.2 协调 finddata 侧：重置/确认演示账号密码（§七 密码 devise 401 事实）、试点商家 Account 建号配方确认（SuperAdmin/cw-seed 脚本）——coordination.md：密码漂移已修（重置回 §七 值，sign_in 200 实证）；建号配方确认现成（seed 脚本/SuperAdmin 人工）

## 2. chatwoot 凭据面（D1）

- [x] 2.1 新 credentialRef `chatwoot`：按 (ref,email) 存储 token+email+password，连接中心新增面板（粘贴表单、深链、状态聚合），单测覆盖存取/清除/stale ——实绩：db 迁移 v34 user_chatwoot_credentials + chatwoot-credentials.js（token+登录对，paste/stale 语义）+ REFS 分派 + /api/chatwoot/connection 路由 + 连接中心 chatwoot 面板（五 locale 键）+ /api/connections 聚合；单测 2.1a-c
- [x] 2.2 保存连接物化本地 stdio 行（config 同源 bundled、`credentialEnv: {CHATWOOT_API_TOKEN: "chatwoot"}`、嵌入凭据同 ref），清除连接移除该行；单测双分支+轮换覆盖 ——实绩（设计修正）：bundled 行即每 cell 本地行，pack 引用天然命中本地绑定条款，物化行整个不需要；bundled 条目加 credentialEnv；spec delta 已同步改写（连接面只管凭据、清除不回落共享 env）

## 3. stdio env 逐用户凭据解析（D2）

- [x] 3.1 toMcpClientEntry 增 `credentialEnv` 解析（liveTokenForRef(ref, ownerEmail)），无活凭据→条目整体省略（静默）；writeMcpPatch 组合序接入；单测：有凭据注入、无凭据省略、与 envRefs/requiresEnv 正交 ——实绩：toMcpClientEntry 加 ownerEmail 参与 credentialEnv 覆盖；requiresEnv 满足判定纳入用户凭据源；已认证无凭据→条目省略、机器 owner 部署 env 逐字节不变；单测 3.1a-d
- [x] 3.2 工具层 401 使该用户凭据置 stale（走 invalidateRef）；单测断言不误伤部署 env 路径 ——实绩：执行器用户路径 401→invalidateRef（不误伤部署 env），错误面零 token；单测 3.2

## 4. 动作闸双凭据（D3）

- [x] 4.1 `crm.message.send` 增 credentialRef；preflight 三分支：已连接→过、已认证未连接→拦截+连接指引、机器 owner 无凭据→回落部署 env；单测三分支 ——实绩：registry credentialRef=chatwoot + requireChatwootCredential 三分支（已连接过/已认证未连接拦截+connectPath/机器 owner 校验部署 env）；单测 4.1a-b
- [x] 4.2 执行器 stdio 分支取凭据同序：用户 token 注入子进程 env；用户路径 401→invalidateRef+提案失败，部署路径 401→现行报告；桩单测 2×2（用户/部署 × 成功/401） ——实绩：执行器 stdio 分支取凭据同序（用户 token 注入子进程 env；credentialEnv map 锚定 env 名）；桩单测 4.2a-c
- [x] 4.3 审计无凭据扩展到新路径（args digest、日志、提案行），突变验证断言有效 ——实绩：用户 token 仅存在于子进程 env（构造性）；filterKnownArgs/args digest 语义不变（bridge 套件 3.4 系既有断言）；新增 401 错误面零 token 断言（3.2）

## 5. CRM 客服套件 pack（D4/D5）

- [x] 5.1 写商家变体技能 `crm-desk-reception-merchant`（profile 发现 account_id、BYOK 说明、失败四分类、守界问答）+ 使用说明；单测：工具名⊆98 面、不出现钉死 account_id ——实绩：packs/crm-desk-suite/skills/crm-desk-reception-merchant/SKILL.md（profile_get 发现账号、BYOK 说明、失败四分类、守界）；单测：引用工具全 ⊆ 98 面、无钉死 account_id
- [x] 5.2 pack manifest（registryName chatwoot + allowTools 98 名单≡operator-tool-face 快照的单测断言）+ 按 facet-pack-builder 配方产出 pack；发布闭包校验通过 ——实绩：manifest fullSurface+reason（98 名单超 pack allowTools 64 上限→整面声明由操作员面收口，免双份名单漂移）；validatePackManifest PASS；发布闭包豁免成立；单测 5.2
- [x] 5.3 本地安装链路单测：已连接即时绑定/未连接 awaiting-local-binding/连接后激活（对 pack-installation 既有行为，只断言不改动） ——实绩：单测 5.3 用真 manifest 走 installPack：bundled 行即本地行→bound、fullSurface 标记随快照、无行名 awaiting-local-binding（awaiting→bound 激活流由 test-pack-cell 既有覆盖）

## 6. 嵌入反代（D6/D7）

- [x] 6.1 新反代路由（认证门后、按用户会话映射、进程内不落盘）+ 应用中心客服台卡片（未连接→连接面板指引；仅 token→如实提示） ——实绩：cell 路由 go（未连接→连接面板/仅 token→need-login/未配嵌入→如实就绪页）+ agents.json 客服台卡片（/external/desk/go）+ 连接徽章（/api/connections chatwoot 项）；单测 6.1 三分支
- [x] 6.2 服务端代登录注入（按 1.1 探明的形态实现），登录失败/上游不可达→可读错误页；桩+真机单测 ——实绩：SSO 主路径（/external/crm-desk/sso）真机三腿全过（A 租户/商家/恢复，零输入、身份随凭据切换）；反代+entry 为可选视觉嵌入升级路径（桩单测 12/12 保持）；边缘子域不再是阻塞（coordination.md 4）
- [x] 6.3 越权负例单测：未认证访问被拦、两用户会话互不可见、A 租户内容不出现在商家侧 ——实绩：单测 6.3 负例（未认证 401/他人无凭据 401 且零商家会话泄漏/token-only 422）；构造性隔离=会话进程内按 email 键不落盘；WS 一期不代理已如实注明

## 7. 出片与生产验收

- [x] 7.1 出片滚 platform（fd-build-channel 判路 → 公开快照仓线）；谦面市场上架 CRM 客服套件；验证市场可搜、订阅流程走通 ——进度：出片 d279b7e（快照仓 image 绿→relay OK→ccr digest 622fe5fd→双清单滚→rollout 1/1、pod imageID 实证）；in-pod 实证 crm-desk-pack/desk-embed 路由在位、A 租户 cell patch 面完好；**余=谦面市场上架**（facet 发布链+registry 技能公开 URL，运营步骤）——实绩：技能 gitee 公开 URL+registry 注册 200；pack 发布 0aVynUNHmscTAxu7fGs-NQ v1（fullSurface 过发布门）；市场可搜+详情 public（acceptance-b.md §7.1）
- [x] 7.2 商家全链真机验收：连接自带凭据→订阅 pack→cell 组合出逐用户 chatwoot 面→草拟→发送走闸（写自己租户）→嵌入直达自家租户；A 租户现行四链路回归不回归；证据落 reports/acceptance-b.md ——进度：A 租户回归全绿（连接面板真机连接 roundtrip→cell 重组→pod 重启后 chatwoot 工具挂载→meta/list 交叉核对，收件箱出现真实挂件会话 #2 证明 3.1 挂件已通）；**余=商家全链**（待 finddata B6.4 建号）——实绩：订阅安装 report=chatwoot bound+技能 installed；凭据切商家 token→账号发现=7→隔离读零 A 租户内容→草拟不编造→闸批准→发送落 Account 7 msg#9（Account 1 零泄漏）；已恢复 A 租户凭据（acceptance-b.md §7.2；行为面注记：凭据轮换在 cell 生效需 dsh 冷启=envRefs 家族既有语义）
- [x] 7.3 越权负例生产实证：商家侧不可见 A 租户会话、A 租户不可见商家会话、审计无凭据 ——进度：越权负例单测全绿（6.3 三个+3.1b 隔离）；生产越权实证待商家账号——实绩：单测负例（embed 6.3 三例+3.1b）+生产双租户落点核验（7.2 第 6 步）

## 8. 收尾

- [x] 8.1 `openspec validate add-crm-desk-pack-embed --strict` 绿；回 finddata `crm-board-adoption/tasks.md` 勾 6.1/6.3（注明证据落点）；B6.4 试点运营负担记录转交 finddata；SSO 增补交付（paas-embed-desk-requirements 口径）含 spec delta 如实修订（crm-desk-embed→SSO 主路径）与迁移账本 version 修复（line-boards 存量缺陷一并补）
