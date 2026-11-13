# ciyuan-account-lane

## Why

词元（萬星·词元）在壹座里至今没有「账号」这个一等概念：模型车道走的是 `llm-providers.json` 里**部署级**的一把 key（`finddata` provider，`sk-or-…`，词元 group 3），所有用户的对话都记在平台账上；用户唯一能绑的「萬星 Caller」是一行**手贴 `sk-`** 的旧形态（CONTEXT.md「词元账号」词条已把它标为旧称），而且只喂运维 MCP，不喂模型。L1 立了「连接」分节、L1b 让应用中心的萬星·词元卡挂上了连接徽章——现在那张卡对所有人都亮「未连接」，正等这一刀把它翻绿。四刀路线 L2a；用户 10-18 拍板①：登录词元的终态是**零粘贴**，原计划先贴 key 过渡、再等词元侧加端点，但探明词元的编程铸键端点 `POST /api/v1/keys` 现成（跨仓开发量 = 0），所以**一次到位**，不走粘贴过渡。

架构事实（本次实查）：托管形态一用户一 cell（`gateway/index.js`「Cells run with a per-user cwd」），dsh 按请求从 cell 家目录 `.credentials.yaml` 的 `refs.LLM_PROVIDER_KEY_FINDDATA` 解析词元 key 并 Chokidar 热加载——「模型用户级凭据」不需要改调用链，只需在该 cell 的凭据文件里用用户自己的 key **覆盖**部署种子。

## What Changes

- **新增「词元账号」连接**（连接 id `ciyuan-account`）：连接分节新设一张卡，用户填词元邮箱+密码 → 壹座服务端调词元 `POST /api/v1/auth/login` 换 access_token → `POST /api/v1/keys`（name=`yizuo-<身份短哈希>-<日期>`，group_id=部署配置，默认 3 与部署 key 同能力面）→ 拿到只出现一次的明文 key → 存入该身份的只写凭据库 → **密码与 access_token 用后即弃，永不落盘、不进日志**。卡面展示：已连接/未连接/需重连、铸造时间、key 名、「测试连接」「断开」。
- **模型车道用户级计费**：托管 cell 内，绑定的词元 key 覆盖 `.credentials.yaml` 的 `LLM_PROVIDER_KEY_FINDDATA`（部署种子仍在 `llm-providers.json`，不动），下一次模型请求即走用户账号；断开后回落部署 key。单进程多用户形态（无 per-user cell）**不覆盖**（会把一人 key 记到所有人头上），卡面如实说明「本形态仅用于运维工具」。
- **萬星 Caller 并入**：`wanxing-caller` 凭据引用的活 token 改为「词元账号 key 优先，历史手贴 key 兜底」——同一把钥匙既喂模型也喂运维 MCP（词条定义）；产品线操作卡去掉「萬星 Caller」行；手贴 `sk-` 作为词元账号卡上的**次级入口**保留（词元登录不可用时的逃生口，复用现有粘贴路由）。
- **连接聚合与徽章**：`/api/connections` 的 `line-wanxing-caller` 条目改为 `ciyuan-account`（名「萬星·词元」）；应用中心 `wanxing-token` 卡映射改挂 `ciyuan-account`；深链 `?panel=ciyuan-account`。
- **失效语义**：卡上「测试连接」用存储 key 探词元 `GET /v1/models`，401 → 置 stale（卡与徽章「需重连」），**模型车道回落部署 key 保持可用**；网络失败不动状态。模型调用途中的 401 不自动置 stale（dsh 对 LLM 错误无凭据钩子，列为后续项）。
- **非目标**：搜索/语音车道改走用户 key（搜索仍是 SerpAPI BYOK/共享池两制，语音硬前置未解）；词元侧任何开发；按用户展示词元用量/余额（platform-billing 另议）；断开时在词元侧吊销 key（需再次输密码，v1 只本地删除并提示去词元控制台吊销）；首配流程里引导绑词元（L3 对话内连接再做）。

## Capabilities

### New Capabilities

- `ciyuan-account`：词元账号绑定（零粘贴铸键）、按身份只写存储、托管 cell 内模型车道 key 覆盖与回落、测试/失效/断开语义、粘贴逃生口；密码与 token 用后即弃、key 永不出现在任何响应与日志

### Modified Capabilities

- `connection-center`：连接分节卡集新增「词元账号」卡、产品线操作卡去掉 Caller 行；`/api/connections` 条目 `line-wanxing-caller` → `ciyuan-account`；深链 panel 新值 `ciyuan-account`
- `app-center`：「连接徽章与去连接」映射 萬星·词元（`wanxing-token`）→ `ciyuan-account`
- `line-credentials`：`wanxing-caller` 引用的活 token 来源改为词元账号 key 优先、历史手贴兜底；粘贴入口从产品线操作卡迁至词元账号卡
- `dsh-llm-providers`：凭据热加载存储新增「托管 cell 内按身份覆盖词元 provider ref」要求，覆盖/回落在下一请求生效

## Impact

- **后端新增**：`ciyuan-account-credentials.js`（存储/状态/liveToken/markStale，沿连接器家族形态）、`server/routes/ciyuan-account.js`（connect/test/disconnect/paste，无 token 的投影响应）；**修改**：`dsh-profile.js ensureCredentialsStore`（cell owner 有账号 key → 覆盖 `LLM_PROVIDER_KEY_FINDDATA`）、`credential-refs.js`（wanxing-caller 的 `liveToken` 改为账号优先 + 面板表 `ciyuan-account`）、`server/routes/misc.js /api/connections`、`server/routes/line-credentials.js`（Caller 粘贴路由保留给逃生口）
- **前端**：`web/src/components/settings/ConnectionsSection.tsx`（新卡 + 深链 id）、新 `CiyuanAccountConnectPanel.tsx`、`LineOpsConnectPanel.tsx`（去 Caller 行）、`web/src/lib/appCatalog.ts`（映射）、五语 locale
- **配置**：`CIYUAN_API_BASE`（默认 `https://token.finddatatech.cloud`）、`CIYUAN_MINT_GROUP_ID`（默认 `3`）
- **测试**：新单测 `scripts/test-ciyuan-account.mjs`（铸造流用假词元服务、投影无密钥、覆盖/回落写入、单进程不覆盖、历史 Caller 兜底）；`test-app-center.mjs` 已知 id 集更新；e2e `connections.spec.js`（新卡/深链/id 集）、`app-center.spec.js`（映射）、新 `ciyuan-account.spec.js`（假词元服务下的 connect→connected→test→stale→disconnect）
- **兼容**：既有手贴的 wanxing-caller 凭据零迁移、继续生效（兜底读）；部署 key 不动；旧深链 `?panel=line-wanxing-caller` 重定向到 `ciyuan-account`
- **词汇表**：落实 CONTEXT.md「词元账号」词条（Avoid「词元登录」「萬星 Caller」），UI 文案用「词元账号」
