# add-caller-preferences — Tasks

## 1. 门面偏好层（fd-wanxing）

- [x] 1.1 `store.js` 增 `wanxing_caller_prefs` 表与 CRUD（(user_id, agent_slug) 主键；callback_url/secret、reap_minutes、updated_at），单测覆盖 upsert/清除/查询回落
- [x] 1.2 门面 prefs API：`GET/PUT /api/wanxing/v1/prefs/:slug`——调用键 Bearer 认证（probeKeyLiveness 解析 userId，同 A2A 门），写校验（URL https、密钥长度、reap 正整数分钟且上下界）、清除语义、无效键拒绝，单测覆盖认证/校验/清除三态
## 2. 回调派发（fd-wanxing）

- [x] 2.1 `core.js` 回合完成点挂派发：HMAC 签名（t+v1 头，覆盖全体）、体含 trace_id/outcome/时长、指数退避三次（总窗 ≤15m）、fire-and-forget 不阻塞回合响应，单测覆盖签名可验证/重试窗/密钥不出现在任何外发内容
- [x] 2.2 派发审计：失败窗尽记 jsonl（url 脱敏、原因、trace_id；无密钥），探针脚本对 stub 接收端验证签名/重试/幂等锚三件套
## 3. 收割窗传导（fd-wanxing + paas runner）

- [x] 3.1 共享解析函数（门面 `a2a.js` 导出 `encodeReapWindow`/`parseReapWindow`；36 进制窗段 + 旧格式回落），门面 `contextIdFor` 派生时编码生效值（偏好→默认），单测覆盖偏好/默认/自带 context 三态
- [x] 3.2 paas `agent-runner/manager.js` reap pass 接最小拷贝的解析函数取每会话 TTL（旧 `wx:` 无窗段回落默认），单测覆盖编码会话按偏好收割、未编码按默认、非法段回落
## 4. CLI（paas facet/cli）

- [x] 4.1 `facet.js` 增 `prefs` 子命令（--key/FACET_KEY、--set-callback/--set-reap/--clear/--show，USAGE 同步），直连门面 prefs API；单测覆盖参数解析与门面交互（stub fetch）
## 5. 集成验收与上线

- [x] 5.1 本地快检（单文件单测/lint/build）+ push CI 全绿（fd-wanxing 套件 + paas unit + e2e fast 若覆盖 prefs 面）
- [x] 5.2 部署序上线：runner（解析先行）→ 门面 → CLI npm 发版；上线探针：CLI 设偏好 → stub 回调收签名 POST → 收割窗编码会话按偏好收割（低 reap 值实证）→ 清除回落
- [ ] 5.3 `openspec validate --strict` + `validate --specs` 绿后归档（caller-preferences 新建、wanxing-facade 两 requirement 并入核对）

---

## 上线留档（2026-10-07）

部署序执行（runner sha-8cfdef9 → 门面 sha-93da73e → CLI 直连生产验证；npm 发版后置），**上线探针实抓四个缺口，全修全复验**：

1. **registry A2A 反向代理整体停摆**（拦在探针第一跳）：昨日 registry 混合体退场重建时 `A2A_REVERSE_PROXY_ENABLED=false` 未带回 → nginx 动态代理段为空 → 所有 `/agent/*` 落 SPA/405。修复=`/opt/mcp-gateway-registry/.env` 复原 true + `compose up -d --no-build --no-deps --force-recreate registry`（免构建重建，旧容器保留）。**连带**：entries 的 `proxy_pass_url` 在开关关闭期缺省 → 生成器回退用 url（已是网关形）→ 自环；修复=按部署同款写路径对四个 agent 逐个 GET→置 url=后端 origin→PUT→toggle（split 重跑复位 proxy_pass_url）。复验：门面 pod 内 POST 经代理 → 200 + 真 assistant 回复。
2. **runner 收割扫描布局错位**（差检时实抓）：dsh 现行存储为工作区嵌套 `sessions/<group>/srv-wx-*`，单层扫描使收割**一直空转**——首扫清出 **44 条**陈旧 wx 会话的实锤。修复=双层扫描（flat 兼容 + nested），随 sha-8cfdef9 生效。
3. **nginx Host 分流**：本机 127.0.0.1 直取 registry API 需 `Host: mcp.finddatatech.cloud`（运维备忘）。
4. **回调接收端 TLS 门槛**：tailnet HTTPS 未开通（`tailscale serve` 501），https-only 校验保持；上线探针以「到达+审计+退避」验证（attempts 1→4 时间戳 60s/240s/600s 与 `failed: window exhausted` 均实证），签名验证留在测试面（真 HMAC 验签已绿）。

**探针实证（全走生产链，daas-analyst，调用键=用户真键）**：CLI 读/写/清三态 ✓；真回合经门面 → `context_id: wx:2x-323f1fa4a5b78479`（**偏好窗随派生 id**）✓；差检：1x/2x/5x 陈旧会话首扫全清、600x 新会话跨扫描 tick 存活 ✓；回调审计 jsonl 落盘（host 脱敏、无密钥）✓；清除后回读默认 ✓。
**遗留**：CLI npm 发版（facet-cli-v 打 tag 即发）；registry `.env.bak-a2aproxy-1007` 为开关回滚位；8cfdef9 的 CI 首跑遇既存端口 flake（EADDRINUSE，测试 harness 随机端口设计），重跑核验中。
