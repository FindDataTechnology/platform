# 生产验收记录（add-crm-desk-bridge 6.2 · 2026-10-22）

- 环境：壹座生产 https://platform.finddatatech.cloud（platform 部署 sha-449a65b / digest e1dec423，pod imageID 相等实证）；Chatwoot 生产 desk.finddatatech.cloud Account 1「寻数 FindData」。
- 走查身份：aloadtree@gmail.com 真实登录，标准模式 agent（cell 1da519d4c1c0bf89）。
- 会话种子：contact #4「验收访客（paas 桥）」+ conversation #1（open，网站挂件 inbox 1）+ 消息 #1（**outgoing 种子**——Chatwoot v4 WebWidget 箱不允许 agent API 伪造 incoming，种子如实标注；验收机制不受影响）。
- 触发：`/skill:crm-desk-reception 处理未读会话：列出未处理会话、读最新会话的消息与联系人，然后草拟回复（默认只草不发）`。

## 四链路结果

| # | 链路 | 结果 | 证据 |
| --- | --- | --- | --- |
| ① | 列未处理会话 | ✅ | agent 调 `conversations_list(status=open)` 得 1 条，与 `conversations_meta` all_count=1 交叉核对、确认无第二页 |
| ② | 读会话消息 | ✅ | `messages_list` 全量读回，逐字引用消息 #1 并**如实指出其为坐席侧 outgoing 而非客户入站**（不编造） |
| ③ | 发测试回复且收件箱可见 | ✅ | agent 调 `propose_action("crm.message.send")` → ActionCard 行内确认卡（write 档、提议 ID 4449fbd0-9a6c-46e5-9b91-74203bd6ca45、影响面=会话号+内容摘要）→ 人工点「确认执行」→ 执行器 stdio 分支调 `messages_create` → **Chatwoot 消息 #2 落库**（API 复核 content 全文一致、created 1792657296）→ agent `messages_list` 读回复核。提议服务端状态 `executed`、approved_at 2026-10-22T08:21:35Z、proposer=aloadtree@gmail.com |
| ④ | 读联系人 | ✅ | contact #4 全字段（name/email/lead/WebWidget/blocked）+ `contacts_conversations` 历史（仅 1 条） |

附带实证（非验收项但同链路自然发生）：`conversations_toggle_status` 置 resolved 后 agent 主动用 `conversations_get` 回读核对（status=resolved、活动消息 #3、snoozed_until=null），未只信单次返回。

## 其他生产实证

- cell 组合：aloadtree cell（/data/cells/1da519d4c1c0bf89）mcp.patch.yml 含 chatwoot 条目（CHATWOOT_BASE_URL/CHATWOOT_API_TOKEN 双 env 注入），tool-filter.json chatwoot 面恰 98 + operatorFaces 溯源段（与全模式 pack 并集并存）。
- 草拟纪律：默认只草不发被遵守（首轮明确「未发送任何消息」）；草稿不编造价格（「工具面里没有价目数据，我不会编造单价区间」）。
- 动作闸纪律：提议后 agent 明确等待、不预支「已发送」；批准后由平台执行路径发送（agent 无法直接调 messages_create——不在 98 面内）。

## 失败口径（7.x）

见 reports/failure-modes.md。
