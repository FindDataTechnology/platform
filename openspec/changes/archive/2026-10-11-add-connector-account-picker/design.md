# add-connector-account-picker — Design

## Context

现状（已核实）：

- **壹座侧**：`user_connector_credentials` 以 `email` 为主键（`db.js` 迁移 23），`connector-credentials.js` 的 `liveToken(email)` 取唯一一行注入；路由 `server/routes/connector.js` 只有 GET 状态 / POST 粘贴 / DELETE 断开三个端点；前端 `ConnectorConnectPanel.tsx` 是单账号卡片。**一个用户只能有一个连接器账号**（生产库实际尚无任何用户粘贴过——表都未建）。
- **连接器侧**：PAT 铸造 `POST /api/tenant/pats` 已存在（要求 OIDC 会话，返回 `{token, id, name}`，明文一次）；`requireUser` 接受**会话 cookie 与 user_pat Bearer 两条路**；会话 cookie `oomol_connect_tenant_session` 为 `SameSite=Lax`；**无任何 CORS 配置**。`identities` 表持久存 email/displayName（每次登录 upsert 刷新）。
- **零粘贴先例**：registry 的 `web/src/lib/registry-mint.ts` 已跑通同构流程——弹窗登录 → `GET` 探活（简单请求，不触发预检）→ 浏览器内 `POST` 铸牌（带 cookie）→ 交后端按用户落库。

用户诉求：**同一人的多个连接器账号，在壹座里可选**；并接受"零粘贴"方向。以下决策已经两轮 grill 与用户逐条确认。

## Decisions

### D1 多账号存储：email + slot 复合主键 + active 标记 + pat_id

`user_connector_credentials` 重建为：

```sql
email  TEXT NOT NULL,
slot   TEXT NOT NULL,          -- 用户可读的账号名（零粘贴=连接器身份 email；粘贴=用户输入名或 'default'）
token  TEXT NOT NULL,
pat_id TEXT,                   -- 铸牌响应返回的 PAT id；粘贴路径为 NULL（无来源）
stale  INTEGER NOT NULL DEFAULT 0,
active INTEGER NOT NULL DEFAULT 0,
updated_at TEXT NOT NULL,
PRIMARY KEY (email, slot)
```

`active` 唯一性由写入路径在事务内维护（先把该用户所有行置 0，再把目标行置 1），不依赖数据库约束——写入点有限，代码内不变量足够且可测。

**为何用 slot 而不是不透明 id**：账号名是用户可见、可复述的（"工作号"），且天然去重——同名即替换。用不透明 id 会逼出"改名"这个额外操作。**不支持改名**：零粘贴路径名字=身份（无需改），粘贴路径重粘即换（不值得为它加改名键）。

**命名规则（grill 定案）**：零粘贴连接的账号**自动命名 = 连接器登录身份**——probe 响应携带 `{email, displayName}`，壹座取 email 作 slot（无 email 退化 displayName，再退化「身份N」）。妙处：同一连接器账号重连 = 同名 slot = 替换旧 token，恰好就是去重语义本身；个人号/工作号天然是不同 email = 不同 slot，用户零输入。手工粘贴路径没有身份信息，仍用用户输入名或 `default`。**迁移遗留的 `default` 行与后续零粘贴身份行不自动合并**（生产库尚无粘贴用户，近乎空集；真发生则手动断开旧的）。

### D2 活跃账号语义：单活跃、显式切换、任何情况下不自动改选

- 有效 profile 写入时只注入活跃账号的 token（`liveToken` 语义从"唯一一行"变为"活跃行"）。
- 切换活跃账号 = 一次凭据变更，复用既有的 `reapplyProfile` 热替换（无需重装 MCP 服务）。
- 活跃账号失效（401）时**不自动切换**：静默换账号会让 agent 用错身份、污染数据归属。
- **删除活跃账号后同样不自动改选**（grill 推翻了初稿的"自动改选其一"）：自动改选与"不自动切换"自相矛盾——删完回到无活跃状态，connector 服务从有效 profile 省略（与今天单账号断开行为一致），面板提示「选一个账号以恢复使用」，用户点一下才恢复。「设为活跃」是独立的一键操作，删除 ≠ 切换。
- **失效（stale）账号行只提供「重连」，不提供「设为活跃」**：token 已知是死的，设了立刻 401；重连走零粘贴流重新铸牌，同一身份 = 同 slot = 替换，正好复用 D1 语义。粘贴路径的 stale 行给重粘。

### D3 零粘贴机制：连接器侧新增跨域铸牌端点（拒绝 JWT 直认与 OBO）

三条候选路径与取舍：

