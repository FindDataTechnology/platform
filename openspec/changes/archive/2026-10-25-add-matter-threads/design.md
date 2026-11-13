# design

## D1 · 事项是平台对象，不是对话对象

事项住在 facet 侧（packs DB 新表 `matters`），挂在部署（pack+agent+deployer）上，不挂在
会话或访客上。理由：会话属于 fd-wanxing 的车道域（跨仓），部署属于平台域；主人队列、
通知绑定、审计全部已在平台域。访客侧 v1 不建视图——访客体验=对话式（问接待，接待读
状态如实转述），fd-wanxing 零改动。

## D2 · 工具挂载循 notify/questions overlay 先例

serving child 的平台工具已有既定管道：preset bridge row 的子类替换（notify overlay 给
`bot_notify`，questions overlay 给 `ask_user_question`）。matters overlay 是第三层：
descriptor 带 `facade`（composeDescriptor 已带 stance）才写 patch——门控在挂载点，非
facade 部署的工具面结构性无此工具（不是运行时判断）。

## D3 · child 只报事件，策略与出站全在 runner

child 调 `matter_open` 只给 {summary, visitor_hint?}；runner 侧执行器持：出站目标
（facet internal 路由）、服务凭据、per-agent 限速（token bucket，循 notify 桶先例）、
开串 piggyback bot_notify。审计行不含事项正文（len-only，notify 双层审计同律）。

## D4 · 状态机与时间线

v1 三态：`open`（待回应）→ `responded`（已回应）→ `closed`（已关闭）。回应可多次
（responded 之后仍可续答，时间线 append）；关闭是终态（v1 不重开——需要续就开新串，
历史可引用）。时间线条目：{kind: open|reply|close, by: reception|owner, text, at}。

## D5 · 访客身份如实局限

v1 访客线索=车道会话线索（context id）+对话中自述（接待转述）。不造访客身份、不做
认证绑定——强身份与跨方披露是披露边界另案的事。事项呈现「访客线索」字段时如实标注
来源（自述/会话）。

## D6 · internal 路由鉴权同 host-settle

`POST /api/packs/internal/matters/:packId/:agentId/open|list|read`，Bearer=部署服务凭据
（internalAuth 同型）。主人路由 `/api/packs/:id/matters...` 登录态+部署者/管理组；
非本人 404（存在性不泄露——与私有包同律）。id 用 `mt_`+randomBytes(12)（pk_ 同型）。

## D7 · 词汇

用户词一律「事项」（复数不译）；内部标识 `mt_`；不引入 ticket/工单词（工单在 spider-heal
语境已有既定含义，避免撞词）。
