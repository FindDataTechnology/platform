## 1. 前置：企微后台与真实报文校准（阻塞后续解析实现）

- [x] 1.1 在企微管理端创建「智能机器人」，取得回调 URL / Token / EncodingAESKey，并把平台的 webhook 地址（`/api/bots/webhook/<botId>/<secret>`）登记为回调地址；验证：管理端保存成功且企微完成 URL 校验（服务端日志出现一次握手通过记录）
- [x] 1.2 把机器人拉进一个测试群，在群里 @机器人 发一条文本，抓取**原始回调报文**并落盘为夹具；验证：夹具文件存在且其中能看到 `chattype`、群 `chatid` 与正文提及标记的真实字段名
- [x] 1.3 依据夹具核对 design D2/D4：确认群聊的会话标识字段与提及标记结构，若与文档推断不符则更新 design.md 的字段映射；验证：design.md 中的字段映射与夹具逐字段一致（列出核对结论）

## 2. 适配器实现（wecom-bot）

- [x] 2.1 新建 `server/bots/wecom-bot.js`，复用 `wecom.js` 的 `decrypt`/`signature` 与 `tokenFor` 形态，实现 `verifyWebhook`（签名+解密，握手原样回显）；验证：用夹具构造签名请求，握手分支与验签失败分支各有断言
- [x] 2.2 实现 `parseMessage` 按 `chattype` 分流：`group` 取群 `chatid` 作为 `chatKey`，`single` 取成员标识；同时剥离前导 @提及并 trim，空正文返回 null；验证：单测覆盖群聊/单聊/仅@无内容 三种情形，断言 `chatKey` 与正文剥离结果
- [x] 2.3 实现群聊回复通道：优先被动回复（`response_url`），失败或超窗口回落群发通道；回落失败必须抛出可判读错误（含平台错误码）；验证：单测分别断言被动回复成功、被动失败后回落成功、两条都失败时抛错且错误里含码
- [x] 2.4 在 `server/bots/adapter.js` 注册新类型：加入 `BOT_TYPES`、适配器注册表、凭据字段声明（corpId / 机器人标识 / Secret / Token / EncodingAESKey）；验证：`GET /api/bots` 的 `types` 列表含新类型且凭据字段齐全（现有 bots REST 测试补充断言）

## 3. 管线与守卫复用

- [x] 3.1 确认群聊在既有管线上零改动可跑：跑一遍真实管线（webhook → 校验 → 解析 → 守卫 → 回合 → 回复），断言群聊消息正确落到以 `chatid` 为单位的会话；验证：新增端到端测试，用两个不同发言人、同一 `chatid` 的两条消息，断言落在同一个 session id
- [x] 3.2 验证群聊沿用全部守卫：超长消息丢弃、限流丢弃、工具姿态（未开启时工具回合的回复被扣留）、推理痕迹剥离；验证：为群聊路径各补一条断言（复用现有单聊断言形状，参数改为 group 报文）
- [x] 3.3 验证群聊与单聊互不串台且与既有自建应用通道无干扰：同一成员私聊与群 @ 并存，断言两个 session id 不同、回复各回各侧；验证：单测断言两个 session id 互异且回复目标正确

## 4. 管理面

- [x] 4.1 `/settings/channels` 图标网格加入新类型，并让两种企业微信类型的名称/说明写清能力差异（智能机器人=群聊+单聊；自建应用=单聊）；验证：真机打开页面截图，两个图标文案同时可见且不混淆
- [x] 4.2 新类型的创建/编辑/启停/删除/复制 webhook 走既有 REST 面可直接用；验证：真机上创建一条新类型 bot 并复制 webhook URL，无需重启即生效

## 5. 出片与真机验收

- [x] 5.1 按公开快照线出片（`make-public-snapshot --init` → 补 `ci: keep repo-side image.yml` → digest 门 → 只 bump platform 两面 → ArgoCD → rollout）；验证：新镜像内 `server/bots/wecom-bot.js` 存在，且 `BOT_TYPES` 含新类型
- [x] 5.2 真机四情形验收：①群里一人 @ 得答复；②同群另一人追问，助手能引用前一轮；③私聊同机器人得独立答复；④群里不 @ 时机器人无任何反应；验证：四条各留一条入站日志与一条回复留痕，截图群内实际消息
- [x] 5.3 验收回落与失败路径：构造长回合越过被动回复窗口，验证回落群发通道生效；断掉回落通道权限，验证如实报错且日志可判读（不得静默）；验证：日志中能看到回落尝试与明确失败原因
- [ ] 5.4 归档：`openspec archive add-wecom-group-chat`，主 spec `social-bot-channels` 合并本次 ADDED/MODIFIED 需求；验证：`openspec validate --specs` 全绿且需求计数增加
