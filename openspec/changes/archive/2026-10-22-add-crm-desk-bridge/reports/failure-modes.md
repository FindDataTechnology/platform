# 失败口径验证记录（add-crm-desk-bridge 7.1/7.2 · 2026-10-22）

环境同 reports/acceptance.md（生产 platform sha-449a65b / Chatwoot Account 1 / aloadtree 标准模式 cell）。

## 7.1 token 改错（凭据无效）

- 注入：`kubectl patch secret platform-secrets`（CHATWOOT_API_TOKEN → 无效值）+ pod 重启（cell 重组带坏 token）。
- agent 输出（原话摘录）：

> 工具失败，本轮的收件箱扫描没有取得任何结果。
> 调用 mcp__chatwoot__conversations_meta（account_id: 1）；原始错误文本 `Error: Invalid Access Token`；四分类 **凭据无效**
> 「工具失败（原文：Error: Invalid Access Token）：凭据无效——CHATWOOT_API_TOKEN 需要平台管理员更换」
> 本次没有得出「未处理会话为空」的结论。……空结论只能来自一次成功的调用。

- 纪律实证：非空列表/非静默成功 ✅；拒绝把失败报成「无数据」✅；停等指示、不重试掩盖 ✅；不复用上轮快照 ✅。
- 收件箱原状：故障期间 API 复核 conversation #1 仍在（消息 1/2/3 全在、resolved 状态保持）✅。
- 恢复：secret 回填真值 + 重启。

## 7.2 BASE_URL 不可达（网络不可达）

- 注入：GitOps 提交把 `CHATWOOT_BASE_URL` 翻为 `https://desk-invalid.finddatatech.cloud.invalid`（NXDOMAIN 实证）→ ArgoCD 同步 → pod 重启；token 保持有效。
- 过渡态备注：注入窗口内首回合与 pod 重启赛跑，报的是上一代 env（好 URL+坏 token）的 `Invalid Access Token`——即 7.1 结论的二次印证；env 稳定后重试轮拿到真实传输层失败。
- agent 输出（重试轮原话摘录）：

> 重试时连响应都没拿到（**fetch failed** 是传输层失败，不是服务端返回的 4xx/5xx），说明这次连服务端都没连上。
> ……请求根本没到鉴权层，token 有效与否在这次调用里没有被验证过。
> ❌ 不能说「当前没有未处理会话」——空结论只能来自一次成功的调用，而我没有一次成功。

- 纪律实证：**网络不可达**分类 ✅；精准区分鉴权层（401）与传输层（fetch failed）两种故障 ✅；不用传输层失败推断凭据状态 ✅。
- 收件箱原状：故障期间 API 复核消息 1/2/3 完好 ✅。
- 恢复：GitOps revert（02acabf→7abfe12）→ ArgoCD 同步 → env 复验=原 URL。

## 恢复后四链路回归（7.2 收口）

凭据与网络恢复后重跑：conversations_list/get、messages_list（含 #1/#2/#3 全历史与活动消息）、contacts_get 全部成功；「上轮的发送与解决动作在恢复后依然在库，没有丢」；待处理队列为空是**成功调用**得出的空结论（与故障轮的拒绝报空形成对照）。全绿。

## 结论

| 故障 | 期望 | 实测 | 会话不丢 |
| --- | --- | --- | --- |
| token 无效 | 凭据无效分类、非空列表冒充 | ✅（401 原文逐字+分类+拒绝空结论） | ✅ |
| BASE_URL 不可达 | 网络不可达分类 | ✅（fetch failed+分层判断） | ✅ |

两种故障各验一轮并留记录，spec「失败必带原因」「工具异常不伤会话」两 Scenario 均有生产实证。
