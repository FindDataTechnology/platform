# Design: 记忆线收口

## Decisions

### D1 智语走 chat 车道同一条缝，不新立部署根
归档设计 D7 的原话是「facade/智语走 chat-memory 同一条缝，不分不帕；登入=本 owner，游客=不注入」。因此房间回合注入的是**提问者本人的 owner 块**（`u/<email>`、project=default），不是部署的 `d-<packId>` 根。
替代项「注入房间所属舰队的部署根」被否：那是 agent 的工作记忆，不是提问人的沉淀；混进去会让 agent 以为自己有过未发生的经历。

### D2 阶梯改为返回 block，而不是自己拼 prompt
`digestLadder` 原来把 `prompt + block` 拼好返回，只有它能用。房间回合的 prompt 由 `buildPrompt` 组装（房间上下文 + 私窗 + 最新消息），块必须追加在末尾而不是拼在别处。改为返回 `{block, source}`，由两个包装各自拼接：chat/cluster 包装拼出来的字节与改前**逐字相同**（`test/cluster-memory.test.mjs` 15 测钉死），房间车道则拿同一个 block 自己追加。
新增 `chatMemoryBlockFor(ownerEmail, query, env)` 作为「只要块」的出口，开关与 chat 车道共用 `CELL_MEMORY_CHAT_DIGEST`——一条开关，不是两条。

### D3 身份门用 kind，不用自造判断
`kind=user` 是 identify 合流后的住户（ref=邮箱），`kind=guest` 是匿名访客。注入与否只看这一个字段，不引入新的身份管道（与 zhiyu/identify 既有先例一致）。

### D4 改 tag 用行内编辑面，不用弹窗也不用 prompt
`window.prompt` 挡页面、不可 Esc 撤、样式不可控，是实现偷懒。行内编辑面留在卡片内、与原手势同排，语义与需求一致（接受/修改/删除 AI 提议），且不需要新 i18n 键（复用 `common.save`/`common.cancel`）。
替代项「真模态弹窗」被否：为改两个 tag 打开一个遮挡全页的模态，成本与收益不成比例；行内编辑同样满足「不置乱态」。

### D5 降级态由 503 驱动，不预先探测
记忆手势的三个路由在未配置记忆服务时统一返回 503 `memory_unavailable`。store 捕获该状态记 `memoryOff`，三个手势一起置灰并给 `memory.degraded.unavailable` 提示；任一手势成功即清除。
替代项「进页先探一次 `/api/memory/entries`」被否：多一次请求，且探到「有服务」不等于「这次手势能成」，判据不如实际失败可靠。

## Risks / Trade-offs

- **房间回合变慢**：每次回合多一次 digest 调用（5s 上限）。已按「降级开 + 只读一次 + 失败即原文」处理；实测生产块读取在 1s 量级。
- **多注入一份上下文**：每回合多至 1500 token 预算。与壹座 chat 同参，属设计内成本。
- **灰态粘滞**：一次 503 后整页手势置灰，直到某次成功。可接受——记忆服务恢复通常伴随滚动发布，用户刷新即重算。
