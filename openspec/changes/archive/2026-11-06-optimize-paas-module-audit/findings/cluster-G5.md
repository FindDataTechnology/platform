# 簇 G5 健康卡 — ciyuan/词元 + 萬星 facade（9 模块）

审计人：G5 体检员 · 日期 2026-11-06 · paas HEAD `ae04f0b9`（2026-11-06 02:45）
**代码仓分布**：ciyuan 七模块主体在兄弟仓 `/Users/chengsishi/finddata/sub2api`（HEAD `913323d1c`，2026-11-06 02:55，tag `ciyuan-v0.2.19-1`）；wanxing-facade 双面=paas `gateway/wanxing/` + `/Users/chengsishi/finddata/fd-wanxing`（HEAD `6875307`）。
**③ 共同部署事实（全部 ancestor ✓）**：
- sub2api（词元）：`fd-infra-deploy/all-services/sub2api/01-sub2api-deployment.yaml:103` 镜像 `sha-6cbe84a`=快照源 `5f6ef269b`（`git merge-base --is-ancestor 5f6ef269b HEAD`=是，落后 2 提交）。
- facade：`prod/wanxing-facade.yaml:42` 镜像 `sha-0b8a5c3`=`fd-wanxing d41ce35`（11-06 03:02，IS ancestor of fd-wanxing HEAD）。
- platform/facet（壹座侧 ciyuan-account 宿主）：`prod/platform.yaml:57`+`facet.yaml:66` 镜像 `sha-70a3620`，源 paas `dde77c3a`（IS ancestor of HEAD）。

---

## 1. ciyuan-account — 评级 A
**理由**：零粘贴绑定全链（登录→铸键→只写存储→车道覆盖→回落）逐条落在码上，故障语义（401 stale/网络 no-op/半态拒绝）与 spec 一一对应。
① 对齐：连接/测试/断开 `paas/server/routes/ciyuan-account.js:130,214,254`；键名 `yizuo-<hash>-<日期>` :74-78；组配置 `CIYUAN_MINT_GROUP_ID` :26；车道覆盖 `paas/dsh-profile.js:377-399`（含回落种子=未绑定即种子，:371-376 注释明示）；单进程形态不覆盖 `:46-48`（shared 不 override）；wanxing-caller 账号 key 优先/手贴兜底 `paas/credential-refs.js:95-103,192` + `paas/ciyuan-account-credentials.js:105-111`；粘贴逃生口=legacy pasted key 语义保留（credentials.js:46-48）。
② 测试：`paas/e2e/ciyuan-account.spec.js` 存在（末提交 2026-10-18 23:40）。
③ 部署：platform `sha-70a3620`，源 `dde77c3a` ⊆ HEAD（当日新鲜）。
④ 痛感：路由文件自身 0 fix（09-05 以来仅触及 dsh-profile 的他线 feat）；稳定无痛点。
⑤ 陈旧度：spec 10-19 vs 代码（routes 10-18 前）剪刀差 ~1-18 天，<30 天，新鲜。

## 2. ciyuan-embedding-lane — 评级 C
**理由**：入口/鉴权/账本/钉扎/池轮转全对齐，但 spec 明文 SHALL 的「维度不符拒绝」与「无价 fail-closed」在转发路径找不到实现证据——向量空间一致性仅靠账号级 pin 单点兜底。
① 对齐：入口 `sub2api/backend/internal/server/routes/gateway.go:249`（POST /embeddings → `h.OpenAIGateway.Embeddings`）；鉴权+账本同链 `handler/openai_embeddings.go:27-44,101`（CheckBillingEligibility 前置）；provider 钉扎覆盖调用方字段 `service/openai_embeddings.go:44` + `service/account_embedding_provider_pin.go:119-123`；池换号 `handler/openai_embeddings.go:137-150`（failedAccountIDs 排除+maxAccountSwitches）；契约模型登记 `service/embedding_model_catalog.go:33`（Qwen/Qwen3-Embedding-8B）。**维度校验：全转发路径（openai_embeddings.go:160-199 响应原样透传）grep dimension/1024 零命中——未证实实现**；「无价可循 fail-closed」仅有 `WithOpenAIRequestPricingContext`（handler:134），fail-closed 行为未证实。
② 测试：`service/account_embedding_provider_pin_test.go`、`service/openai_embeddings_test.go`（均 2026-11-05，新鲜）。
③ 部署：sub2api `sha-6cbe84a`=`5f6ef269b` ⊆ HEAD ✓。
④ 痛感：4 提交（含 40f03b1b2 钉扎 feat），低痛。
⑤ 陈旧度：spec 10-19 vs 代码 11-05，剪刀差 17 天，<30 天。

