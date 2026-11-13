# Tasks — fix-mandate-verdict-client-injection

> 代码已落地（本分支 `a5ca95d9b`；release 线对应 `6b77b1114`，现为远端 tip `82934f7a` 的祖先）。
> 本 change 的增量是**把口径写进规格**与**补决定记录**，代码任务列在此处备溯源。

## 1. 配置解析

- [x] 1.1 `agent-runner/config.js` 解析 `MANDATE_VERDICT_URL`（去尾斜杠）与 `MANDATE_VERDICT_TOKEN`（`config.js:277-278`）
- [x] 1.2 任一为空时保持空串，`index.js` 侧据此判定「缺一即不注入」

## 2. 通道组装与注入

- [x] 2.1 `agent-runner/index.js:114-146` 组装 `mandateVerdictClient`：两个 env 齐才建，否则 `null`
- [x] 2.2 客户端 5s 超时（`AbortController`），超时落同一条失败分支
- [x] 2.3 非 2xx 一律 `{ok:false, reason:"verdict_http_<status>"}`，不区分「哪些码算拒绝」
- [x] 2.4 响应形状非法（非对象 / 非 `j.ok === true`）一律不放行
- [x] 2.5 `mandateVerdictClient` 作为实参传入 `new ChildManager({...})`（`index.js:152`）

## 3. 验证

- [x] 3.1 `node --check` 两文件通过（`index.js` 为 ESM，复制为 `.mjs` 后 rc=0）
- [x] 3.2 四个 env 组合逐一断言注入结果：两个都缺 / 只有 URL / 只有 token ⇒ 不注入；两个都有 ⇒ 注入
- [x] 3.3 agent-runner 六个套件全绿（3+3+3+6+21+1 = 37 项）
- [x] 3.4 `scripts/test-outbound-gate.mjs` 8/8、`scripts/test-fleet-delegation.mjs` 26/26、`scripts/test-personal-auditor.mjs` 1/1
- [x] 3.5 biome 检查通过
- [x] 3.6 未配置分支证据：`manager.js:1188` 在 `typeof client !== "function"` 时返回 `no_verdict_client`；该行在补丁前即存在，补丁未改动它

## 4. 规格与决定记录

- [x] 4.1 `specs/principal-disclosure-accountability/spec.md` 补 ADDED requirement：通道不可用失败关闭 + 与「裁决拒绝」可分
- [x] 4.2 `design.md` D1 记「缺一即不注入」、D2 记「非 2xx 一律拒绝」、D3 记「否决放行兜底」三条判断及反例
- [x] 4.3 `proposal.md` 记回滚点：`git revert a5ca95d9b`（release 线 `6b77b1114`），无数据迁移

## 5. 未完成（依赖用户）

- [ ] 5.1 PENDING-1：cell 侧先配 `MANDATE_VERDICT_TOKEN`，runner 侧再配 URL + token（顺序见 design「部署顺序」）
- [ ] 5.2 观察到第一行非空 `action_audit.mandate_domain` 才算通道真通
