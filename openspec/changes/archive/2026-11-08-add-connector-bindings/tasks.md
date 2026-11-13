## 1. 声明校验（包 manifest 侧）

- [x] 1.1 `pack-store.js` 的 manifest 校验新增 `connector_bindings` 形状校验：`key` 包内唯一且非空、`provider` 非空、`allowOperations` 与 `allowActions` 至少一项、`operationType` ∈ {read, write}、`optional` 布尔。验证：四条坏声明各被拒并指明字段；合法声明通过。
- [x] 1.2 人读字段（`external_system`/`surface`/`direction`/`credential`/`note`）不参与校验。验证：仅填人读字段而无 `allowOperations`/`allowActions` 的绑定被拒，且错误信息指出缺范围而非缺描述。
- [x] 1.3 用 `fd-erp-vertical-templates/templates/supply-chain/connector-pack/pack.json` 作真实样本跑校验。验证：该包在补齐机器字段前被拒、补齐后通过（把补齐前后的两个样本都作为用例固化）。
  验证：`scripts/test-connector-bindings-manifest.mjs` 的三条真包用例——`supply-chain-before.json` 被拒且**恰好 5 条** `connector_binding_scope_missing`（错误全落在 `connector_bindings.*` 条目上，没有一条误指向别的键，`provider_status` 散文本身不再算错）；`supply-chain-after.json` 零错；after 的人读字段（`external_system`/`surface`/`direction`/`credential`/`note`）逐条仍在。归档前复核夹具与真源一致：`test/fixtures/connector-bindings/supply-chain-after.json` 的 `connector_bindings` 与真包 `fd-erp-vertical-templates/.../connector-pack/pack.json` 的 5 条**逐条相等**（不只形状像，内容同源），所以这条用例钉的是真实包而不是自造样本。

## 2. 存储与迁移

- [x] 2.1 `db.js` 新增 version 114：`user_connector_credentials` 重建加 `kind`/`purpose`/`source_account`，主键改 `(email, kind, slot)`；新增 `connector_binding_ledger`。验证：空库与 v25 存量库各迁移一次，行数与 token/pat_id/stale/active 逐列等值。
- [x] 2.2 幂等回填：有账号行且缺 `slot='chat:explore'` 的内置自由探索绑定行时补一行（`kind=binding`、全权、`purpose=内置自由探索`）。验证：连续启动两次只产生一行。
- [x] 2.3 `connector-credentials.js` 投影区分两类行；账号区的「主账号」由 `active` 重读，绑定行恒不参与注入决策。验证：多账号 + 多绑定的投影用例。

## 3. 绑定解析与台账

- [x] 3.1 新增 `connector-bindings.js`：解析单条绑定 → 调连接器自省面判 provider 存在性与读/写覆盖 → 结合本地连接事实产出四态。验证：四态各一用例（含 `unwired` 不退化为 `missing`）。
  - 落地：`connector-bindings.js` 的 `createConnectorClient`（只用连接器两个只读自省面：`/api/tenant/catalog-coverage`、`/api/tenant/connections`，均按 open-connector-mt `tenant-routes.ts` 实测形状解析，无本地目录副本）+ `resolveBinding`（候选 provider 依序试 `provider`→`alternativeProviders`；`gaps` → `unwired`，`404 unknown_provider` → `unwired`，本地无连接 → `missing`，凭证 401 → `stale`）+ `injectableBindings`（只认 satisfied 且有活令牌者）。
  - 用例：`scripts/test-connector-binding-resolve.mjs` 18/18 绿——satisfied / missing / unwired（已知 provider 缺写面、未知 provider 两种）/ stale（台账已 stale 时不打自省面 + 自省面 401）/ undetermined 全覆盖；另补「虚拟连接」用例：连接器把 `no_auth` 与运营开启的 marketplace 报成 `virtual:true, configured:true`（连接器侧实测事实），这类不需要用户动手，判 satisfied 并带 `connectionVirtual` 供状态面说「平台代管」。
  - 台账记 `connection.id`（稳定，spec 口径）而非连接名；`connectionName` 只作瞬时展示字段。
- [x] 3.2 解析幂等：同输入重复解析不改行数、不改已授权令牌。验证：连续解析两次的台账快照相等。
  - 落地：`resolvePack` 逐条比 `sameResolvedRow`（pack_version/连接/状态/optional 全等）与 `sameDeclaration`（provider + 操作类集合），无变化则整条不写库；首次实现每次 upsert 都刷 `updated_at`，用例把两次快照打成 JSON 比对时暴露，故改为「不变不写」。
  - 用例：`resolution is idempotent` 断言二次 `resolvePack` 返回值与 `listBindings` 快照逐字节相等、令牌原样保留。
