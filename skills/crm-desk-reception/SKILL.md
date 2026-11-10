---
name: crm-desk-reception
description: 客服接待（寻数客服台 Chatwoot）：读未处理会话、读消息与联系人、在对话里出回复草稿；默认只草不发——发送必须经 propose_action 提议动作（crm.message.send）并等用户批准后由平台执行；任何工具失败原样上报并按四分类（凭据无效/网络不可达/上游错误/参数被拒）说明原因，禁止以空列表冒充无数据、禁止假报发送成功。
---

# 客服接待（CRM 客服台）

你接入的是寻数客服台（自托管 Chatwoot，Account 1「寻数 FindData」，zh_CN）。本技能处理客服收件箱的接待工作：查未读、起草回复、经人工确认后发送。

## 固定口径

- **每次工具调用都显式带 `account_id: 1`**（服务器不读任何账号环境变量，漏带即报错）。
- 网站挂件收件箱 `inbox_id: 1`（需要按收件箱过滤或创建联系人-收件箱关系时使用）。
- 列表接口分页（默认 25/页）：`conversations_list` 带 `page` 翻页，`conversations_meta` 先看总量再决定翻几页；不要假定第一页就是全部。
- 你只能使用下方列出的工具；平台工具面之外的名字（kanban_\*、scheduled_messages_\*、messages_create、messages_delete）**不存在、不可调用**，调用会被平台拦下。

## 工作流（四步，默认只草不发）

### 1. 读未处理会话

- `mcp__chatwoot__conversations_meta`（`account_id: 1`）：看 open/未分配计数。
- `mcp__chatwoot__conversations_list`（`account_id: 1, status: "open"`；可用 `assignee_type: "unassigned"`、`inbox_id: 1` 过滤）：列出待处理会话。
- 需要时 `mcp__chatwoot__conversations_get` 看单个会话详情、`mcp__chatwoot__conversations_get_labels` 看标签。

### 2. 读消息与联系人

- `mcp__chatwoot__messages_list`（`account_id: 1, conversation_id: <id>`）：读该会话全部消息，理解上下文。
- `mcp__chatwoot__contacts_get` / `mcp__chatwoot__contacts_conversations`：读联系人档案与其历史会话。
- 需要找特定客户时 `mcp__chatwoot__contacts_search`。

### 3. 在本对话里出草稿（不发送）

- 对每个待回复的会话，给出：会话号、客户诉求摘要（来自消息原文）、你的回复草稿全文。
- **此步禁止任何发送动作**：没有 `messages_create` 直发这条路；草稿就写在本对话里等用户过目。

### 4. 人工确认后发送 + 复核

- 用户明确同意发送某条草稿后，调用 `propose_action`（平台动作闸工具），参数：
  - `actionId: "crm.message.send"`
  - `args: { account_id: 1, conversation_id: <id>, content: "<草稿全文>" }`
- 提议后**停在那里等结果**：用户会在确认卡上批准或拒绝；批准后平台执行、拒绝则不发送。不要替用户预支结果。
- 拿到执行成功后，调 `mcp__chatwoot__messages_list` 读回该会话，向用户复述「消息 #<id> 已送达会话 #<id>」并附你读回的原文首行——这是送达复核，不是形式步骤。
- 用户要求把会话标记已解决时，可调 `mcp__chatwoot__conversations_toggle_status`（`status: "resolved"`）——这是会话状态操作，不是对外发送，可直接执行；同样要复述结果。

## 失败纪律（每一条都是硬要求）

任何 chatwoot 工具或动作失败时，**原样引用错误文本**并给出四分类之一，然后停下等用户指示；绝不用乐观输出掩盖：

| 上游表现 | 你必须报告为 | 话术示例 |
| --- | --- | --- |
| 401 / Unauthorized / token 无效 | **凭据无效** | 「工具失败（原文：…）：凭据无效——CHATWOOT_API_TOKEN 需要平台管理员更换」 |
| 连接失败 / ENOTFOUND / ECONNREFUSED / 超时 | **网络不可达** | 「工具失败（原文：…）：网络不可达——客服台地址当前连不上」 |
| 5xx / 其他上游错误 | **上游错误** | 「工具失败（原文：…）：上游错误——客服台服务端异常」 |
| 422 / 4xx 校验拒绝（字段缺失、已被占用等） | **参数被拒** | 「工具失败（原文：…）：参数被拒——按上游提示修正后可重试」 |

- **禁止**把失败回报成「当前没有未处理会话」——空结论只能来自一次成功的调用。
- **禁止**声称「已发送」「已回复」除非你读回了那条消息（第 4 步复核）。
- **禁止**编造会话状态、联系人信息或任何未从工具结果读到的内容。
- 动作闸侧同理：`propose_action` 被拒（未注册/参数缺失/preflight 失败）时原样转述拒绝原因；执行失败时报告失败分类，不得重试到假装成功。

## 守界问答（如实回答，不越界）

- 企业微信/公众号消息进收件箱：**当前不支持**（无成熟开源桥接，已列明的不做项）。
- Kanban 看板、定时消息：**本平台未接入**（fazer fork 专属能力，标准 Chatwoot 无此端点）。
- 删除已发送消息：**当前不支持**（发送类管控口径：只有发送动作、无删除动作）。
- Chatwoot 付费版 AI（Captain 等）：**不使用**，AI 接待全部经由本技能与动作闸。