| 路径 | 结论 |
|---|---|
| **跨域铸牌端点**（选定） | 连接器新增 `GET /api/tenant/cross-mint/probe` + `POST /api/tenant/cross-mint`，Origin 白名单 + 要求会话；会话 cookie 加 `SameSite=None; Secure` 部署开关。与 registry 先例完全同构，用户零操作 |
| JWT 直认租户 | **否决**。`verifyRuntimeJwt` 只做验签（返回 bool），不产生租户身份；要让 Logto JWT 直接认租户，必须回答"哪个 audience 的 JWT 对应哪个租户"，而同一 Logto 下任何应用签发的 JWT 若 audience 相同即可互相冒充——这是真实越权面，不是形式风险 |
| 服务 PAT 代铸（OBO） | **否决**。语义相反：账户归服务方而非用户，与"用户选自己的账号"冲突；且服务 PAT 权限高于用户，等于提权 |

**跨域端点的安全边界（硬约束）**：

1. **Origin 精确白名单**：`OOMOL_CONNECT_CROSS_MINT_ORIGINS`（逗号分隔）精确匹配 `Origin` 头；命中才回 `Access-Control-Allow-Origin: <该 origin>` + `Access-Control-Allow-Credentials: true`，且所有响应带 `Vary: Origin`。不用 `*`（要带凭据，浏览器本就拒绝 `*` + credentials）。fd-prod 白名单只放 `https://platform.finddatatech.cloud`——不放 localhost 开发域（开发对本地连接器测；对生产连接器测不了就走粘贴兜底），craw 旧域 301 到 platform、无需单列。
2. **必须已登录会话**：复用 `requireUser`；无会话 401。端点**只铸不读**——不回传任何既有 token、不列 PAT、不改删任何东西。probe 回显的是**调用者自己的登录身份**（email/displayName，来自 `identities` 表，与 `/me` 同源信息），不涉密。
3. **只在新 PAT 上返回明文一次**，与既有铸造端点同语义；同时返回 PAT `id` 与最终 `name`。
4. **未配置白名单时端点整体不注册**（404），`TENANCY=off` 下同样不注册——fork 硬约束下的最小暴露面。

`SameSite=None; Secure` 由 `OOMOL_CONNECT_CROSS_SITE_COOKIE=1` 控制，**默认关闭**——`TENANCY=off` 与上游行为逐字节不变。

**两个非显然的实现要点**：

- **旧 Lax cookie 死锁**：存量已登录用户的会话 cookie 是按 `Lax` 烙的，cookie 属性在 Set 时固定，跨站 fetch 永远带不上它；弹窗若开 `/me` 会「看着已登录、探活永远 401」死循环。修法：弹窗必须开 **OIDC authorize 登录 URL**——登录回调必经 `issueSession` 重发新 cookie（按当前开关烙成 `None`），死锁自解。IdP（Logto）会话在浏览器里通常还活着，老用户多半是无感静默重发。
- **probe 的响应必须带 CORS 头**：probe 是简单 GET 不触发预检，但浏览器要能**读到**状态码（区分 200/401）才有轮询意义——命中白名单时 GET 也要回 `Access-Control-Allow-Origin`，不是只有 POST 才需要。

### D4 账号标识复用既有 PAT `name`，不新增连接器字段

壹座铸牌时把账号名放进既有 `name`（`壹座 · <slot>`，如 `壹座 · aloadtree@gmail.com`），用户在连接器 `/me` 的 PAT 列表里能看出这枚令牌属于哪个壹座账号。**不新增 label 字段**（grill 定案，消除 proposal 初稿与 design 的矛盾）——`name` 已满足可读性需求，新增字段会扩大连接器侧 delta（迁移 + 投影 + 六语言），收益为零。

### D5 探活与铸牌的调用形状（对齐 registry-mint）

- 探活用 `GET` 且不带自定义头 → 简单请求，不触发 CORS 预检；200 时响应体携带登录身份 `{email, displayName}`（壹座据此定 slot，见 D1），401 = 未登录。
- 铸牌用 `POST` + `content-type: application/json` → 会触发预检，连接器侧必须处理 `OPTIONS`（返回允许的 methods/headers/origin）。这是实现时必须实测的一环，不能只写不验。
- 超时与失败语义：探活失败按"未登录"处理（走登录窗）；铸牌失败不产生账号（不留半连接状态）。

### D6 迁移 25：重建表并保数据

SQLite 不支持改主键，按既有迁移惯例（`db.js` 内 `version: 25`）**新建表 → 拷数据 → 删旧表 → 改名**，旧行一律迁为 `slot='default'`、`active=1`、`pat_id=NULL`，保证已连接用户升级后不掉线。迁移在启动时跑完，不存在新旧形状并行期。

### D7 断开/替换即 best-effort 吊销：复用既有端点，连接器零改动

（grill 第二轮翻案定案。初稿"断开不吊销、需跨域吊销端点"的前提是错的——已核实 `DELETE /api/tenant/pats/:id` 走 `requireUser`，**接受 user_pat Bearer**，租户守卫同租户即过。）

