# Design — ciyuan-account-lane

## Context

动机见 proposal.md「Why」。与方案相关的实查事实：

- **模型 key 的解析点不在请求链上**：dsh（agent 运行时）按请求经 `dsh-credentials-local` 从 cell 家目录 `.credentials.yaml` 的 `refs.LLM_PROVIDER_KEY_<ID>` 解析（`envRefForProvider("finddata")` → `LLM_PROVIDER_KEY_FINDDATA`），Chokidar 热加载；profile 的 llm-pi-ai 行只引用 env 名。`ensureCredentialsStore`（dsh-profile.js:320）是唯一写入方：env 种子 + Models 页用户 provider 的 key，用户 provider 的 ref 删除时会 prune。
- **托管形态一用户一 cell**：`gateway/index.js:82`「Cells run with a per-user cwd」；`agent-session.js:649` 已有 `ctx.cellUserEmail`；dev/桌面单进程形态多用户共享一个存储。
- **词元侧端点现成**（后台代理 10-18 探明，admin API 配方）：`POST /api/v1/auth/login`（email+password → `data.access_token`）、`POST /api/v1/keys`（`{name, group_id}` → 明文 key 只出现一次）。DB 实查：部署 key（id 2）在 **group 3 `openrouter`**（4 个 openai 平台账号背书，chat+三车道能力面）；trial 经验组 3 = chat+三车道。
- **wanxing-caller 现状**：`line-credentials.js` 的 `sk-` 粘贴 + 401 置 stale；`credential-refs.js` 表驱动 `liveToken(email,"wanxing-caller")` 注入运维 MCP。
- **LLM 401 无钩子**：`dsh-events.js` 的 401→stale 只覆盖 MCP 工具结果；模型调用的上游 401 只会以聊天错误文本出现。
- **凭据文件格式有硬不变量**（credential-file-format）：单行引号标量、0600、block-scalar 禁止——本 change 复用 `ensureCredentialsStore` 的写入路径即自动满足。

## Goals / Non-Goals

**Goals:**

- 用户一次输密码拿到自己名下的词元 key；模型车道在下一请求即按用户计费；断开/失效回落部署 key，平台永不因此不可用。
- 万象迁移零成本：既有手贴 wanxing-caller key 继续生效；部署 key 与 `llm-providers.json` 不动。
- 词元侧零开发；壹座侧不引入新依赖。

**Non-Goals:**

- 搜索/语音车道接入用户 key；词元用量/余额面板；断开时在词元侧吊销；首配引导；模型调途径中 401 自动置 stale（无钩子，后续项）；多词元账号/多分组选择 UI。

## Decisions

### D1 覆盖点 = `ensureCredentialsStore`，不是调用链

在 `ensureCredentialsStore` 的写入序列（env 种子 → 用户 provider refs → prune）之后追加第三层：cell owner 有绑定 key 时，`doc.refs.LLM_PROVIDER_KEY_FINDDATA = <账号 key>`（覆盖种子/Models 页写入的同名 ref）。重写触发点：绑定成功、断开、置 stale 之后直接调一次（沿 reloadLlmProviders 的现成路径）。

- 理由：dsh 按请求解析 + 热加载是**已上产契约**（dsh-llm-providers R2），复用它等于零调用链改动、天然「下一请求生效」；在 server 侧拦截/代理模型请求是重写一条不存在的链路。
- 备选：为每用户写独立 profile（dsh 多 profile 切换）——dsh 单 cell 单 profile，改动面大且无人要。

### D2 绑定流：服务到服务的 login→mint，密码用后即弃

`POST /api/ciyuan-account/connect` {email, password} → server fetch 词元 `CIYUAN_API_BASE`（默认 `https://token.finddatatech.cloud`）`/api/v1/auth/login`（10s 超时）→ access_token → `/api/v1/keys` `{name: "yizuo-"+sha256(identityEmail).slice(0,8)+"-"+YYYYMMDD, group_id: CIYUAN_MINT_GROUP_ID ?? 3}`（10s）→ 存 key+元数据（key id、name、group、mintedAt、ciyuanEmail 只存可显示的掩码形式：首 2 字符+域名）→ 触发凭据重写。密码与 access_token 只存在于该请求的局部变量：不落库、不进日志（错误对象打印前对 password/token 字段脱敏）、不进 trace（沿 misc.js 对搜索 key 的既有 redact 手法）。

- 词元错误分类直通可读文案：登录 401（凭据错）、铸键失败（含 group 不允许/名额满）、网络失败（保持原状态）。
- 备选：前端直连词元 login 再把 key 交壹座——词元 CORS 是否放行壹座 origin 未知，且 access_token 落浏览器违背用后即弃；浏览器直连还把密码暴露给前端扩展面。服务到服务是唯一可控路径。

### D3 铸进部署 key 同组（默认组 3），env 可配

`CIYUAN_MINT_GROUP_ID` 默认 3（openrouter）。理由：与部署 key 完全同能力面（chat+三车道），用户的模型清单不因绑号而变化，llm-guard/默认模型逻辑零扰动；组 3 非 exclusive（`is_exclusive=f`）多 key 共存无冲突。**不在 UI 提供选组**：组 = 套餐维度（车道词条），让用户选组等于让用户猜套餐策划，一次到位的体验是「绑了就能用平台现有模型」。

### D4 新凭据模块仿连接器家族，不做第二套

