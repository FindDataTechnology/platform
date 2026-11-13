# Tasks: add-mcp-credential-hygiene

## 1. Relay 侧：作用域令牌（services/search-relay/index.js）

- [x] 1.1 keys.json 增 `scoped_master`/`revoked_scopes` 字段（env 备选 `RELAY_SCOPED_MASTER`，file wins）；空 tokens 且无 master 时维持拒绝裸奔启动（新增场景测试）
- [x] 1.2 实现 `wsrc-<scope-id>-<hmac>` 校验：静态列表优先 → 前缀解析 → HMAC 恒时比较 → denylist 查 scope；401 日志按 scope-id 归因（不记完整令牌）
- [x] 1.3 keys.json mtime 热重载（tokens/scoped_master/revoked_scopes 增删改即时生效，不再要求滚动 relay）
- [x] 1.4 relay 单测：派生通过/静态并存/HMAC 错值/denylist 拒绝+他 scope 不伤/无凭据材料拒启动/日志归因（新增与回归全覆盖）

## 2. Host 侧：派生注入 + 0600（dsh-profile.js / lib/persistence.js / lib/）

- [x] 2.1 `lib/` 新增派生函数 `deriveScopedToken(master, scopeId)`（与 relay 侧实现同步注释互指；两处一致性测试钉死）
- [x] 2.2 `toMcpClientEntry` stdio 分支：存在 `SEARCH_RELAY_SCOPED_MASTER` 时按 `SEARCH_RELAY_SCOPE_ID` 派生注入 `SEARCH_RELAY_TOKEN` 值；未设 master 维持共享值 + 一次性 warn（降级场景测试）
- [x] 2.3 `writeViaTemp`/`atomicWriteTextSync` 加 mode 参数（默认 0600，需要 0644 的调用者显式传）；全部现有调用点审计一遍
- [x] 2.4 单测：patch 落盘 mode=0600（新写与重写旧 0644 两条）；envRefs 派生注入值进 patch

## 3. Preflight 观测（dsh-profile.js / extension store / server 路由）

- [x] 3.1 writeMcpPatch 尾部异步探活：对每个 http server 用同 URL+解析后凭据发 initialize，立即带 session 终止（防会话泄漏——daas-mcp 503 前科）；结果归类 ok/unreachable/auth-rejected/server-error/unknown
- [x] 3.2 结果落 store（server→{state, checkedAt, detail}），探活失败绝不阻断 patch 写出（测试钉死）
- [x] 3.3 只读端点 `/api/diagnostics/mcp`（auth 同其他 /api 路由），返回各 server 态与时间戳
- [x] 3.4 单测：401→auth-rejected、5xx/超时→server-error/unreachable、探活自身异常→unknown、store 写入形状

## 4. 上线与验收

- [x] 4.1 relay 出片+滚动（keys.json 现场加 scoped_master，静态 fb0afc 保留）；cheap1 本地探针双通道实证（静态过 + 派生过 + denylist 拒）——已上线 scoped=on（GitOps 双文件 ConfigMap+目录挂载 keys）；双通道探针 503/401 判别实证；**热撤销生产实证**（改 secret revoked_scopes → kubelet 同步 → 无重启 401 reason=revoked，静态通道无伤）
- [x] 4.2 platform 滚动（env 加 SEARCH_RELAY_SCOPED_MASTER + SEARCH_RELAY_SCOPE_ID）；验证新写 cell patch 的 SEARCH_RELAY_TOKEN 为 wsrc- 派生值、文件 mode 0600 ——**完成**：镜像 sha-6827f35 + master env 双 pod 实证；演示 cell patch 实测 `mode=600` + `wsrc-cell-3fdc7b8e8ac0-fab9f727…`（cell 重启自动重生，其余 cell 待各自下次组合自然迁移）；共享值 fb0afc 不在任何 patch
- [x] 4.3 端到端：装包 → websearch 实调走派生令牌 200；诊断端点各 server 态可见；演示 cell cat patch 仅见本 cell 作用域值 ——**完成**（西安节点恢复后）：`/api/diagnostics/mcp` 经 gateway HTTP 200 返三态（fd-cn-report/fd-daas-mcp `ok` + fd-find-data-business-mcp `auth-rejected 403` 真实暴露，正是本 change 要消灭的三无声）；relay 归因日志 `503 token=wsrc:cell-3fdc7b8e8ac0`（派生令牌过鉴权，503=serpapi 池干涸既有状态）；旧泄露令牌 b99fef 实测 401（死透）
- [x] 4.4 归档前 `openspec validate --specs` 全绿（133 passed）+ 把"dsh 侧凭据代理（headers ref 化）"记为长期方向备注（design.md Non-Goals 已载）