- [x] 3.3 远端不可达时状态为「未判定」而非 `unwired`。验证：自省面超时用例断言不产生 `unwired`。
  - 落地：`createConnectorClient.getJson` 把 fetch 拒因（DNS/ECONNREFUSED/`AbortSignal.timeout`）与非 2xx/不可解析 body 一律收敛为 `{ok:false, code:"unavailable"}`；`resolveBinding` 再兜一层 try/catch（注入的 client 自己抛也不外溢），两者都映射 `undetermined`/`catalog_unreachable`（连接面同理 `connections_unreachable`）。未配置连接器的部署同样 `undetermined`/`connector_not_configured`。
  - 用例：`undetermined: an unreachable connector...` + `the real client turns a transport failure into a code, not a throw`（真 client + 抛错的 fetchImpl，并断言 401/404/503/坏 body 各自的 code）+ `no connector configured`。
- [x] 3.4 `pack_version` 与声明变化检测：同 `binding_key` 但范围变化时重建并要求重新授权，旧令牌吊销；`key` 消失时标 `deprecated` 不自动删令牌。验证：三条升级用例。
  - 落地：声明变化（provider 或操作类集合变）时删绑定令牌 **并删台账行**——旧 `granted_at` 不能留在没有令牌的行上骗状态面；包弃用的 key 标 `deprecated` 且保留令牌（升级不该让运行中的会话失去能力），且不进 `injectableBindings`。
  - 用例：`a declaration change drops the old token and asks for a fresh grant`（read→read+write，断言令牌消失、`grantedAt` 归零、`injectableBindings` 为空）、`a binding key the pack drops is deprecated and keeps its token`、撤销回落 `revoking a grant falls back to missing`。

## 4. 注入改单轨

- [x] 4.1 `credential-refs.js` 契约扩为 `liveToken(email, config)` 并新增 `connector-binding` ref；`liveTokenForRef(ref, email, config)` 透传。验证：既有六个 ref 的回归用例全绿（签名兼容）。
  - 落地：`resolveCredentials` 由「按 ref 取一枚令牌」改为**逐服务器取令牌**（单令牌 ref 结果逐字节不变，同一 ref 仍汇总成一条 injected/omitted 报告）；`invalidateRef(ref, email, config)` 也透传 config。新 ref 按 **slot** 解析（`liveTokenBySlot`），因为 `(packId, bindingKey)` 才是绑定身份、且两包可同名 key。
  - 用例：`scripts/test-connector-binding-injection.mjs` 9/9 绿（含单令牌 ref 两条服务器的字节等价断言 + 逐行 ref 的 injected/omitted 分离断言 + 无 slot 一律 null 断言）；既有 `test-registry-credentials` 17、`test-paper-trading-credentials` 16、`test-facet-market-ref-dispatch` 9 全绿。
- [x] 4.2 `dsh-profile.js` 三处消费点（738/939/1025）传 `config`；基线 `connector` 行降级为模板（只提供 url），按台账展开多行，各带该绑定独有的范围令牌。验证：多绑定 → 多行且 Authorization 各异；台账为空 → 零连接器行。
  - 落地偏差（有意，记在此）：行名实为 `connector:<slot>` = `connector:<packId>:<bindingKey>`，不是 `connector:<bindingKey>`。原因是 401 只能从行名反推身份（绑定行是每次会话现生成、库里没有记录可查），而 `bindingKey` 在不同包里可重复——带上 pack 才能把 401 精确落到一条绑定上。内建探索绑定没有 pack，故其行为 `connector:chat:explore`。
  - 另一处落地细节：`toMcpClientEntry` 的白名单只把 transport/url/headers 写进 cell 补丁，`credentialRef`/`slot` 因此**不会**落到用户机器上（只落解析后的 Authorization 头）；用例显式断言这两者不在补丁里。
  - 未认证部署（ownerEmail=null）保留原基线 `connector` 行不动：没有身份就无法解析绑定，删行等于让 auth-off 安装彻底失去连接器能力。这是「全局行退役」的唯一豁免，已在此记录。
  - 用例：`test-connector-binding-injection.mjs` 的「两绑定两行、Authorization 各异」「无授权绑定 ⇒ 零连接器行」「全权账号令牌只能经绑注入」「未安装包的绑定不注入」四条；`test-connector-credentials.mjs` 3.2 / 2.3 已改为按 `connector:chat:explore` 断言并显式断言全局 `connector` 行不再出现。
  - 顺带补真缺陷：`connectorCredentials.store/setActive/disconnect/markInvalid` 现在把**活跃账号**镜像到内建探索绑定（否则升级后再连接的用户会「存了令牌但没有任何行注入」）；用例 `4.2 a full-authority account token is only injected through its binding` 覆盖「删掉绑定后同一枚全权令牌也不再注入」。
