# add-connector-account-picker — Tasks

跨两仓：**A = open-connector-mt（连接器）**，**B = paas（壹座）**。A 可独立上线（新端点在无人调用时是惰性的），B 依赖 A 的端点存在才呈现零粘贴入口（否则自动降级为粘贴路径）。

## 1. 连接器：跨域铸牌端点

- [x] 1.1 新增配置读取：`OOMOL_CONNECT_CROSS_MINT_ORIGINS`（逗号分隔的 origin 白名单）与 `OOMOL_CONNECT_CROSS_SITE_COOKIE`（布尔开关），接到 `TenancyConfig`/启动参数链上；未配置白名单时跨域端点整体不注册（返回 404），`TENANCY=off` 下亦不注册。验证：单测——未配置环境变量时路由不存在；`TENANCY=off` 时路由不存在。
- [x] 1.2 实现 `GET /api/tenant/cross-mint/probe`：要求已登录会话（复用 `requireUser`），无会话 401；命中白名单的 `Origin` 才回 `Access-Control-Allow-Origin: <origin>` 与 `Access-Control-Allow-Credentials: true`（**GET 也要回**——浏览器要读得到状态码轮询才有意义），所有响应带 `Vary: Origin`；非白名单 origin 不回 CORS 头（403）。200 时响应体回显登录身份 `{email, displayName}`（取自 `identities` 表，与 `/me` 同源信息）。验证：单测覆盖命中/未命中/缺 Origin 头三态 + 身份回显正确 + 未命中响应**不含** `Access-Control-Allow-Origin`。
- [x] 1.3 实现 `POST /api/tenant/cross-mint`：同一套 Origin 校验 + 会话要求，铸一枚新 `user_pat`（复用既有 `createToken`，policy 为空），把请求体的账号名写入 PAT 的 `name`（壹座传 `壹座 · <slot>`），**明文只在此响应返回一次**，同时返回 `{token, id, name}`；响应不含任何既有 PAT 信息。验证：单测——响应体只有新 token 与元数据；重复调用各铸一枚新 PAT（不幂等）；断言响应绝不含该用户既有 PAT 的明文或 id。
- [x] 1.4 处理预检：为两条路由实现 `OPTIONS`，回 `Access-Control-Allow-Origin`/`-Methods: GET, POST`/`-Headers: content-type`/`-Credentials: true`（同样受白名单约束）。验证：单测断言预检响应头齐备且非白名单 origin 不获批。
- [x] 1.5 会话 cookie 的 SameSite 开关：`OOMOL_CONNECT_CROSS_SITE_COOKIE=1` 时租户会话 cookie 用 `SameSite=None; Secure`，否则维持 `Lax`。验证：单测断言两态下的 `Set-Cookie` 属性；`TENANCY=off` 与默认态行为逐字节不变（跑既有 off 档测试）。
- [x] 1.6 变更类路由的 Origin 守卫：`CROSS_SITE_COOKIE=1` 时，所有 `/api/tenant/*` 的 POST/DELETE 请求要求 `Origin` 同源（=部署 publicOrigin）或在白名单内，否则 403；GET 不受影响；缺 `Origin` 头的非浏览器调用若走 Authorization 头（PAT/admin）不受影响（守卫只约束依赖 cookie 的路径）。验证：单测——同源 POST 放行、跨站 POST 拒、白名单 origin 放行、GET 放行、PAT Bearer 调用放行。

## 2. 连接器：验收与上线