## 3. ciyuan-fork-lineage — 评级 B+
**理由**：台账/缝点纪律/月度窗真实运转（v0.2.17-19 合流两日出片），但存在一个偏离 `ciyuan-vX.Y.Z-N` 格式的孪生 tag。
① 对齐：台账=`paas/docs/sub2api-fork-patches/README.md`（§一发布记录/§二缝点登记表/§三月度窗台账含 merge 用时记分，结构 :5-8）；runbook `merge-window-runbook.md:38-54`（冲突仅限 §二缝点+只增不改）；tag 格式实证 `ciyuan-v0.2.19-1`（11-06，与部署同 tag）。**偏离**：tag `v0.2.16-fork17`（11-05，指向 f9cb82c74，与 `ciyuan-v0.2.16-17` 同 commit）不符合 spec 命名式。
② 测试：本模块为治理流程，测证=台账运转本身（README 09-05 以来 29 提交，最新 11-05）。
③ 部署：ciyuan-v0.2.19-1 镜像已在产（deployment.yaml:103 注记）✓。
④ 痛感：merge 窗活跃：900a45e46（接缝两修）、f68e7ef53（ent codegen 位次重推导）等——窗内 fix 密度中高但属预期合并痛，台账如实登记。
⑤ 陈旧度：spec 10-15 vs 台账 11-05，剪刀差 22 天，<30 天。

## 4. ciyuan-gateway-identity — 评级 A-
**理由**：多宿主别名派生白名单+显式端点免 discovery 双需求均已上产并部署实证；唯一未证实项是「端点缺失回落 discovery」路径。
① 对齐：别名白名单派生 `sub2api/backend/internal/handler/auth_oidc_oauth.go:1218-1261`（oidcRedirectURLForRequest/oidcRedirectURLAliases）；配置键 `config/config.go:355`（redirect_url_aliases，词元多宿主缝点）；部署实证 `fd-infra-deploy/all-services/sub2api/01-sub2api-deployment.yaml:101`（token+router 双域 env）；登录免 discovery：`buildOIDCAuthorizeURL` 直接用 cfg.AuthorizeURL（auth_oidc_oauth.go:939-941）、token 交换直接用 cfg.TokenURL（:767）——登录发起零 discovery 拉取。**「端点为空回落 discovery」路径未找到代码——未证实**。
② 测试：`backend/internal/handler/auth_oidc_oauth_test.go`（2026-10-15）。
③ 部署：同 sub2api 共同事实 ✓。
④ 痛感：8 提交（含本需求本体 ee4d03092 feat(oidc) 多宿主回调派生）；修复后无回归 fix。
⑤ 陈旧度：spec 10-16 vs 代码 10-15 后，剪刀差 ~21 天，<30 天。

