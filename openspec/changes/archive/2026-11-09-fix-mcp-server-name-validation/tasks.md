# Tasks — fix-mcp-server-name-validation

## 1. 实证

- [x] 1.1 真机回合里岗位回答「没有 `mcp__connector__*` 工具」，而 home 内三件套（patch 行/凭据/插件包）齐全
- [x] 1.2 `dsh --dump-config` 证明 mcp 行确实组合进了 profile 树（不是没传 patch）
- [x] 1.3 `dsh` 启动日志给出 `ValidationError: invalid config`，指向 serverName
- [x] 1.4 把名字换成 `connector_qwly4_market` 后同一启动不再报错（0 条 ValidationError）
- [x] 1.5 读插件源码确认真实约束 `SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/`（0.2.0-rc.2）

## 2. 实施

- [x] 2.1 `bindingServerName(slot)` → `connector_<slug>_<hash8>`；新增 `isBindingServerName`、
      `slotForServerName(name, slots)`、`bindingSlotsForOwner(email)`
- [x] 2.2 `gateway/packs.js` 的 descriptor serverName 改用同一函数
- [x] 2.3 `server/dsh-events.js` 的 401 处理器改为按 owner 的 injectionRows 反查 slot
- [x] 2.4 `agent-runner/compose.js` 新增 `compliantServerName` 并在 `mcpEntry` 里收紧外来名字
- [x] 2.5 单测 `test-mcp-server-name.mjs` 4/4；`test-connector-binding-injection` 9/9、
      `test-connector-binding-entries` 5/5、其余绑定系全绿

## 3. 真机验收（2026-11-09，镜像 `sha-b3a68fc` / 基线 paas `e0bb7efd6`）

- [x] 3.1 重新部署后 descriptor 的 serverName 已是 `connector_qWlY4rrXowgN9_cf2888b4`，
      岗位 home 的 `mcp.patch.yml` 同步为该名
- [x] 3.2 真机回合：岗位答「当前确实有以 `mcp__connector__` 开头的工具（list_apps / search_actions /
      list_connections / get_action_guide / execute_action）」，并**真调用 `list_apps` 返回连接器里的真实数据**
- [x] 3.3 演练产物清零：注册处 DELETE 204、卸包、台账 deprecated、部署/密钥/包行归零、岗位 home 已删、
      连接器 `deploy:` 令牌 0 残留
