## 1. 规格与决策

- [x] 1.1 拍板三项未决（公开面名单 / `publicFacing` 是否显式声明 / chat 注入是否裁剪版）并写入 design；验证：design §7 三项均有结论（2026-10-30 用户「同意」）
- [x] 1.2 spec delta 落三处（agent-fleet-core：B1+B6；pack-authoring：B3；agent-runner：B5），MODIFIED 段带全场景；验证：`npx openspec validate fix-external-team-chat-lane --strict` 绿（validate --specs 217/0）

## 2. B1 注入缝与派发寻址

- [x] 2.1 chat 车道起轮点接注入：归因到本队 persona 成员时注入本队上下文（成员 title/目标 + 可派发目标），未归属不注入；验证：`scripts/test-external-team-chat-lane.mjs` 13/13 绿（归因成立→注入含本队成员与可派发标记；不成立→null 即 prompt 原样；归档队伍退出归因）
- [x] 2.2 注入段与任务车道**同源数据、不同裁剪**（`server/fleet-chat-context.js` 复用 `resolveAttribution` 归因，渲染 chat 专用的裁剪版）；验证：单测断言注入段不含报数/拍板/巡视等任务语义，且不含节点/成本/凭据
- [x] 2.3 `POST /api/fleets/dispatch` 的 `to` 支持 title（本队内解析，member id 兼容；歧义 400 列候选；跨队 400）；验证：单测（id 命中/标题命中/未知/跨队/同名歧义五例）
- [x] 2.4 → 真机实证 2026-10-30：生产 cell WS 直驱，`to="识律专家"` 解析命中本队岗、`tool_end ok`、`/api/fleets/:id/turns` 回读 2 条 `source=delegation status=ok`（turns 由 0 变非 0） 端到端：生产对话里前台拿到名单后派发成功、目标岗位起轮、`/api/fleets/:id/turns` 出现本队回合（走查复测：Q2 三问链）——验证：turns 从 0 变为非 0

## 3. B3 工具面收敛

- [x] 3.1 manifest 增 `publicFacing` 声明（校验：仅布尔）；验证：单测（true 绿 / 缺省绿 / 非布尔拒）
- [x] 3.2 `publicFacing` 下 persona 聚焦只留公开面（`dsh-profile.js` keep-set 收窄，`PACK_PUBLIC_FACE_MCP` 可配）+ 禁用工作区文件工具与名册枚举工具（tool-scope 桥 `denyTools` 段：guard 拒调 + restrict 移出名册）；未声明 pack 零变化；验证：单测（名单/工具断言）+ 既有 tool-scope 套件 12/12、full-mode 8/8、register-seam 3/3 绿
- [x] 3.3 → 已铸上架 manifest 1.0.3（facet store v4，publicFacing=true）；生产 cell `tool-filter.json` 见 `denyTools` 七项、`mcpTools` 面数 0（零 MCP 面恰是第二班 e3481f14 修的分支） 对外产品介绍 pack 声明 `publicFacing: true`（种子已加）并重铸上架；验证：生产日志显示聚焦名单已收敛（无 wire-ops/lex-ops 等）——待出片后铸

## 4. B5 推理痕迹剥离

- [x] 4.1 `stripReasoningLeak` 提为共享工具（`server/reasoning-leak.js`：一次性 + 流式两式），bot 车道改为共用；web 文本输出路径接入（delta 走流式过滤、settled 文本走一次性）；验证：单测（闭合/未闭合/剥空/跨 delta 分块/普通文本五例）+ bot 车道无第二份正则
- [x] 4.2 → 真机实证：访客可见正文 190 字符无 `<thinking>`/`<reasoning>`（818 字符走合法 thinking 信道） 复测访客侧不可见 `<thinking>`；验证：web chat 文本 delta 无推理痕迹——待出片后真机复测

## 5. B6 首启排队

- [x] 5.1 chat 车道 pack persona 首启走有界等待（默认 120 秒可配，`CHAT_FIRST_USE_WAIT_MS`），派发**前**等运行时就绪（就绪后才派，落在重启窗里的 prompt 才不会丢），再失败才结构化错误；验证：实现 + 与既有 fleet 车道的 `awaitRuntimeReadyForJob` 同语义（120s 上限）

## 6. 收尾

- [x] 6.1 走查实录补复测结论（B2 已修；B4 归 B3；B6 降级为慢）；验证：文档更新
- [x] 6.2 → 主 spec 已随本 change 落三处 delta，`openspec validate --specs` 绿后归档 主 spec 同步 + `openspec validate --specs` 绿 + 归档；验证：validate --specs 无 delta 残留
- [x] 6.3 → 台账 §18 已录（两班出片+四条入律坑），memory 索引行同步 台账/memory 更新；验证：memory 索引行含本变更要点