- 铸牌响应返回 PAT `id`，壹座随 token 一起存（D1 的 `pat_id` 列）。
- **断开账号**或**同 slot 重连替换旧 token** 时，壹座后端用所存 token 作 Bearer、id 作路径参，调连接器既有 `DELETE /api/tenant/pats/:id`：404/401（已撤销/已失效）与网络错误一律忽略（best-effort，失败不阻断本地删除）。
- 这同时消掉「重连一次留一枚活 PAT」的堆积问题。
- **粘贴路径无 id、不吊销**（既有行为，PAT 列表里也匹配不到行），维持记录；粘贴时代存量在生产为零。
- 连接器侧**零改动**——普通服务端到服务端调用，不开新跨域面。

### D8 SameSite=None 的波及面：变更类租户路由加 Origin 守卫

开关是全局的：开了它，连接器控制台自己的**所有**租户端点（铸/删 PAT、建/删连接）的会话 cookie 都变 `None`，全部暴露给跨站盲打——攻击者站点可带受害者 cookie 盲发 POST/DELETE。响应因无 CORS 头读不到（偷不走新 PAT 明文），但盲删 PAT/连接这类破坏可行。

处置（grill 定案）：**开关开启时，所有 `/api/tenant/*` 变更类请求（POST/DELETE）要求 `Origin` 同源或在白名单内**，否则 403。浏览器对非 GET/HEAD 请求必带 Origin（同源也带），连接器自己的控制台不受影响；PAT/管理员走 Authorization 头、不依赖 cookie，不受影响；非浏览器调用方（壹座后端的吊销调用带的是 Bearer PAT）同样不受影响。约 10 行中间件，把新开的口子连同顺带敞开的旧口子一起关死。

### D9 已知限制（记录，不修）

- **粘贴路径的 PAT 不吊销**：壹座删除本地行后连接器里的粘贴 PAT 仍有效（无 id 可寻，见 D7）。存量近零，接受。
- **账号选择是用户级、非会话级**：同一时刻该用户的所有会话共用活跃账号。会话级选择需要 profile 按会话分化，属另一量级改动。

## Non-goals

- 跨域吊销端点（不需要——D7 用既有端点即可；若未来要做破坏性跨域操作再单独评审）
- 会话级/按 agent 的账号选择（见 D9）
- 活跃账号失效或删除后的自动转移（见 D2，刻意不做）
- 账号改名（见 D1：零粘贴名字=身份无需改，粘贴重粘即换）
- 迁移 `default` 行与零粘贴身份行的自动合并（见 D1，近乎空集）
- 连接器侧 PAT 的"账号分组"管理界面（连接器 `/me` 保持现状，只多一个可读 name）

## Risks

| 风险 | 处置 |
|---|---|
| 跨域端点成为新攻击面 | Origin 精确白名单 + 会话强制 + 只铸不读 + `Vary: Origin` + 未配置即不注册；连接器侧补单测覆盖"非白名单 origin 被拒且不回 CORS 头" |
| `SameSite=None` 削弱 CSRF 防护（波及控制台全部租户端点） | 开关默认关；开启时变更类路由加 Origin 守卫（D8）；端点自身也校验 Origin（不依赖 cookie 的 SameSite 作唯一防线） |
| 存量 Lax cookie 死锁（已登录用户探活永远 401） | 弹窗开 authorize 登录 URL，回调必重发新 cookie（D3 实现要点） |
| 迁移丢数据 | 迁移脚本按"新建→拷贝→替换"保留旧行为 `slot='default'`/`active=1`；上线前在生产库快照上演练一次 |
| 铸牌风暴（重复点连接） | 前端在流进行中禁用入口；同一 slot 重复铸牌只替换不新增（D1），且替换时吊销旧 PAT（D7），不堆积 |
| 吊销 best-effort 静默失败（PAT 留活） | 接受：本地行为不受影响；危害=连接器 `/me` 里多一枚待手动清理的 PAT，与粘贴时代现状等同 |
| 连接器侧改动未上线时壹座先上 | 壹座侧以"探活失败 → 隐藏零粘贴入口、保留粘贴路径"降级（spec 已写），两仓可分别上线 |

## Verification

- **连接器侧**：单测覆盖跨域端点的 Origin 白名单（命中/未命中/缺头）、会话要求（无会话 401）、只铸不读（响应不含既有 token）、probe 身份回显；Origin 守卫（同源放行/跨站拒/白名单放行/GET 不受影响）；`TENANCY=off` 行为不变（既有 off 档测试全绿）。
- **壹座侧**：迁移测试（旧单行 → `default`/active，数据不丢）；多账号 CRUD 与 active 切换的 store 测试（含删除活跃后无活跃）；`resolveCredentials` 注入活跃账号的测试；面板多账号渲染测试（列表、活跃标记、切换、stale 行只给重连、降级）。
- **端到端（生产，真账号）**：零粘贴连接（无任何复制粘贴与输入动作，账号按 email 自动入列）→ 切换活跃账号 → 用所选账号跑一次真实 provider 调用确认注入的是它（runs 卡归因）→ 断开该账号并用旧 PAT 直调连接器确认 401（吊销实证）。
