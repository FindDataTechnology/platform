## 1. 校验器扩展（单点）

- [x] 1.1 `validateProvenance` 白名单扩可选键 `forkOf`（形状 `{ packId, version }`，字段级错误）；验收：夹具测试——合法 `forkOf` 通过、缺字段/多键/坏类型被字段级拒绝；`kind` 三态语义回归测试零改全绿。
- [x] 1.2 发布门与安装门共享同一校验（自动，单点扩展）；验收：发布一个带合法 `forkOf` 的 manifest 过门（集成测试或本地发布门夹具）。

## 2. Fork 动作与种子

- [x] 2.1 fork 动作：以调用者可读 manifest 为种子生成 Studio 工作文档（含上游 license/provenance 字段保留）；验收：fork 后 Studio 画布出现种子文档，且市场/铸造仓/集群库无新增（测试断言零写）。
- [x] 2.2 权限沿读可见性：私有包对无读权者不出现 fork 入口；验收：组件/集成测试覆盖公开（可 fork）与私有无权（不可 fork）两态。
- [x] 2.3 fork 产物经既有发射口落地后 `forkOf` 保留；验收：emit 为 pack 草稿并发布后，manifest 含 `forkOf`（端到端夹具）。

## 3. 血缘显示（协调 spec-sheet）

- [x] 3.1 共享规格书组件增加「forked from」行（有 `forkOf` 显示、无则不渲染）；验收：组件测试双夹具；与 `add-agent-spec-sheet` 的归档序协调注记落本 change。

## 4. 跨域深链

- [x] 4.1 facet 的 fork 入口为深链（登录后落壹座 Studio 种子文档），facet 侧零写；验收：facet 面点击 fork 落壹座 Studio；facet 服务端无 fork 写端点（`grep` 断言）。

## 5. 回归与走查

- [x] 5.1 官方语义回归：fork 官方 agent 后发布，产物不入官方集合、无官方徽章；验收：roster 判定测试 + 走查眼见。
- [x] 5.2 真机走查 ✓（§15.120：?fork= 客服班组种子+血缘行+发射草稿（已删）；facet 跨域深链眼见 platform.finddatatech.cloud/studio?fork=…；发布段=草稿已进发布门，发布动作留给运营班）