- [x] 4.3 单行失效不牵连：某绑定 401 → 只省略该行并重应用一次，其他行保持注入。验证：两绑定一失效的 profile 断言 + 重应用次数断言。
  - 落地：`server/dsh-events.js` 从行名合成配置（`connector:<slot>` → `{credentialRef:"connector-binding", slot}`）并把 `config` 透传给 `markInvalid`，`markSlotInvalid` 同步把该 slot 的台账行翻 `stale`（状态面与 profile 口径一致）。
  - 用例：`test-connector-credentials.mjs` 2.5b（两 pack 同名 key 各持不同令牌，401 只翻 pack-a，`updateCalls.length===1`，第二次 401 不再重应用）、2.6（非绑定服务器的 401 不动绑定）、`test-connector-binding-injection.mjs` 的「失效只撤该行 + 其余行保留自己的令牌」与「撤销/重授后行消失/复活」。

## 5. 授权流（声明式 + 渐进）

- [x] 5.1 安装/激活门：带绑定的包在安装时逐条解析，存在未解决的**非 optional** 绑定时不得标记「已接通」；`optional` 未满足只降级。验证：三种安装用例（齐备 / 非 optional 缺 / 仅 optional 缺）。
  实现：`connector-grants.js` 的 `refreshPackBindings` + `gateFromRows`；门跑在 `pack-store.installPack` 里、`upsertInstalledPack` **之前**，所以把 `declarations`/`packVersion` 显式传入而不是回读未落库的包记录（回读会让门看到空声明并谎报「无未解决项」——正是首轮用例如实抓到的缺陷）。`connected = unresolved 为空 ∧ pendingGrant 为空`：已解析但未授权的绑定算 `pendingGrant`，不算已接通。`optional` 未满足只进 `optionalUnmet`，不进 `required` 计数。
  验证：`scripts/test-connector-binding-grants.mjs` 5.1 五条（齐备→先 false 后 granted true / 非 optional 缺→`missing:no_connection` 且同级可授信不阻塞 / 仅 optional 缺→`missing` 且 `required=1` / unwired→`unknown_provider` 能力缺口且 `grantable=[]` / `installPack` 报告带门且不含 `oct_`/`pat-`）。另注：只写台账未声明于 manifest 的 key 会被解析器标 `deprecated`（包升级弃用语义），测试显式覆盖了这条区别。
- [x] 5.2 声明式授权：一个弹窗列出全部可解析绑定，确认后一次性为各绑定铸范围令牌（走衰减派生或 cross-mint，按会话可用性选路）。验证：确认后各绑定各有令牌；未确认不产生任何令牌。
  实现：`grantPack`（逐绑定结果，`unwired`/`missing` 只记 `not_grantable:<status>` 不拖垮兄弟）+ `grantBinding`/`mintBindingToken`（走连接器 `POST /api/tenant/pats` 衰减派生：以用户自己的活跃账号令牌为父，只申请该绑定声明的类）。无账号令牌即 `no_account` 且**零请求出网**——绝不退回部署级令牌。
  验证：5.2 两条（一次确认后两绑定各有独立令牌、每次铸造只申请声明类、确认前 `injectableBindings=[]`；无账号→`failed[0].code=no_account` + `connector.log.length=0`）。
