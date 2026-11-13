# 簇 G8 体检卡：registry / 身份 / auth / a2a / gateway

审计日 2026-11-06。paas HEAD=ae04f0b9（2026-11-06 02:45，有并发未提交改动，仅只读调查）。跨仓：registry fork=/Users/chengsishi/code/mcp-gateway-registry（HEAD d821e624 fd-product-home 2026-11-05 23:32）。

**实际清单（8 条，均 `ls openspec/specs/` 在册）**：auth、logto-auth、cell-gateway、a2a-agent-serving、registry-lineage、registry-credentials、registry-quota-gate、vendor-identity。
任务提及的 registry-cli **不在册**（specs/ 无 registry-\*cli\*）。相邻面未入列（他簇标签）：forward-auth、device-pairing-auth、miniprogram-auth、principal-facade、agent-delegation-a2a、ciyuan-gateway-\*、wanxing-facade。

---

## 1. auth — B
理由：实现齐、部署新，但 spec 已 37 天未随实现回写，契约可信度在降。
① 对齐：`GET /api/auth/me`→server/auth.js:73,93（公开路径面含 pack raw-md 白名单）；logto/forward_auth 双模分支 server/auth.js:355-375；与 spec 7 条 Requirement 对得上。
② 测试：scripts/test-auth-mode.mjs 存在，mtime 2026-10-16。
③ 部署：prod/all-services/platform.yaml:57 `platform:sha-70a3620`←paas dde77c3a（11-06 00:29），`git merge-base --is-ancestor dde77c3a HEAD`=是，落后 6 commit。
④ 痛感：server/auth.js since 09-05 共 29 commit，其中 fix 9（31%）。
⑤ 陈旧：spec 2026-09-28 vs 代码 2026-11-04 → 剪刀差 37 天=**stale**。

## 2. logto-auth — B
理由：rd 校验/RP 登出逐条可指，但 fix 占比 60% 说明会话回调仍偶发返工。
① 对齐：session 密钥 server/logto-auth.js:151；cookie 验签 :159；`rd` 同源回跳校验 :176（spec 明文要求）；RP-initiated logout :233。
② 测试：scripts/test-logto-auth.mjs mtime 2026-10-11。
③ 部署：同 platform.yaml:57（dde77c3a 祖先，见 §1）。
④ 痛感：since 09-05 共 5 commit，fix 3（60%，量小）。
⑤ 陈旧：spec 2026-09-16 vs 代码 2026-10-03 → 17 天，未 stale。

## 3. cell-gateway — B
理由：门前闸/路由/registry 行全可指、spec 11-02 刚回写，但 gateway/index.js 正被并发会话改动且测试晚于最新代码。
① 对齐：未认证 browser 重定向/程序化 401→gateway/index.js:205-211；cell 代理 catch-all→gateway/index.js:1118；cells-registry durable 行×在线判定→gateway/index.js:1102、gateway/cell-registry.js。
② 测试：scripts/test-cell-gateway.mjs mtime 2026-10-17（早于代码 11-05）。
③ 部署：同 platform.yaml:57。
④ 痛感：gateway/index.js since 09-05 共 38 commit，fix 11（29%）。
⑤ 陈旧：spec 2026-11-02 vs 代码 2026-11-05 → 3 天，新鲜。

## 4. a2a-agent-serving — B
理由：部署动作/锁/租户分段与 spec 17 条对齐且 spec 新，唯 packs.js 改动面大（71 commit）。
① 对齐：部署为服务 deployHandler→gateway/packs.js:2024（幂等 per (pack,agent)、503 缺 runner、per-pack deploy-lock 注释、deployer 分段）；运行时 fork→server/agent-session.js:739；个人凭据 X-Authorization→server/a2a-client.js:65（对应 agent-delegation-a2a）。柏讯域 A2A 直连通道 gateway/wanxing/a2a.js:1-3 归 wanxing-facade spec（他簇，11-05 已核现势）。
② 测试：scripts/test-agent-serving.mjs mtime 2026-10-26；test-agent-delegation-a2a.mjs 2026-10-25。
③ 部署：同 platform.yaml:57。
④ 痛感：gateway/packs.js since 09-05 共 71 commit，fix 14（20%）。
⑤ 陈旧：spec 2026-10-26 vs 代码 2026-11-03 → 8 天，新鲜。

