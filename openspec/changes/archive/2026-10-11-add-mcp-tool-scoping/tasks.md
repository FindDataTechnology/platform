# Tasks: add-mcp-tool-scoping

## 1. 声明层（manifest 校验器）

- [x] 1.1 `lib/pack-manifest.js`：`mcpServers[].allowTools`（叶名 `[A-Za-z0-9._-]{1,128}`、≤64、去重）+ `PACK_LIMITS.maxToolsPerMcp`，验证 `node --test` 校验器套件含新键正反例全绿
- [x] 1.2 `agents[].resources.mcpTools` 维度（键 ∈ 本 pack mcpServers 名、值 ⊆ 该引用 allowList/目录工具面、只收窄不放宽、维度独立），验证新增单测覆盖放宽拒绝/外名拒绝/缺省继承三态

## 2. 组装层（deriveScope + patch 物化）

- [x] 2.1 `dsh-profile.js` `deriveScope`：从 installed-pack 快照 + persona 声明推导 `scope.mcpTools: {server: Set(leaf)}`（pack 级 ∩ role 级），验证既有 deriveScope 单测扩展：未声明=无映射（全量）、声明三态、焦点裁掉 server 时映射随行失效
- [x] 2.2 `writeToolFilterPatch`：scope.mcpTools 物化为桥配置（原子写、空映射跳过 patch），验证单测：配置文件形状、空映射返回 null、persona 切换重写

## 3. 执行层桥（platform-mcp-tool-filter）

- [x] 3.1 桥骨架进 `dsh-profile-template/`：读配置、`setup` 时 `agentCtx.tools.guard()` 按 `mcp__<server>__<leaf>` 前缀+名单拒绝（理由文案含工具名+聚焦范围+切换建议；对齐既有 guard 文案双语先例），验证 mock `ctx.tools` 单测：越权拒绝、名单内放行、无映射 server 全放行、永不 throw
- [x] 3.2 restrict 尽力收窄：监听工具注册表事件，任一映射 server 工具已注册后算 `deny = 已注册叶名 − allowlist` 施加 `restrict({deny})`，throw 捕获降级留 guard、事件重试，验证单测：漂移（快照多/少名）不炸、deny 计算正确、降级路径可达

## 4. 安装层（本地绑定）

- [x] 4.1 `pack-store.js` `installMcpRef`：registry 未命中 → 本地 `getMcpServer` 命中即 `bound`（记录进 installed-pack 态，不写 extension_configs、不盖本地配置、免组门/凭据检查），未命中即 `awaiting-local-binding`（非失败），验证单测：三态报告、其余部件不受阻、allowlist 随行进记录
- [x] 4.2 后装激活：`awaiting-local-binding` 引用在用户装/连同名 server 后经 focus 组合自然生效（compose-time 相交），验证单测：装后一次 writeMcpPatch/toolFilterPatch 组合即含该 server 映射，无需重装 pack

## 5. 发布校验（facet 端）

- [x] 5.1 存在性门：publish 流程对每个带 allowTools 的 registry 引用对拍 catalog `tool_list`，缺失名发单次有界实时探测（initialize+tools/list，~5s 超时），两者皆无即 fail，验证单测（mock registry）：未知 fail / 快照滞后探测放行 / 探测超时 fail
- [x] 5.2 surface 闭合门：条目带 surface meta 时声明 ⊆ commercial 集 else fail（与探测无关），本地（非 registry）引用免两道门，验证单测：越 commercial fail、internal 工具存在仍拒、本地引用跳过
- [x] 5.3 `registry-bridge.js` `mapServer` 携带 `tool_list`（+ surface commercial 集若在），验证：市场 catalog 条目可见工具名单（对拍 registry `/api/servers` 实际形状，落 Open Question 1 答案）

## 6. 编辑器与报告（web）

- [x] 6.1 pack 编辑器 MCP 条目工具选择器：从 catalog `tool_list` 渲染多选、拒绝自由输入、显示收窄后计数，验证 e2e：选 3 工具保存重开仍在
- [x] 6.2 安装报告渲染 `bound` / `awaiting-local-binding` 两态（含激活指引文案），验证 e2e：本地行先在 → bound；无 → awaiting 提示可见

## 7. e2e 验收（CI fast 车道）

- [x] 7.1 聚焦收窄：装带 allowTools 的 pack → 选 persona → 会话 `tool_search` 断言该 server roster 恰为声明叶名；直接调未声明工具被拒且理由可读，验证 e2e 双断言过
- [x] 7.2 兼容回归：存量 pack（无 allowTools）全量 roster 不变 + 全模式（切回内置 agent）全量不变，验证 e2e
- [x] 7.3 漂移降级：单测级已覆盖 restrict 降级；e2e 补 server 加工具后新工具对角色不可调（guard 兜底），验证 e2e 过

## 8. 收尾

- [x] 8.1 上游 issue 文案（`allowedTools: string[]` 叶名、filter-at-registration、重连重放语义、与 `failOnStartupError` 正交）落 `docs/` 附录供递交，验证文案含动机（N×161 工具上下文经济）与语义边界
- [x] 8.2 finddata 侧 `mcp-surface-contract` 消费侧 delta 对拍一致（commercial 闭合规则两仓措辞同源），验证独立 change 落地且与本设计 D5 一致