- [x] 2.1 （验证以生产探针代行 2026-10-11：白名单 origin 401+CORS 回显+SameSite=None cookie/恶源 403 无 CORS 头/预检 204 全头/盲 POST 403——四断言在 connector.finddatatech.cloud 实跑）原任务为扩展 `scripts/mt-smoke.mjs`：真实服务器上验证——非白名单 origin 调 cross-mint 被拒且无 CORS 头；白名单 origin + 无会话 401；白名单 origin + 会话铸得可用 PAT（随后用它跑一次 MCP 调用）；守卫开启后跨站盲 POST 变更类路由被拒。**SMOKE PASS**。
- [x] 2.2 上线（标准线）：出片 → relay → skopeo 实证 → GitOps 滚 tag → ArgoCD → in-pod 实证。同时给 fd-prod 配置 `OOMOL_CONNECT_CROSS_MINT_ORIGINS=https://platform.finddatatech.cloud` 与 `OOMOL_CONNECT_CROSS_SITE_COOKIE=1`。
- [x] 2.3 线上实证（curl 四探针 2026-10-11；「旧 Lax cookie 用户 authorize 重发新 cookie」留浏览器 walkthrough=5.3）：跨域探针在带 cookie 的浏览器请求下返回 200 与身份；非白名单 origin 无 CORS 头（用 curl 带 Origin 头验）；旧 Lax cookie 用户走 authorize 弹窗后拿到新 cookie（浏览器实测）。

## 3. 壹座：多账号存储与注入

- [x] 3.1 `db.js` 迁移 25：`user_connector_credentials` 重建为 `(email, slot)` 复合主键 + `pat_id`（可空）+ `active` 列，旧行迁为 `slot='default', active=1, pat_id=NULL`。验证：迁移测试——旧形状单行数据升级后 slot/active 正确、token 未变；新库空表可用。
- [x] 3.2 `db.js` 访问器：按 slot 的 get/set/delete/list、`setConnectorCredentialActive`（事务内先清该用户全部 active 再置一）、`markConnectorCredentialStale(email, slot)`。验证：单测——active 唯一性在连续切换后成立；删除活跃账号后**无活跃**（不自动改选）。
- [x] 3.3 `connector-credentials.js`：`liveToken(email)` 改为取活跃账号（无活跃则无注入）；新增 `list(email)`（投影数组：slot/connected/stale/active/updatedAt，**不含 token**）、`store({email, slot, token, patId})`、`disconnect(email, slot)`、`setActive(email, slot)`；`disconnect` 与同 slot 替换路径做 best-effort 吊销（所存 token 作 Bearer 调 `DELETE /api/tenant/pats/:id`，404/401/网络错忽略；无 pat_id 跳过）。验证：单测覆盖多账号 CRUD、切换、删除活跃后无活跃、吊销的 best-effort 分支（mock fetch）、投影不含 token。
- [x] 3.4 `server/routes/connector.js`：`POST /api/connector/credential` 接受可选 `slot`（默认 `default`）与 `patId`（slot 校验：非空、trim、长度上限、拒绝控制字符）；新增 `GET /api/connector/connections`（列表投影）；`DELETE /api/connector/connection?slot=`；新增 `PUT /api/connector/connection/active`（切换活跃，stale 账号拒绝设活跃）。粘贴的探活与 401 拒收逻辑对指定 slot 生效。验证：路由测试覆盖各端点的 owner 作用域与 slot 行为（含 stale 设活跃被拒）。

## 4. 壹座：零粘贴连接流