- [x] 5.3 渐进授权：`action_not_allowed` → 调 `scope-explain` 取 `(provider, operationType)` → 出授权卡 → 确认后重铸（并集）→ 下一轮生效；**不自动重放**原调用。验证：读与写各一条用例，均断言无自动重试。
  实现：`explainAction`（连接器 `GET /api/tenant/scope-explain` 是动作类的唯一权威，且区分 404 `unknown_action` 与 `allowed:false`）+ `grantForAction`。并集来自绑定台账声明的类 ∪ 新类；连接器对同名重铸本来取并集并吊销被替换的兄弟，所以重复授予幂等。返回体固定 `replayed: false`，本模块从不执行动作。
  验证：5.3 四条（写被拒→`operations=["read","write"]` 并集不被替换、下一轮才生效、全程只有 `scope-explain`+`pats` 两个调用且第二次铸造得新令牌 / 读被拒同样一次铸造零执行 / 已被允许→`already_allowed` 不出卡不铸造 / 未知动作→`unknown_action` 不铸造）。**顺带修掉两个真缺陷**：`requestJson` 原按扁平 `parsed.code` 读错误码，而连接器是 `{error:{code,message}}` 信封，导致一切拒绝都成了 `http_404`；`grantForAction` 的返回对象把 `...explained` 放在 `ok:false` 之后，`ok` 被覆盖成 `true`，`already_allowed`/`unknown_action` 因此谎报成功。
- [x] 5.4 同类只授一次：已授权某 provider 的读类后，同绑定另一读动作被拒不再弹窗。验证：用例断言第二次被拒时无授权卡（若仍被拒则说明范围未生效，属缺陷）。
  实现：同 5.3 的 `explainAction` 前置判断——范围已生效时连接器答 `allowed:true`，代码据此返回 `already_allowed` 且不铸造。验证：5.4 一条（第一次铸 1 次，第二次同 provider 另一读动作→`already_allowed`、铸造次数仍为 1、该绑定只存在一个 PAT 且 `read` 只出现一次）。
- [x] 5.5 撤销与失效：撤销授权 → 令牌吊销 + 行消失 + 台账回落；令牌 401 → 该绑定 `stale`、行省略、不自动改选替代连接。验证：两条用例。
  实现：`revokeBinding`（先以该绑定 PAT 自删 `DELETE /api/tenant/pats/:id` 尽力而为，再删本地行，断网也不阻塞）+ `connector-bindings.markSlotInvalid`（401 时凭证行与对应台账行同步转 `stale`，按 slot 定位所以两包同 key 也只影响一个）。
  验证：5.5 三条（撤销后 `removed/revokedOnConnector` 为真、连接器无残留 PAT、台账回落 `missing`；连接器不可达仍删本地令牌；401 只翻一个绑定的 `stale`、兄弟令牌不动、重解析仍报 `stale` 且 `connectionId=null` 即不自动改选另一连接）。

## 6. 状态面与指引接线

- [x] 6.1 `GET /api/connections` 的 connector 条目加绑定投影（各绑定 key/provider/操作类/状态/optional + 未解析计数），不含令牌、PAT id、未授权连接 id。验证：投影字段断言 + 「无凭证材料」负例断言。
  实现：`server/routes/misc.js` 的 `projectBindingLedger`，逐字段构造（台账行还带解析出的连接 id 与授权时间戳，两者都不进状态载荷）。`unresolved` 只数非 optional 且非 `satisfied` 的活行，且**排除 `undetermined`**——「问不到」不是「你去干活」；`unwired` 单独计数，因为那不是用户接个账号能关掉的活。owner key 走 `connectorCredentials.ownerKey`，否则 `TENANCY=off` 下 email 为空会把整个投影跳过。
  验证：`scripts/test-connections-binding-projection.mjs` 3/3（条目带 rows+summary；负例断言载荷里没有 `oct_`/PAT id/连接 id；无台账行给空投影而非缺字段）。
