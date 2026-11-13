# Tasks — add-deployment-binding-grant

## 1. 提案（本次已做）

- [x] 1.1 查实铸造链只认用户账号（`connector-grants.js` 的 `liveToken(email)` + 连接器侧 403）
- [x] 1.2 查实可复用的地基：`deployment_secrets`（值留平台侧、只下发引用、带 `deployer` 列）
      ／ `descriptor.mcpServers = roleMcp(manifest, agent)`／ runner 只接收 `secret_refs`
- [x] 1.3 立项本 change，写 proposal + spec delta，`openspec validate --strict`

## 2. 实施（待批）

- [x] 2.1 新模块 `deployment-bindings.js`：`mintableBindings`（只取 satisfied 且非 optional）、
      `deploymentBindingSecretName`（折成 `[a-z0-9_]{1,32}`，前缀 `connector_binding_`）、
      `mintDeploymentBinding` / `mintDeploymentBindings`（用**部署者**账号调 `mintBindingToken`；失败只登记不上抛）
- [x] 2.2 部署路径接线 `gateway/packs.js` 的 deployHandler：部署成功后对每个已部署 agent 铸绑定，
      经 `registry.recordDeploymentSecret` 落库（`name = connector_binding_<key>`，`deployer = 部署者`）；
      响应只回 `deploymentBindings.{granted,failed}` 的**名字与键**，令牌值永不进响应
- [x] 2.3 撤销/卸载：重新部署时删掉不再需要的部署密钥并**吊销**连接器令牌（`pruneDeploymentBindings`：
      在 `deploy:<pack>:<agent>:<binding>` 命名空间内列表比对保留下限，只吊销本命名空间令牌，人手授权的
      `pack:` 令牌不可达）；卸载只在「本单元已无该包部署」时全量收口（`revokeDeploymentBindingsForPack`），
      否则保留——卸载不等于下线，撤销在跑的凭证是静默停服
- [x] 2.4 单测 `scripts/test-deployment-bindings.mjs` 9/9：四态判定表（satisfied+非optional 唯一可铸）、
      密钥名合法性（含冒号/超长/空键）、一次铸一枚并存值/记部署者、铸造失败只登记不上抛且不落库、
      无父凭证时**连连接器都不调用**（`no_account` 反证）；另加：两 agent 不共用 PAT 名（同名重铸会吊销
      前一枚）、prune 只吊销本命名空间且不删非绑定密钥、无账号时仍删行并报 `no_account`、卸载全量收口不越界
- [x] 2.5 全量单测：逐文件跑（454 文件、6 并发、90s 上限）——当前 `tests=3983 fail=6 cancelled=11`，
      同协议在基线 `351e74186` 上 `tests=3979 fail=7 cancelled=11`。差异只有三处并行抖动
      （`test-cell-containment`/`test-queue-health` 基线红当前绿、`test-fleet-orchestration` 当前红），
      三者单独重跑均全绿。**无新增红**；新增 4 条用例。
      注意：`node --test` 串行整跑会被第一个挂死文件卡住不动（`test-deploy-*`/`test-agent-serving`/
      `test-opening-gates`/`test-platform-billing`/`test-deployment-secrets` 6 个文件在基线上同样挂，
      属既有问题），必须加 `--test-force-exit` 并按文件跑才拿得到全量结论

## 3. runner 侧接线（待批，单独验收）

- [x] 3.1 served agent 的 profile 写出 `connector:<packId>:<bindingKey>` 行：descriptor 增 `connector_bindings`
      （`serverName`/`url`/`secretName`），runner 的 `connectorBindingEntries()` 用它 + 已取到的密钥值组装 mcp 行；
      密钥名同时并入 `descriptor.secret_refs`（runner 只按那张表取值，否则永远取不到）
- [x] 3.2 值只经既有内部路由取用：runner 先按 `secret_refs` 取全部值（提前到 mcp 组装之前），
      再 pin 进 `.credentials.yaml`；注册表只承载 `secretName`，令牌不落注册表。
      **注**：mcp 行的 Authorization 仍是组装期写入（与既有 `config.mcpToken` 同一姿态）
- [~] 3.3 端到端：真机部署一个声明绑定的包为常驻岗位，工具调用打通；撤销后下一轮失败
      ——**模块级已证、真机未跑**。已做：`scripts/test-deployment-binding-descriptor.mjs` 4/4，
      走真实 `composeDescriptor` + mint/prune，钉死「令牌进了 runner 唯一会取值的 `secret_refs`」
      （漏这一步=授权可见但取不到值）、重部署撤销会真吊销连接器令牌、prune 摸不到人手授权的 `pack:` 令牌、
      铸造失败不误撤。真机未跑的两个前提在当前 prod 都不成立：
      ①`/data/data/packs.db` 的 11 个版本里**没有任何包声明 `connector_bindings`**，48 个 cell 的
      `deployment_secrets` 里也**没有一条** `connector_binding_*`（全量扫过）——没有可部署的载体；
      ②fd-prod 的 platform pod `CLOUD_MODE` 为空，网关头身份不被信任，而平台侧无管理员令牌，
      部署必须用真 OIDC 会话（需本人登录）。
      另：HTTP 形态的部署路由在本仓测试台会挂（`test-deployment-secrets.mjs` 在基线上同样挂，
      响应不落地），新增 HTTP 用例只会继承坏台子，故改用模块级。
      镜像侧已就位：platform/facet/demo 与 `agent-runner-b/c/serving` 全部滚到 `sha-60ecab1`
      （基线 `c7181350c`），pod 内逐条 grep 到本改动四个符号
- [x] 3.4 边界记录：ACP harness 路径（`#spawnAcpChild` → `acpMcpServers`）只认 `descriptor.mcpServers`
      且统一用平台 token，**吃不到部署绑定**；本改动只覆盖 dsh 路径（`materializeAgentHome`）。
      ACP 若要支持，需把 `connector_bindings` 按同样规则映射成 ACP 的 http 行（另一个改动）

## 4. 明确不做

- [ ] 4.1 不放宽 `service_pat` 铸 PAT（须连接器侧共同评审“服务身份代表谁”）
- [ ] 4.2 不做运行期自动续铸（令牌寿命与续期属 ③）
