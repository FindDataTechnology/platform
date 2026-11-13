## 1. 存储与迁移

- [x] 1.1 在 `db.js` 迁移序列新增 `user_connector_credentials` 表（email/owner key + token + updated_at），跑既有迁移测试确认新版本号与双方言一致（本地 `node --test` 或 e2e 起服即迁移通过）——迁移 v23；探针起真服实证 23 条迁移全过
- [x] 1.2 新增 `connector-credentials.js`：`status/liveToken/store/disconnect/markInvalid/ownerKey` 与 `registry-credentials.js` 同形（复用 `ownerKey`、写只读投影、`stale` 标记随 store 覆盖清除；无 expiresAt 语义），写单测覆盖 store→status→disconnect 往返、401 翻面→重粘恢复、auth off 的 machine-owner 退化——`scripts/test-connector-credentials.mjs` 18 用例

## 2. credentialRef 分派

- [x] 2.1 新增 ref 注册表（`credential-refs.js`）：`isRef(config)`、`liveToken(refName, email)`、`knownRef(name)`；`registry-credentials` 作为第一个注册项转发（导出面不变），写单测断言 registry 解析结果与注册前逐字节一致——转发断言 + 既有 `test-registry-credentials.mjs` 17 用例零回归
- [x] 2.2 `connector-credentials` 注册为 `"connector"` ref；单测断言两个 ref 互不串扰（只配 registry 时 connector 不解析，反之亦然）
- [x] 2.3 改写 `dsh-profile.js` 的 `writeMcpPatch` 解析循环为按 `credentialRef` 查表分派，保留"解析失败即省略全部 ref 行 + warning"的兜底；跑既有 e2e（`registry-connect.spec.js`、`resources-binding.spec.js`、`packs.spec.js`）确认 registry 行为零回归——单测层全绿；e2e 交 GitHub CI（用户既定偏好）
- [x] 2.4 泛化 `server/routes/overlay.js` 的 `availableMcpNames`：带 `credentialRef` 的行（mcp.json 与 DB 一致）按 ref 注册表对当前身份的凭据存活过滤；单测覆盖"未连接用户可加宇宙无 connector、已连接有"
- [x] 2.5 泛化 `server/dsh-events.js` 的 401→失效链路：按 ref 注册表分派 `markInvalid`，并补 mcp.json 行查表盲区（现只查 DB 行）；沿用"false ⇒ 已失效不重复重应用"幂等，广播事件按 ref 命名；单测覆盖 connector 行 401 翻面恰一次重应用、registry 行为不变

## 3. 服务行与注入验证

- [x] 3.1 `mcp.json` 新增 connector 服务行（`url: https://connector.finddatatech.cloud/mcp`、`credentialRef: "connector"`、服务名 `connector`），确认与既有服务名无冲突
- [x] 3.2 端到端：无凭据用户的有效 profile 不含 connector 服务且有 warning；写入凭据后同一用户 profile 含该服务且头为 `Bearer <PAT>`；断开后再次消失（e2e 或探针脚本，记录输出）——`scripts/probe-connector-credentials.mjs` 全过（起真 server.js；B 步走进程内 writer 兜底，本机 dsh 树缺 cordis-plugin-loader 起不来，注释在册）
- [x] 3.3 真回合验证：给一个测试用户粘贴真实 PAT，dsh 会话出现 `mcp__connector__*` 工具并能 `list_connections` 返回该用户在 connector 里的连接（记录工具名与返回摘要）；随后在 connector 侧撤销该 PAT，再触发工具调用，实证 401 文案命中失效正则、卡片翻「已失效」、服务从有效 profile 省略且恰一次重应用——**需真实 PAT 与可起 dsh 的环境（staging/fd-prod），本地 dsh 树损坏，留部署阶段**

## 4. API 与面板