- [x] 6.2 `ConnectionsSection.tsx` 卡片改绑定为主视图，保留账号区与「打开连接器控制台」入口；`unwired` 如实标注能力缺口；**每条提供对应动作（去连接 / 去授权 / 重连 / 撤销授权）**。验证：四态渲染 + 四动作的组件用例。
  实现：新增 `web/src/components/settings/ConnectorBindingsView.tsx`（按包分组、逐条状态徽章 + 可选标；`unwired`/`undetermined` 各一句说明，只在出现时渲染），在连接器卡里排在 `ConnectorConnectPanel` 之前——需求在前、供给在后。`deprecated` 不渲染（那是历史不是需求）；读取失败保持「不知道」，绝不渲染成「什么都不缺」。
  动作口径（`actionFor`）：`satisfied` 且无活令牌 → 「去授权」（`POST /api/connector/bindings/grant`，一次铸该行声明类）；`satisfied` 且有活令牌 → 「撤销授权」+「授权于 …」；`missing`/`stale` → 「去连接」/「重连」链到连接器控制台 `/me`（地址取部署基线 `connectorUrl + mePath`）。`unwired`/`undetermined` **不给动作**：目录缺口没有任何用户手势能关掉，问不到也不是待办——死按钮比没有按钮更坏。基线里没有连接器行时 `missing`/`stale` 也不渲染链接（下方账号区仍可手工粘贴连接）。
  三处真断点/真缺陷一并修掉：① 范围指引的 panel id 是 `connector-bindings`，而卡片锚点原本只有 `connector`，深链会打开页面却不高亮任何东西——现在两个 id 都算命中；② 只声明 `allowActions`（无 `allowOperations`）的绑定铸不出令牌（`empty_scope`）——`mintBindingToken`/`grantBinding` 现在透传 `allowedActions`，且授予时**总是**重发 `actions`（漏发等于把动作类权限降级掉）；③ `revokeBindingGrant` 复用 upsert 时 `granted_at` 被 `COALESCE` 保住，撤销后行上仍挂着旧的授权时间——改为删行再插。
  验证：`e2e/connections.spec.js` 两条，fast 项目 6/6 通过。四态那条现在还种了一枚活令牌（`user_connector_credentials`,`kind='binding'`,`slot='pack-e2e:kingdee'`）与部署基线 `mcp.json`，因此断言的是真投影而非推断：`kingdee` `data-granted="1"` + `data-action="revoke"` + 「授权于」可见；`alipay`（satisfied、无令牌）`data-granted="0"` + `data-action="grant"`；`wms` `data-action="connect"`、`erp-legacy` `data-action="reconnect"`，两者 `href` 均为 `https://connector.e2e.test/me`；`carrier`（`unwired`）零动作。汇总口径同步为 5 条活绑定。
  另一条验证 `?panel=connector-bindings` 命中 `[data-panel='connector']`。
  单测侧：`scripts/test-connector-binding-grants.mjs` 19/19（新增「只声明 actions 也可授」「扩权保留动作类」「五个绑定路由齐全」「server.js 挂载」四类）。
- [x] 6.3 `chat-connect-guidance` 分类器新增「范围不足」类与 scope 指针，与凭据失效互斥。验证：三条分类用例（范围不足 / 真 401 / 无判定都不挂双指针）。
  实现：`server/connect-guidance.js` 的 `SCOPE_NOT_ALLOWED_RE`（只收 `action_not_allowed`/`connection_not_allowed`）+ `toolFailureHint` 里 scope 判定前置。理由写在代码里：`_blocked` 系列是部署策略，任何用户授权都移不动，把用户指向授权卡等于骗人，所以不算范围不足。`actionId` 从载荷提取但 `(provider, operationType)` 只由 `scope-explain` 回答，分类器不猜（`options.scope` 供已问过的调用方回填）。范围类优先于凭据类：包了一层传输错误时也不许把权限问题报成「你的凭据死了」。
  验证：`scripts/test-connect-guidance-scope.mjs` 8/8（范围不足挂 scope 指针不挂凭据指针；`connection_not_allowed` 同类且 `actionId` 缺失也不猜；调用方给过答案时补 provider+读/写；`_blocked` 不给授权指针；真凭据失效仍走凭据分类；registry 401 既有行为不回归；超时/普通错误不挂任何指针；两类指针互斥）。

## 7. 迁移与收口

- [x] 7.1 迁移等价性：对单账号存量快照，断言升级前后同一动作仍可执行（内置自由探索绑定保留全权）。验证：端到端用例「升级前执行 → 升级后同一调用仍成功」。
  实现/验证：`scripts/test-connector-binding-migration.mjs` 的 7.1 用例——先建真库再把凭证表回落到 v25 形态、抹掉 v114 与台账（与 2.1 同一「忠实升级」手法，走平台自己的句柄，避免双绑定同 WAL 不可见），升级后断言：连接器行**有且只有一行** `connector:chat:explore`、url 与升级前模板一致、`Authorization` 就是升级前活跃账号那枚令牌（`oct_primary_live`）、`credentialRef`/`slot` 不落补丁；再把该行配置交给 `credentialRefs.resolveCredentials` 解析（工具调用真正查的就是它）得同一 Bearer、`omitted` 为空；重写一次 profile 文件**逐字节相同**（升级没有悄悄换令牌或换 slot）。