`ciyuan-account-credentials.js`：per-identity SQLite 行（沿 line-credentials 的存储形态）+ `status(email)` / `liveToken(email)` / `markStale(email)` / `remove(email)` / `store({email, key, meta})`。投影字段白名单：`{connected, stale, mintedAt, keyName, ciyuanEmailMasked}`。注册进 `credential-refs.js` 表仅作 **wanxing-caller 的活 token 来源**（见 D5），不新增 MCP ref——词元账号本身不挂 MCP server 行。

### D5 wanxing-caller 活 token 优先级：账号 key > 历史手贴

`credential-refs.js` 表中 wanxing-caller 项的 `liveToken` 改为 `(email) => ciyuanAccount.liveToken(email) ?? lineCredentials.liveToken(email, "wanxing-caller")`。两源共用 stale 翻面（任一 401 → markStale 两者中活跃的那个）。手贴入口从 LineOps 卡迁到词元账号卡（复用 `POST /api/lines/wanxing-caller/credential` 原路由，零后端新代码）。

- 备选：账号绑定即迁移并删旧手贴 key——破坏「零迁移」承诺且粘贴 key 可能还在别处用；备选：账号与 Caller 永久两凭据——把「同一把钥匙」的产品事实又撕回两个 UI 概念，正是本 change 要消的。

### D6 覆盖守卫：只有 per-user cell 才写

`ensureCredentialsStore` 的覆盖层以 `ctx.cellUserEmail`（hosted）为键：有值 → 该邮箱的绑定 key 覆盖；无值（单进程/桌面）→ 跳过覆盖且不报错。UI 侧：卡面在单进程形态渲染一行说明「本部署为单进程形态：账号仅用于运维工具，模型车道仍走部署密钥」（`/api/config` 已暴露形态判据，复用现成分辨）。

- 理由：共享存储写一人 key = 全体用户悄悄替他计费，是最坏失败模式；宁可诚实降级。

### D7 id 退役与别名：`line-wanxing-caller` → `ciyuan-account`

`/api/connections` 条目、深链 panel、L1b 的 `APP_CONNECTIONS` 映射三处同改；`?panel=line-wanxing-caller` 作为**已知别名**解析到新卡（ConnectionsSection 的 panel 匹配表加一行），避免外部书签/在途链接断链。e2e `connections.spec.js` 与 `test-app-center.mjs` 的已知 id 列表同步（`line-wanxing-caller` 出、`ciyuan-account` 进）。

### D8 失效：探针制 + 回落，不做自动 401 stale

「测试连接」= 存储key GET `CIYUAN_API_BASE/v1/models`（5s 超时）：200→connected、401→stale、网络→不动。stale 时模型车道照 D1 的重写回落部署 key（平台可用性优先，代价是计费回平台——卡面与徽章的「需重连」持续提示这一事实）。模型调途径中 401 自动置 stale 缺 dsh 钩子，列为后续项（dsh 侧 LLM 错误事件带 provider/status 后即可挂）。

### D9 断开只删本地，吊销留给词元控制台

断开 = `remove(email)` + 凭据重写（回落种子）+ 卡面提示「词元侧的 key 仍有效，可去 token.finddatatech.cloud 吊销」。理由：吊销需要重新拿 access_token（要么再要一次密码、要么长期存 refresh 凭据——后者违背用后即弃）。

## Risks / Trade-offs

- [用户套餐不含平台默认模型 → 绑号后首聊报 model_not_found] → llm-guard 已有「暗默认模型切换」机制兜底（仅 boot/refresh 时验证）；绑定成功的 e2e 用假词元服务断言链路，真套餐差异属词元侧策划，生产首验时用 trial 账号实测一次并记录。
- [密码经壹座服务端中转] → 全链 TLS（公网 https）；局部变量用后即弃 + 日志脱敏 + 不入 trace；spec 以场景硬性断言「任何存储/日志/trace 检索不到」。这正是「零粘贴」的代价面，产品决策已拍板（贴 key 过渡被「端点现成」取代）。
- [词元 login 未来加验证码/2FA] → 服务到服务 login 一旦失败即整体拒绝（可读原因），粘贴逃生口保底；不静默降级。
- [key 名冲突/重复绑定] → name 含身份短哈希+日期；重复绑定直接铸新 key 覆盖存储（旧 key 留在词元侧，提示文案同 D9）；不做「找到旧 yizuo-* key 复用」（需要 keys 列表权限，login 态未必有）。
- [Models 页管理员改 finddata 的 apiKey] → 下一次凭据重写账号 key 仍按 D1 覆盖（账号优先级显式高于 Models 页写入）；管理员要临时切回种子须先让用户断开——在卡的副标题注明优先级规则。
- [单进程部署用户困惑「绑了没效果」] → D6 的诚实降级说明 + 该形态非生产形态。

## Migration Plan

纯壹座侧增量 + 三处 id 替换，无数据迁移（手贴 key 原样兜底）。发布沿公开快照线（先 `ls .github/workflows` 再推镜像仓）；回滚 = 双清单回 `sha-8b184a1`，回滚后绑定流不可达但已存 key 仍作 wanxing-caller 兜底（读路径是新增的 fallback，回滚即消失，手贴 key 不受影响）。生产首验：真实 trial 词元账号走 bind→徽章翻绿→模型一问（对账 usage_logs 计费主体）→断开回落。

## Open Questions

（无影响 spec/任务的未决项；组默认值与断开语义已在 D3/D9 定案并写入 spec，如需改是提案级变更。）