## 5. registry-lineage — C
理由：spec 钉版铁律在自家 compose 里被 mcpgw 浮动 tag 打破，且生产 checkout 态两处未证实。
① 对齐：实现主体在 fork 仓 mcp-gateway-registry（paas 仓无此实现）；版本身份 BUILD_VERSION fd-1.4.0（f8ccd531 2026-10-15）；台账=finddata/MCP-REGISTRY.md（对账规则+2026-10-19 起镜像标签对账）。
② 测试：fork tests/（auth_server unit 一批）在；paas 侧 scripts/test-registry-bridge.mjs mtime 2026-11-05（簇内最新），verify-registry-connect-live.mjs 在。
③ 部署：docker-compose.prebuilt.yml:51 `mcp-registry:sha-a95f7a0`、:410 `mcp-auth-server:sha-a95f7a0` 钉版合格；**:603 `mcpgw:${MCPGW_VERSION:-latest}` 浮动 tag**，违反 spec「镜像无浮动 tag」scenario；生产 .env 是否覆盖该变量未证实。fork HEAD d821e624（11-05，carry-registry-visibility-through-bridge 1.1-1.3）是否已出片部署未证实。
④ 痛感：fork since 09-05 共 249 commit，fix 96（39%）。
⑤ 陈旧：spec（paas 仓）2026-10-11 vs fork 代码 2026-11-05 → 25 天，未超线但趋势向上。

## 6. registry-credentials — A
理由：spec/代码同日定格、零 fix、消费端贯通，簇内最稳。
① 对齐：store/liveToken→registry-credentials.js:24,86,111；SSO handoff 存取端点→server/routes/registry.js:78（store）、:113（disconnect）；a2a/外部消费→server/a2a-client.js:15,34、server/routes/misc.js:683。
② 测试：scripts/test-registry-credentials.mjs mtime 2026-10-14。
③ 部署：同 platform.yaml:57。
④ 痛感：registry-credentials.js since 09-05 仅 1 commit，fix 0。
⑤ 陈旧：spec 2026-09-21 vs 代码 2026-09-21 → 0 天。

## 7. registry-quota-gate — B
理由：spec/实现/测试 1 天内互证，但它是全簇最高 fix 密度面，且部署镜像是否含作用域收口未证实。
① 对齐：实现在 fork：auth_server/preflight_quota.py（f72975f9 10-13 preflight probe，402/503 fail-closed）+ FD_WIRE_QUOTA_SERVERS 作用域（auth_server/server.py，reconcile=4128610b 10-13 02:16）；paas 仓 grep 无 FD_WIRE_QUOTA_SERVERS（跨仓 spec，以 fork 为准）。
② 测试：fork tests/auth_server/unit/test_preflight_quota.py mtime 2026-10-13。
③ 部署：钉版 48c1d23f（10-13 02:56，在 reconcile 后 40 分钟，时序一致）；sha-a95f7a0 构建是否对应含 4128610b 未证实（构建 sha≠commit sha，仓内无映射）。
④ 痛感：fork auth_server/ since 09-05 共 46 commit，其中 quota 两文件 34 commit / fix 16（47%，簇内最高）。
⑤ 陈旧：spec 2026-10-12 vs 代码 2026-10-13 → 1 天。

## 8. vendor-identity — B
理由：自助注册/档案/成员路由逐条可指、spec 与代码零剪刀差、痛感低；唯新模块验证期短。
① 对齐：registerVendorRoutes→gateway/vendors.js:246；`POST /api/vendors` 自助注册 :266（409 名字冲突、vendors 组绑定）→:270 createProfile；审计面 :341。
② 测试：scripts/test-vendor-supply-open.mjs mtime 2026-10-28；另 c1a88ad0 回归 22/22（tierQuotas env 崩溃修复）。
③ 部署：同 platform.yaml:57。
④ 痛感：gateway/vendors.js since 09-05 仅 1 commit，fix 0；相邻 vendor-onboarding.js 有 fix c1a88ad0（10 月底真机 502）。
⑤ 陈旧：spec 2026-10-28 vs 代码 2026-10-27 → ~0 天。

---

## 簇摘要：最严重三件事

1. **registry-lineage 自家 compose 违反自家钉版铁律**：docker-compose.prebuilt.yml:603 `mcpgw:${MCPGW_VERSION:-latest}` 浮动 tag，正撞 spec「镜像无浮动 tag」scenario（spec.md 10-11 版）；生产 .env 是否覆盖未证实。同时 fork HEAD d821e624（11-05）与生产 /opt checkout（INFRA-NOTES.md:454 记 10-07 分支，已滞后 4 周）的对应关系未证实——registry 生产态是簇内最大盲区。
2. **谦面双端可见性收口的跨仓一致性未闭环**：paas 侧已部署 dde77c3a（11-06，carry-registry-visibility-through-bridge 3.1-3.4，fail-closed sentinel 兜底），registry 侧 d821e624（11-05，1.1-1.3）是否已出片部署未证实；两端语义若错位，「谦面公开泄漏三 cell」治理退化为 registry-groups.json 兜底路径。
3. **auth spec 剪刀差 37 天（簇内唯一 stale）**：spec 2026-09-28 vs server/auth.js 2026-11-04，期间 29 commit（含公开路径白名单、双模身份分支演进）未回写 spec；身份门面是全平台信任根，spec 失真会让后续变更失去对账基准。次级关注：registry-quota-gate fix 密度 47%（34/16）为簇内最高修复面。