- [x] 7.2 多账号存量：原活跃账号为主账号，其余账号保留为来源且不自动获得授权。验证：迁移后台账为空、账号数为原数量。
  实现/验证：同一文件 7.2 用例——两账号（primary 活跃 / secondary 已 stale）升级后仍是两个账号、`status().slot` 仍是 `primary`、`liveToken` 仍是 primary 的令牌；stale 账号保留原样（不复活、不升为注入候选）；`listBindings(email)` 为空、`injectionRows(email)` 只有 `["chat:explore"]`、补丁里也只此一行且用 primary 的令牌；同时断言另一身份拿到的是它自己的令牌（迁移后的跨身份隔离）。
- [x] 7.3 全量测试与静态检查：`npm test` 全绿、既有 e2e（app-center / connections）不回归。
  验证：本仓没有 `npm test` 脚本，全量单测入口是 `npm run test:unit`（`node --test --test-concurrency=1 scripts/test-*.mjs`，415 个文件）。**3784 条 / 3779 通过 / 0 失败 / 0 取消 / 5 跳过（各文件自带 SKIP 理由）**；e2e `playwright test --project=fast e2e/connections.spec.js e2e/app-center.spec.js` **18/18 通过**（connections 6 条含 6.2 的 `?panel=connector-bindings` 别名，app-center 12 条）。
  一次性整跑会中途被打断（「Interrupted while running」，377 cancelled——是进程收到信号，不是用例红），故按 40 个文件一批分 11 批跑，每批落盘日志后汇总，结果同上。
  顺带清掉全量里的既有红灯（都独立于本 change 的绑定逻辑，留着会让「谁弄红的」永远说不清）：
  - `test-studio-draft-gateway` ×4 / `test-studio-ai-drafting` ×1：add-supply-studio-migration 4.6 已把起草桥从壹座 `server.js` 摘到 facet 宿主，用例仍在断言旧挂载点。改为直挂模块验证行为契约（401/400/503、绝不凭空造草稿），并把 hermetic 环境钉在 import 之前（`llm-providers.js` 在模块加载时冻结 `STORE_PATH`，不钉就会解到 checkout 里的真实模型路由）；第 4 条改为断言「契约搬走了、没消失」。
  - `test-app-center` / `test-copilot-presets`：`lex` 已拿到自己的看板（add-lex-line-board）而成 `live`，旧的「早鸟徽章」「未知线路」用例因此失真。app-center 改为断言 lex 与 wire 同规则；copilot 的未知线路改用真正不存在的 id。
  - `test-wire-tool-risk` / `test-official-packs-lint`：刷新 wire 工具快照时把源里两个 `read` 工具也镜像进了 `WIRE_TOOL_RISK`，而门禁判定原是 `hasOwn(WIRE_TOOL_RISK, tool)` —— 这会让**声明只读工具的 pack 被判成带受闸写工具**（`gatedWriteTools()`、官方 pack lint、copilot 预设解析三处都吃这个集合）。**这是本 change 顺手修掉的真缺陷**：快照保持对源 `tool_risk` 的忠实镜像（20 条，lookup 仍可查 read），门禁集合与 `isWireWriteTool()` 改为按 `risk !== "read"` 派生（18 条受闸 = 16 write + 1 cost + 新的 `wire_self_action_propose`），两处硬编码计数对齐为 18 并加「read 永不进闸」的钉子断言。
  - `test-connections-binding-projection`：6.2 的动作渲染需要 `granted`/`grantedAt` 进投影（「去授权」/「撤销授权」+「授权于 …」），6.1 的负例原先把 `grantedAt` 一并禁掉，属过严。改为断言真凭据件（令牌 / PAT id / 未授权连接 id）不外泄，并钉住投影的字段白名单与 `granted` 的布尔型、`grantedAt` 的展示语义。
  - `test-plaza-browser`：这不是单测，是打真实广场的 playwright 验收脚本（断言 2026-11-05 那天的计数 75/197/13），但文件名匹配单测 glob，于是每次线上目录增长都让整条单测线变红。`docs/registry-maintenance.md §9` 本就写明它「不入 unit 冒烟」——脚本现在按文档意图执行：在 `node --test` 下（`NODE_TEST_CONTEXT` 有值）报一句原因后干净退出，按路径直跑仍是完整验收。