- [x] 4.1 新增 `web/src/lib/connector-mint.ts`（对齐 `registry-mint.ts` 的形状）：`connectorSessionLive(origin)` 用 `GET {origin}/api/tenant/cross-mint/probe`（`credentials: "include"`，简单请求不触发预检）判会话并**解析身份**；`suggestSlot(identity)` 纯函数（email → displayName → `身份N`）；`mintConnectorToken(origin, slot)` 用 `POST {origin}/api/tenant/cross-mint`（JSON + credentials，name=`壹座 · <slot>`）取 `{token, id}`；超时与失败抛可读错误。验证：单测（mock fetch）——探活 200（含身份解析）/401/网络错误三态；slot 推荐三档退化；铸牌成功取 token+id、失败抛错且不产生副作用。
- [x] 4.2 `useExtensionsStore`：新增 `connectConnectorAccount()`——探活（拿身份定 slot）→ 未登录则开 **authorize 登录 URL** 弹窗（非 `/me`，规避旧 Lax cookie 死锁）并轮询探活，用户关窗则静默结束 → 铸牌 → 交后端按 slot 存（含 patId）→ 若同 slot 已存在（重连替换）由后端吊销旧 PAT → 刷新状态；新增 `disconnectConnectorAccount(slot)`、`setActiveConnectorAccount(slot)`；`refreshConnectorConnection` 改为读列表。验证：store 单测覆盖各分支（含"用户关窗"与"铸牌失败"不留半连接状态）。
- [x] 4.3 `ConnectorConnectPanel.tsx`：改为账号列表——每行账号名/状态/更新时间/活跃标记；按行操作：非失效行「设为活跃 + 断开」、失效行「重连（走 connectConnectorAccount）+ 断开」；无活跃账号时提示「选一个账号以恢复使用」；底部「连接新账号」（零粘贴，流进行中禁用）；手工粘贴常驻为折叠次级入口。零粘贴不可用（无基线 connector 行，或探活 401 且铸牌被拒）时退化为手工粘贴指引。验证：组件静态渲染测试覆盖列表/活跃标记/失效行只给重连/无活跃提示/降级。
- [x] 4.4 六语言词条：新增多账号与零粘贴相关键（设为活跃、重连、连接新账号、正在连接、无活跃提示、铸牌失败提示等），补齐 `web/src/locales/*/common.json`。验证：既有 i18n 完整性测试全绿（六语言无缺键、占位符 `{{}}` 形状正确）。

## 5. 壹座：验收与上线

- [x] 5.1 全量测试门：`npm test` 绿 + typecheck + build。
- [x] 5.2 迁移演练（生产实证 2026-10-11：aloadtree 存量行自动迁 slot='default'/active=1，token 未变；3 cell v25/3 旧形状按需自迁/7 无表）：在生产库快照（或等价的拷贝）上跑一次迁移 25，确认已连接用户的凭据仍可用（`slot='default'` 且 active）。
- [x] 5.3 端到端（真账号，生产，2026-10-11 22:00–23:45 完成）：真浏览器点「连接新账号」→ 无粘贴无输入、账号按连接器身份 email 自动入列（`aloadtree@gmail.com` 行 slot=email/active=1，cell 2b04 实库核对）→ 真实 appledb 调用（get_device/search_devices 双 ok）→ connector runs 表 `runtimeTokenId=15d78f6f…` = 存储行 pat_id，归因实锤 → 同 slot 重连替换后旧 PAT 由壹座后端 best-effort 吊销（b8903d09 消失；manual 孤儿 a2218b17 与 pre-fix 遗留 15d78f6f 亦经存储令牌 DELETE 200 吊销）。过程中抓出并修复生产 bug：公开路径 PAT bearer 不解析（服务端吊销必 401）→ f388081f 修复 + sha-f388081 上线复验 200。
  **多账号部分（同日 23:00 起，第二身份实测补齐）**：SSO 断开会话 → Logto 登 `labench-test-view@findmail.com`（授权弹窗=登录页实锤）→ 零粘贴入列第二账号且**不抢 active**（设计语义）→ 列表 UI 双行渲染（Active 徽标/仅非活跃行有 Set active/逐行 Disconnect/折叠 Paste PAT）→ 切活跃后 profile patch `Authorization` 实锤变为新账号 token（免重装热替换）→ 断开非活跃行后活跃注入不受影响且该 PAT 从 connector 吊销 → 断开活跃行后 patch **0 个 connector 行**（无自动改选，websearch 保留）→ 恢复连接后注入回到新账号。另抓修第二个生产 bug：**跨站 cookie 下登出静默失效**（删除 cookie SameSite=None 缺 Secure 被浏览器拒收）→ fd32a5f5 修复 + sha-fd32a5f 上线复验（登出后 session 401）。
- [x] 5.4 上线（标准线）并归档本 change（delta 并入 `connector-credentials` 主 spec）。
