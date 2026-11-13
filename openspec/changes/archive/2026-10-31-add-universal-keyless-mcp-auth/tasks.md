## 1. 能力表与探针（先产事实，零行为变化）

- [x] 1.1 `facet/mcp-auth-capability.js`：表结构 `{client, versionRange, headerStatic, oauthClientId, dcr, evidence:{probe, at, buildHash}, stale}`；
  每条记录**必须**带 evidence，缺失即视为不存在（不是 false）。验证：单测拒绝无 evidence 的记录
- [x] 1.2 `scripts/probe-mcp-auth-lanes.mjs` 静态探针：解开客户端产物，定位「配置文件 → auth provider」映射函数并判定
  `oauth.clientId` 是否被读取。**首个夹具=WorkBuddy 5.9.3 asar**（已知答案：false，探针必须复现该结论）。
  验证：对已归档的 asar 快照跑出 `oauthClientId:false`，对内置 Outlook 连接器的描述符跑出 `true`
  **已成**：`node scripts/probe-mcp-auth-lanes.mjs static --app /tmp/wb-asar` → 用户文件 `toAuth$2` 判 `false`、连接器 `toAuth$1`/依赖项 `toDependencyAuth` 判 `true`，与 asar 逐字一致
- [x] 1.3 协议探针：以**该客户端的请求形状**（resource 值 / scope / 回调路径 / PKCE）无头复刻授权全链，
  断言 `initialize` 200 且 `tools/list` 非空；必须走完整三步握手（`initialize` → `mcp-session-id` →
  `notifications/initialized` → `tools/list`），漏 session 头会得 0 工具。验证：对生产 `fd-daas-mcp` 得 161 工具
- [x] 1.4 版本哨兵：客户端版本与 evidence.buildHash 不符即标 stale；CLI 读表时 stale 一律不选 L1。
  验证：单测构造 stale 记录 → 选道结果为 L2 且输出含「待复验」
- [x] 1.5 用今天已有的真实结果填首版表：六 target（CC/Cursor/ZCode/Codex/Gemini/WorkBuddy）+
  VS Code / Windsurf / Cline / Continue / Zed / JetBrains / Claude Desktop 的 `headerStatic`（未验的记 absent）

## 2. L2 代持令牌车道（今天覆盖 100% 客户端的兜底）

- [x] 2.1 `facet auth` 子命令：标准 PKCE 授权（静态 client_id，回调 `127.0.0.1:<随机端口>/oauth/callback`，
  端口无关回环匹配），拿到 access token 后按能力表选道写入目标；`--target/--project/--write-mcp` 与
  `install` 同义。验证：单测桩授权服务器打全链，写入形状 `{type:http,url,headers.Authorization:"Bearer …"}`
- [x] 2.2 写入约束：只写 access token（目标 8h），**不写 refresh token**；写入后 `chmod 0600` 并回读校验；
  输出报告令牌余期与可续期性。验证：单测断言文件模式 0600、配置内无 refresh 字段
- [x] 2.3 `facet auth --refresh`：有 refresh token 则静默续期并原地改写；无则一步重授权并明说走了哪条。
  验证：单测两分支；真机各跑一次（生产端点）——**真机已成**：refresh 成功、token 轮换、aud/user 回位（见台账 §15.105）
- [x] 2.4 `facet auth --status`：报告令牌余期、可续期性、当前道、以及该客户端能力表是否 stale
- [x] 2.5 401 三分类诊断：过期/吊销、组或角色不匹配、服务停用，各自给一句可执行的下一步。
  验证：单测三类响应体 → 三类文案

## 3. 身份侧（生产 Logto）：refresh_token 与 scope 协商

- [x] 3.1 授权请求补 `prompt=consent` + `offline_access`（仅 CLI 的 L2/L3 请求带，L1 走客户端默认）。
  验证：预发环境换回 token 响应含 `refresh_token`
- [x] 3.2 为 native 应用开启 refresh token rotation；验证：refresh 两次连打，token 轮换且旧 refresh 失效
  **实测结论：轮换为真、旧 RT 失效为假**——连刷两次各得新 RT（`rotated:true` ×2），但最初 rt0 仍 200。
  不影响用户续期，但「RT 被盗靠轮换止损」这句话不成立；缺口在 Logto 应用配置（reuse detection），
  不在本仓库代码。已记入 §4.2 与台账，对外文案不得承诺「轮换即自动失效」。
- [x] 3.3 查清 `scope` 为空：`gateway:access` 是否作为 API resource scope 正确绑定到该应用。
  验证：token 响应 `scope` 含 `openid gateway:access offline_access`
- [x] 3.4 生产灰度：先跑一次完整 L2 → refresh → 再成功调用（三段证据），再切生产授权请求形状；
  **已成**：L2 写入（0600、无 RT）→ refresh 后 `tools/list` 得 161 工具、`initialize` 200、session yes。
  回滚=只在 CLI 请求里去掉 `prompt=consent`

## 4. 市场产物：分客户端连接块

- [x] 4.1 `facet/marketplace-repo.js` 产出 `connect/<client>.json`（机器可用，CLI 直接合入）与
  `connect/<client>.md`（一步一条命令）。验证：单测断言每个套件目录含 README + 至少一条 connect 块
- [x] 4.2 连接块内容随道而变：L1 写 `oauth.clientId` 形状、L2 写 `headers.Authorization` 占位 + 获取命令、
  L3 写 `--key` 命令。验证：单测按能力表生成三种形状
- [x] 4.3 重新投影并发布市场仓（`export-marketplace-repo --push`，last-good 契约不变）；
  验证：清洁克隆机检 connect 块形状与凭据形状零命中
  **已成**：生产库实投影 75 集中 54 集带 MCP 引用 → 378 个 connect 文件、总计 892 文件；推送 `1447c13` 后清洁克隆复验形状正确、生成器正则口径凭据零命中

## 5. 文档与判据

- [x] 5.1 `docs/ecosystem/universal-keyless-mcp-auth.md` 与实现对齐（本 change 的产物之一，已起草）——已补 §4.1 检查单与 §4.2 诚实记账
- [x] 5.2 `docs/ecosystem/client-matrix.md` 增「连接道」列，指向能力表而非散文——已加行并注明「能力表是唯一权威」
- [x] 5.3 「已解决」判据落成检查单（无密钥可见/过期无人工/401 可分类/有机器证据），每个客户端上线时逐条签——见 doc §4.1 表与签名格式

## 6. 收尾

- [x] 6.1 全部测试绿 + `biome` 净 + `openspec validate --specs` 无新增失败
- [x] 6.2 真机往返：至少 WorkBuddy（L2 全链：auth → 写配置 → 客户端连上 → 161 工具 → 过期 → refresh → 再连）
  **已成，且真机逮出缺陷**：`fd-daas-mcp` `initialize 200 → session → tools/list 161`；
  `--refresh` 原先只续期不回写配置（「已续期」却仍握旧令牌）→ 已修（按受众认亲改写，真机复验三条目全更新）；
  `facet-market-mcp`/`facet-ops-mcp` 为客户令牌回边缘裸 401（内部运维面，不该进客户包引用）。
- [x] 6.3 台账 § 记录 + 记忆更新（能力表结论、refresh 补齐、L2 判据）——台账 §15.105 + 续记