- [x] 7.4 `openspec validate add-connector-bindings --strict` 通过；核对与对侧 `scoped-pat-grants` 的接口一致（铸造入参、自省面字段名）并记录在 tasks 完成说明中。
  校验：`openspec validate add-connector-bindings --strict` → valid；对侧 `open-connector-mt` 的 `openspec validate scoped-pat-grants --strict` → valid，26/26 任务已勾（Changes 结束后两端可同期归档）。
  接口逐项核对（左=本仓 `connector-grants.js` / `connector-bindings.js`，右=open-connector-mt 源码）：
  - 铸造：`POST /api/tenant/pats`，入参 `{name, purpose, allowedOperations:[{provider, operationType}]}` ↔ `tenant-routes.ts:435` 的 `readTokenPolicy` → `api/policy-input.ts:readAllowedOperations`（provider 非空且不含空格/通配符、`operationType ∈ {read,write,destructive}`、上限 128 条、重复 `provider@operationType` 去重）；返回 `{token, id, name}` ↔ 本仓读 `body.token` / `body.id` / `body.name`。同名重铸对侧取并集并吊销被替换兄弟（`cascade:false`），正是本仓「授予只加不减、扩展即重铸」的前提。
  - 衰减派生：本仓以用户活跃账号令牌作父（无账号即 `no_account`、零出网），对侧 `principal.kind === "user_pat"` 分支要求 `purpose` 必填——本仓每次都带 `pack:<packId>/<key>`，命中该约束不发 `purpose_required`。
  - 范围口径差异（有意）：对侧闭集含 `destructive`，本仓 `GRANTABLE_OPERATIONS` 只有 `read`/`write`，且 manifest 校验拒收 `destructive`——写面授权只到 write，破坏性动作不进入绑定声明。
  - `GET /api/tenant/scope-explain?actionId=` → `{actionId, provider, operationType, allowed, code, checks}`（未知动作 404 `unknown_action`）↔ 本仓 `explainAction` 用它区分「范围没给」与「动作不存在」。
  - `GET /api/tenant/catalog-coverage?provider=&operations=read,write` → `{provider, operations:[{operation, covered, actionCount, executableActionCount}], gaps}`（未知 provider 404 `unknown_provider`）↔ 本仓 `createConnectorClient.coverage` 只认 `gaps`/`operations`，`gaps` 非空即 `unwired`。
  - `GET /api/tenant/connections` → `{connections: ConnectionSummary[]}`，行含 `id/service/connectionName/authType/configured/virtual/default/profile` ↔ 本仓 `connections()` 取 `service`/`connectionName`/`configured`/`virtual`（`virtual && configured` 判 satisfied 且标 `connectionVirtual`，平台代管不需要用户动手）。
  - 撤销：`DELETE /api/tenant/pats/:id` ↔ 本仓 `revokeBinding` 先用该绑定 PAT 自删（尽力而为，断网不阻塞），再删本地行。
- [x] 7.5 挂账登记：③（served agent 部署者主权）与 ④（桌面回环配对）作为后续 change，在本 change 的 proposal「Non-goals」已列，完成后在归档说明中重申。
  Non-goals 重申（归档时照抄）：**不做连接器侧改动**（铸造/求交/拒绝语义归对侧 `scoped-pat-grants`，本变更只消费）；**不做 served agent / 访客接入**（③：萬星 served agent 按部署者身份解析绑定是下一轮 change，前置是 `SERVICE_OBO` 从 `allow-all` 翻到 `consent`）；**不做桌面零粘贴**（④：桌面本地 origin 的零粘贴需回环配对方案，独立 change；本变更只保证绑定解析不依赖浏览器 origin）；不改 `fleet-packs/blueprints/schema.md`；不做按 provider 的目录策展 UI。
  本 change 自身留下的挂账（都不阻塞归档，逐条可独立开工）：
  1. **service/admin 连接器账号铸不出绑定令牌**（运营侧前置）：衰减派生只对 `user_pat` 开放，`service_pat` 调 `POST /api/tenant/pats` 得 403 `forbidden`。因此以「部署者身份」跑的场景（served agent、无人值守定时任务）现在授不了权。③ 必须与对侧一起把「以谁的身份铸」定清楚，不能在本仓绕。
  2. **绑定令牌的真机端到端尚未跑过**：全链（真连接器 → 真用户 PAT → 铸 → 注入 → 401 隔离 → 撤销）目前由两层假替身覆盖（`scripts/test-connector-binding-grants.mjs` 的 fake connector + e2e 直种库行），因为需要一个有 `user_pat` 的真人会话，且 ① 已上产、**② 尚未部署**。部署后应补一条真机冒烟：装带绑定的包 → 去授权 → 工具真调通 → 撤销后下一轮调用失败。
  3. **动作类绑定在状态面上没有动作徽章**：行上只渲染 `operations`（read/write）芯片，只声明 `allowActions` 的绑定因此看起来「无范围」。数据已在投影里（`operations: []` + `actions` 未透出），补一个动作芯片即可，纯展示层。
  4. **连接器控制台没有按 provider 的深链**：`/me`（`tenant-routes.ts:293` 的 SPA 落点）不接受 provider 参数，所以「去连接」只打开控制台首页，不直达该 provider 的连接卡。等对侧给出深链契约再改，不自行发明 query 参数。
  5. **全量单测的既有红灯已在本 change 内清完**（详见 7.3）：studio 起草原有 5 条断言旧挂载点、lex/unknown-line 2 条、wire 工具快照 2 条（其中 read 混入受闸集合是真缺陷）、投影负例 1 条、plaza 验收脚本误入单测线 1 类。现在 `npm run test:unit` 是 3784 条 0 失败，可以当作硬门用——**别再把「本来就是红的」当作可以接受的现状**：一条谁都不可信的门等于没有门。