## 5. ciyuan-gateway-lanes — 评级 A-
**理由**：三车道协议形状/账号级协议路由/12h-60s 分级冷却与 spec 逐条对上、测试最厚；shadow=视频/图像车道在网关已上产但无本 capability 契约（属下一能力，非违约）。
① 对齐：账号级协议分派 `sub2api/backend/internal/lanes/audio.go:42-58`（credentials["audio_protocol"]→doubao/tencent，未标注=OpenAI 兼容，与 spec Scenario 一致）；豆包/腾讯适配器 `audio_doubao.go`/`audio_tencent.go`；可达化前缀 `audio_public_base_url`/`LANE_AUDIO_PUBLIC_BASE_URL` 在 audio.go、audio_spool.go；冷却分级 `lanes/failover.go:16-17`（12h/60s，与 spec 数值逐字一致）；入口端点 `lanes/router.go`（/v1/audio/*、/v1/rerank、/v1/search）。
② 测试：`backend/internal/lanes/` 25 个 *_test.go（pool/failover/audio_doubao_frame/audio_tencent/websearch/rerank…，末提交 10-15~10-19）。
③ 部署：sub2api `sha-6cbe84a` ⊆ HEAD ✓。
④ 痛感：16 提交/5 fix（09-05 以来）——白屏轮换期后趋稳，中低痛。
⑤ 陈旧度：spec 10-22 vs 代码 10-19 后，剪刀差 ~15 天，<30 天。**Shadow**：`/v1/videos*`、`/v1/contents/generations/tasks`、图像/批量图像（gateway.go:262-289）为活跃对外能力，9 spec 无视频/图像协议契约（仅 product-surface/partner-intro/trial-account 引用条目）。

## 6. ciyuan-partner-intro — 评级 C
**理由**：材料本体存在且口径守纪（无价目/无上游名/含视频），但「仓内维护」不成立——材料落在**非 git 目录**，单副本无版本控制。
① 对齐：材料 `/Users/chengsishi/finddata/docs/ciyuan-intro.md`（7390B，mtime 10-16 02:36）：router.finddatatech.cloud 调用地址 ✓、测试账号节 ✓、视频条目 ✓；无价目数字/无上游供应商名（首 40 行目检）。**偏离：`cd /Users/chengsishi/finddata/docs && git rev-parse` = "fatal: not a git repository"——spec「仓内维护」未满足**；与 /lanes 页逐条口径对照未做（未证实）。
② 测试：无（材料类，未证实有任何对照测试）。
③ 部署：n/a（文档）。
④ 痛感：不在任何 git 仓内，git log 不可用——痛感不可测，本身即风险。
⑤ 陈旧度：mtime 10-16 vs /lanes 相关代码 10-19+，剪刀差 ~21 天，<30 天（但无版本史可长期保证）。

## 7. ciyuan-product-surface — 评级 B
**理由**：首页单一事实源+灌入通道+回滚锚三件套齐备且上产，但版式需求（徽标贴底）无任何自动验证，靠人眼回归。
① 对齐：权威副本 `paas/docs/ciyuan/home-content.html`+回滚基线 `home-content.baseline-2026-10-05.html`（spec「基线副本作回滚锚」✓）；灌入脚本 `paas/scripts/apply-ciyuan-home.mjs`（10-15）；视频/车道条目在 home-content.html（registry-maintenance.md:228-235 记录上产）；价目不落首页=台账纪律条目。
② 测试：未证实——无 home-content/apply 脚本相关 test；徽标贴底 Scenario 仅人工验收（b8ba8a18 记录）。
③ 部署：home_content 由 sub2api 设置承载（经管理 API 灌入），词元镜像 sha-6cbe84a ✓。
④ 痛感：2 提交/0 fix（09-05 以来，均 change 落盘）——低痛。
⑤ 陈旧度：spec 10-16 vs 副本/脚本 10-15，剪刀差 ~21 天，<30 天。

## 8. ciyuan-trial-account — 评级 B
**理由**：账号/双钥匙/硬顶/凭据不扩散四项全有据，但余额水位与 $10 硬顶现状自 10-16 后未复核，交付凭据明文所在文件又无版本控制（同模块 6 风险）。
① 对齐：账号 user93 `ciyuan-trial@findmail.com`、key74(group3=chat+三车道)+key75(group9=视频/图像)「两把密钥覆盖全能力」=`paas/docs/registry-maintenance.md:262`；凭据只落伙伴文档+paas 侧仅指纹 `:262-264`（与 spec「台账不含明文」一致）；硬顶语义=sub2api 计费门 `handler/openai_embeddings.go:101` 同源 CheckBillingEligibility（余额耗尽拒绝不触上游）。
② 测试：未证实专测（依赖平台计费链既有测试）。
③ 部署：n/a（账号侧配置，词元镜像 ✓）。
④ 痛感：0 直接 fix；但台账记 10-18 密码因误推事故轮换（:262）——凭据治理曾出痛。
⑤ 陈旧度：spec 10-16 vs 台账 10-18 轮换注记，剪刀差 ~19 天，<30 天；**余额/额度现状 10-16 后未复核——未证实**。

## 9. wanxing-facade — 评级 A
**理由**：双仓实现同日活跃收敛（redaction 双胞胎+幂等指纹硬化 2.1 已回灌部署），spec 当日刷新，测试当日更新，部署 sha 与源仓祖先律全绿——全簇最健康。
① 对齐：fd-wanxing 面：鉴权门/幂等指纹 409 `services/wanxing-facade/a2a.js:681-811`（IDEMPOTENCY_KEY_REUSE/TURN_IN_FLIGHT）、provider.url 脱敏 `:276-301`；paas 镜像面：脱敏 twin `paas/gateway/wanxing/a2a.js:109-142`、幂等 twin `gateway/wanxing/core.js:126-148`、快照 TTL+single-flight+diff `gateway/wanxing/bookkeeping.js:26-71`（diffDeployments 即 spec 导出纯函数要求）。未发现 shadow。
② 测试：`fd-wanxing/scripts/test-wanxing-facade.mjs`（11-06 03:02，与 d41ce35 同刻）；paas `scripts/test-wanxing-facade.mjs`+`test-wanxing-bookkeeping.mjs`（11-05 22:53）。
③ 部署：`wanxing-facade.yaml:42` `sha-0b8a5c3`=d41ce35 ⊆ fd-wanxing HEAD（落后 1 提交，当日）；注记自带上一版与回退通道。
④ 痛感：fd-wanxing facade 51 提交/16 fix（09-05 以来）——高迭代但均属 change 驱动（unify-wanxing-a2a-face 2.1），非返工循环；paas 侧 12/7。
⑤ 陈旧度：spec 11-06 02:34 vs 代码 11-06 03:02，剪刀差≈0。

---

## 簇摘要 — 三件最严重的事

1. **embedding 维度契约 SHALL 无实现（ciyuan-embedding-lane，评级 C 的根因）**：spec「响应向量维度与契约不符时 SHALL 拒绝」在整条转发链（`handler/openai_embeddings.go` → `service/openai_embeddings.go:160-199` 响应原样透传）无任何维度校验（grep dimension/1024 零命中）；「无价 fail-closed」同样未证实。当前向量一致性完全押在账号级 provider 钉扎（pin.go:119-123）单点上——钉扎配置漂移即静默混空间，正是 spec 立此项要防的事故形态。
2. **伙伴介绍材料（含明文密码+两把 sk- 全文）活在非 git 目录**：`/Users/chengsishi/finddata/docs/ciyuan-intro.md` 不属任何版本仓（git rev-parse fatal），spec「仓内维护」不成立——单副本误删/误改不可恢复、无 diff 审计、痛感不可测（G5-6 评级 C）；同文件同时是 trial-account 的凭据唯一落点（G5-8 连带）。
3. **视频/图像生成是已上产的 shadow 能力面**：`/v1/videos*`、`/v1/contents/generations/tasks`、图像/批量图像路由在产（gateway.go:262-289、部署注记、首页/介绍/试用账号三 spec 均引用其端点），但 9 个 spec 无一规定其协议形状/计量/失败语义——对外契约仅由代码与首页文案自证，与「能力入册」的体检口径相悖，建议立 `ciyuan-video-lane` 类 capability。
