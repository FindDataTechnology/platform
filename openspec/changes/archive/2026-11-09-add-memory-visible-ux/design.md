# 设计 — add-memory-visible-ux

## D1 开场卡的读取与回显通道

服务端在 session open 的处理点（ws.js 会话打开路径）以 `chatMemoryBlockFor(ownerEmail, "", env)` 读 owner 根空 query digest（既有 SDK 面，超时/降级语义现成）——非空则 `sendToViewers(sid, {type:"memory_recall", sessionId, block})`。**只在会话打开时读一次**：per-turn 重复回显是噪音，且回合内注入已有 prompt 通道。回显卡是旁路只读副本：prompt 组装路径零改动（prompt 字节不变由测试钉死）。

回滚杆 `CELL_MEMORY_RECALL_UI=0`：跳过读+跳过事件（零 fd-memory 出站），前端无卡。

## D2 ChatPage 卡形态

消息流顶部、会话首条消息之前渲染 `MemoryRecallCard`：默认折叠展示首行摘要（block 首行），展开直出 block 全文（`whitespace-pre-line` 保留 fd-memory 行级结构——预算渲染已做行级截断与标题帽，前端不做二次加工）；行内 `（来自 xxx）` 徽标沿用正文文本不做解析（fd-memory 渲染语义）；卡尾「在记忆面板查看与纠正」链接到 `/memory`。折叠态 useState 会话内持久，不落库。旧会话（无 memory_recall 事件）零渲染。

## D3 仪表盘：节奏条与时间线

- **节奏条**：`/api/memory/entries` 代理拉本周窗（since=本周一）× 全 layer 分组计数（L0/note/更正/待晋升四格）——前端按既有 items 结构聚合，后端零新增面；「更正」判定=标题含「更正」前缀（与纠错写入约定一致）。
- **时间线**：同一 entries 代理按 since/until 翻页，L0 与 note 混排（items 已按 ts 排序），L0 条目渲染 `metadata.harness` 徽标；视图切换=Tabs（分层浏览/时间线），共享筛选状态。
- **房间面板**：`/api/memory/entries` 代理增加可选 `project` 透传（fd-memory visibility 面原生支持 project 参数——壹座侧只加透传）；ZhiyuRoomPage 房主态（`room.ownerEmail === me`）渲染折叠区，走同代理。

## D4 权限与隐私

- 回显卡：仅发给该 session 的 viewers（既有 sendToViewers 语义，访客/分享页不涉——share 只读页不接 memory_recall）。
- 房间面板：房主判定在前端渲染层 + entries 代理的 owner 令牌天然只读本人根（他人根本不可达——代理即权限边界）。
- digest 渲染给用户的安全性：fd-memory 渲染已含预算纪律/标题帽/去 re-dup，L0 为过程摘要非 transcript 原文；不新增泄漏面。

## D5 测试与非目标

- 测试：WS 回显（有记忆/无记忆/不可达/回滚杆四态+事件形状）、prompt 字节不变（tap 开关对照）、节奏条聚合口径、时间线混排+徽标、房间面板房主/非房主、entries project 透传。
- 非目标：线程 C 状态层合一；per-turn 记忆徽标；fd-memory 侧改动（零）；智语成员侧房间记忆可见（隐私反向永不做）；分享/嵌入页的记忆可见性。