> 1.x 落地记：校验写在 `lib/pack-manifest.js` 的 `validateConnectorBindings`（`pack-store.js` 入库即调 `validatePackManifest`，故校验位置只此一处）。用例 `scripts/test-connector-bindings-manifest.mjs` 15/15：合法声明 / 类简写 / 仅 `allowActions` / 仅人读字段被拒且错误指向缺范围 / 重复 key / 空 key+provider 分字段 / `destructive` 拒收 / 未声明 provider 拒收 / `alternativeProviders` 放行 / `optional` 非布尔 / `provider_status` 散文拒收 / 同 provider 双绑定并存 / 真实包 before 5 条缺范围、after 零错 / after 人读字段零改动。真实包已补机器字段（`fd-erp-vertical-templates/.../connector-pack/pack.json` 与 `fd-appliance` 副本逐字节一致）：金蝶 read+write、WMS read、微信支付 read（备选支付宝）、供应商门户 read+write（optional）、承运商门户 read（optional）；`provider_status` 散文移除。目录覆盖事实（连接器侧 `catalog/apps`）：`kingdee` 12 动作（read 3 / write 4 / destructive 5）、`wechatpay` 2 read、`alipay` 有、`wms`/`supplier-portal`/`carrier-portal` 无 → 后三条解析时如实报 `unwired`。

> 2.x 落地记：`db.js` v114 重建 `user_connector_credentials`（`kind`/`purpose`/`source_account`，主键 `(email, kind, slot)`）+ 新建 `connector_binding_ledger`（主键 `(email, pack_id, binding_key)`，`operations` 存 JSON 类数组，`granted_at` 用 COALESCE 保留首次授权时间）。账号类访问器全部加 `kind='account'` 过滤并显式写 kind；新增绑定行与台账访问器（`getConnectorBinding`/`listConnectorBindings`/`setConnectorBinding`/`deleteConnectorBinding`/`markConnectorBindingStale`、`upsertConnectorBindingLedgerRow`/`get…`/`list…`/`delete…`）。`backfillConnectorExploreBinding()` 在 `initDb` 每次启动跑，按活跃账号补 `slot='chat:explore'`（token 取账号现值 ⇒ 行为不变），存在即跳过。顺带修 `initDb` 二次打开时不清语句缓存的问题（`stmtCache.clear()`；旧句柄不关闭，保留 `getDb()` 直接断言的老用法）。用例 `scripts/test-connector-binding-store.mjs` 8/8：空库结构 / 两类行同表不互撞（同名 slot）/ 回填一次且二次为零 / 绑定行永不成为 `active` 账号 / 台账 upsert 保留 `granted_at` / **v25 存量库升级逐列等值**（token、pat_id、stale、active、updated_at 全等，两个活跃账号各得一条 explore 绑定，stale 非活跃账号不获授权）/ 账号投影由 `active` 重读且看不见绑定行、仅绑定身份 `liveToken` 为 null。既有 `scripts/test-connector-credentials.mjs` 24/24 回归通过（其中 5.1 迁移用例改为回滚 v25+v114 两个重建迁移——后续迁移假定全量库，不能从 25 重放）。