- [x] 4.1 新增凭据路由（镜像 registry 形：`GET/DELETE /api/connector/connection` + `POST /api/connector/credential`），hosted 模式拒绝匿名（401）、auth off 落 machine-owner；粘贴双重校验——非 `oct_` 前缀 400；对 `mcp.json` connector 行的 url 发一次 MCP initialize 探活，401 拒收（400）、网络错/5xx 照存、行缺席跳过探活；写 API 测试覆盖三端点、探活三态与"响应不含 token"
- [x] 4.2 新增 `ConnectorConnectPanel` 并挂到 `McpServerForm` / `McpMarketView`（与 `RegistryConnectPanel` 同挂载点）：未连接给粘贴+获取指引，已连接给状态+断开，已失效给「已失效，请重新粘贴」
- [x] 4.3 i18n 键补齐（实为五语言：en/zh-CN/es/fr/ja，SUPPORTED_LOCALES 即此五者），中文文案说明 PAT 从 connector「我的连接」页面获取；含失效态文案与凭据失效广播事件的刷新（`check-locales` 五语言 935 键一致）
- [x] 4.4 `extensions.js` 准入收紧：POST/PUT `/api/extensions/mcp` 收到的 config 携带 `credentialRef` 一律 400「credentialRef 由系统管理」（registry-origin 由服务端自行盖标的路径不受影响）；API 测试覆盖拒收与目录安装打标共存

## 5. 收尾

- [x] 5.1 凭据变更后触发 profile 热更新（复用 `reapplyProfile` 形状），e2e 断言粘贴后无需重装即生效——路由内置 reapply（单测断言 dshUpdateMcpCalls 逐次触发）；热更新 e2e 交 CI
- [x] 5.2 更新 `openspec/specs/registry-credentials` 的 Purpose 中"单一 ref"表述为分派模型（若其文字与新实现冲突）——核对结论：该 spec 无"单一 ref"表述，各 requirement（含 401→stale）在泛化后仍准确，无需改动
- [x] 5.3 全量本地门：lint + format + typecheck + 单测 + 相关 e2e 全绿；记录命令与结果——lint（biome，全部触碰文件）绿；`npm run typecheck` 绿；`check-locales` 五语言 935 键一致；`npm run web:build` 绿；单测 920/924 过，4 个失败 + 排除的 cell-isolation/session-resume 均经纯净 HEAD 克隆复证为**本机预存环境问题**（本机 dsh 树损坏：全局 dsh preset 挂载失败 + profile node_modules 缺 cordis-plugin-loader；CI 上为绿）；相关套件（connector 18/18、registry 17/17、focus-overlay、persona-scope、role-gated）全绿；探针 PROBE PASS。e2e 按 CI 偏好走流水线（registry-connect.spec 已随 D8 契约同步修订）
——**2026-10-09 生产实证（platform-demo sha-9a232ac，真 dsh 真回合）**：DB 插 connector 行 + 粘真实 PAT（browser 铸 oct_…，机器所有者键）→ 容器重启后 boot patch 首位即 connector（streamable-http + Bearer 注入）→ 真回合 agent 实际调用 `mcp__connector__list_connections` 返回 ok:true + 24 个服务 id（appledb…wttr_in，与 connector 侧用户连接一致）；connector 侧撤销 PAT → 工具调用 401（"Streamable HTTP error"）→ dsh-events 命中失效正则 → markInvalid → GET /api/connector/connection 翻 `connected:false, stale:true` → patch 重写省略 connector（grep=0）→ 二次 401 调用 updatedAt/patch mtime 均不变=**恰一次重应用**。
**发现（留档不阻塞）**：demo 部署（/opt/dsh-home 容器可写层、hmr 钉版 1.0.16）上 HMR 未把"新增 DB 行 MCP"送达运行中 child——temp+rename 与原 inode 追加两种写法均不触发，新服务经容器重启后的 boot patch 生效；文件级契约（有效 profile 省略/注入）不受影响，registry 的头刷新热路径有 e2e 覆盖，此现象归后续调查。demo /data 为 emptyDir（故意），粘贴凭据随 pod 重建消失。
