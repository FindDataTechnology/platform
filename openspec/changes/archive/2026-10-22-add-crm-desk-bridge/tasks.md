## 1. 依赖与 server 接线（D1/D2/D3）

- [x] 1.1 `package.json` 钉 `@fazer-ai/mcp-chatwoot@1.1.0` 并安装，验证 `node node_modules/@fazer-ai/mcp-chatwoot/dist/index.js` 带 env 启动后 `tools/list` 返回 123 工具（对生产 desk 只读实测；废 peer typescript^5 用 overrides `"-"` 消解；实测 123=标准 100+fork 23，conversations_list/meta 生产只读通）
- [x] 1.2 `platform.bundle.json` 增 `chatwoot` stdio 条目（`command: node` + dist 路径、`requiresEnv`/`envRefs` 均为 `[CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN]`），验证 manifest 校验通过且 bundled seed 进扩展表（origin=bundled、配置随启动同步）——验证：resolveBundle 校验 requiresEnv 形状后解析出条目（bundled seed 为既有通用环，patch 级在 5.1）
- [x] 1.3 实现 `requiresEnv` 整体省略语义（MCP patch 组合时名单全缺 → 条目省略且静默），单测覆盖三分支：全缺省略 / 配齐出现 / 部分缺失沿 envRefs 警告降级（websearch 行为不变）——验证：dsh-profile 省略环 + 三分支/websearch 回归 4 测全绿

## 2. 操作员工具面（D5）

- [x] 2.1 落 98-leaf 名单常量（源=finddata 验真报告 §4 标准 100 清单 − `messages_create`/`messages_delete`），单测对仓内快照核名单（数量、无 kanban_*/scheduled_messages_*、无发送类 2 个）——验证：lib/operator-tool-face.js 由钉版本 dist tools/list 生成（123−23−2=98），快照+核心工具在面 2 测绿
- [x] 2.2 工具面派生加操作员上界：full mode = pack 并集 ∩ 操作员面（无 pack 引用但有操作员面者面=操作员面）、focused = 角色 allowlist ∩ 操作员面、full-surface 覆盖只恢复到操作员面；单测覆盖四场景（含 pack 声明越界被裁、覆盖不越界）——验证：capByOperatorFace 全模式上界经 writeMcpPatch 单点接入，4 单测绿
- [x] 2.3 验证面外调用拦截的可读原因（点名该工具不在平台工具面内）：对 `mcp__chatwoot__messages_create` 与任一 `kanban_*` 名字的 GUARD 拒绝做断言测试——验证：guard 双文案（平台面上界无逃生门/角色收窄有）3 测绿

## 3. 动作闸 crm 线（D6/D7）

- [x] 3.1 注册表增 `crm.message.send`（line=crm、server=chatwoot、tool=messages_create、write 档、argKeys=[account_id, conversation_id, content]、impact 呈现会话号+内容摘要、共享凭据第一方例外注释），单测：argKeys 缺必填被 400 拒、未注册的 delete 类动作被拒——验证：缺 content 拒、messages_delete 未注册，2 测绿
- [x] 3.2 preflight 增宿主 env 存在性检查（缺失 → 「服务器未配置」拦截不进确认档位），单测双分支——验证：requireServerEnv 双分支测绿
- [x] 3.3 执行器 stdio 分支：action 的 server 解析到 bundled stdio 配置时走 StdioClientTransport（每执行一连接，env 与 patch 写入共用同一 envRefs 解析 helper），用桩 stdio server 单测：正常执行、子进程起不来→网络不可达/未配置、工具 isError→原文透传分类、server 不可解析→既有 tool_unroutable——验证：桩 server 5 分支全绿；修得 SDK stdio 稀疏 env 坑（显式 envRefs 转发）
- [x] 3.4 审计验证：执行记录含提议者/批准者/参数摘要，全链路无 CHATWOOT_API_TOKEN 明文（对日志与 action_proposals 表断言）——验证：filterKnownArgs 掉 token 形多余键、impact/执行结果零凭据（echo 桩实证）

## 4. 客服接待技能（D8）

- [x] 4.1 写 `skills/crm-desk-reception/SKILL.md`：四步工作流（读未处理会话→读消息/联系人→壹座对话出草稿默认不发→确认后 propose_action 发送 + messages_list 复核）、钉 account_id=1 与挂件 inbox、25/页分页提示、失败四分类纪律（凭据无效/网络不可达/上游错误/参数被拒，逐字引用禁冒充）、守界问答（企微等不支持）；工具名逐一对照名单——验证：SKILL.md 落 skills/（四步工作流/钉 account_id=1/分页/四分类表/守界问答，工具名全 mcp__chatwoot__ 全名引用）
- [x] 4.2 离线单测：技能可被 `/skill:crm-desk-reception` 展开（getFileSkills 命中），且技能文本引用的全部 `mcp__chatwoot__*` 工具名 ⊆ 98-leaf 名单——验证：getFileSkills 命中+展开含 account_id:1 与 crm.message.send；技能引用 14 个 chatwoot 工具全 ⊆ 98 面

## 5. 本地组合验证

- [x] 5.1 组合断言测试：配齐 env 的合成配置下 patch 含 chatwoot 条目且物化 tool-filter 的 chatwoot 面恰为 98；env 全缺的合成配置下 patch 无 chatwoot 条目、无 tool-filter 条目——验证：配 env 组合出 patch 条目+tool-filter 面=98+operatorFaces 溯源段；env 全缺则 patch 无条目、filter 无行
- [x] 5.2 突变验证：逐项破坏（名单去一项、requiresEnv 改名、注册表 risk 改档）确认 5.1/3.x 断言转红，证明断言有效——验证：三项突变各红（名单去一=3 红/省略击毙=2 红/risk 改档=1 红），还原后 27/27 绿；另抓出并修复 capByOperatorFace 吞过滤图真回归（persona-scope 测试）+ wire-tool-risk roster 计数 19→20 更新

## 6. 出片与生产验收（4.1/4.2 收口）

- [x] 6.1 出片（公开快照仓线）滚 platform 部署，GitOps env 增 `CHATWOOT_BASE_URL=https://desk.finddatatech.cloud` 与 `CHATWOOT_API_TOKEN`（值=finddata docs/TEST-ACCOUNTS.md §七）——实绩：快照 449a65b（公开仓 image.yml 出片绿）→ relay OK → ccr digest e1dec423 skopeo 实证 → GitOps d9c8ab6（platform 内联 BASE_URL + token 走 platform-secrets 带外 patch；demo 无 env）→ 双部署 rollout 1/1、pod imageID=e1dec423；in-pod 仿真 cell 引导实证 patch 含 chatwoot（env 双值）+ tool-filter 98 面 + operatorFaces 溯源
- [x] 6.2 生产四链路验收（经 `/skill:crm-desk-reception`，读类直调、发送走 ActionCard 批准）：①列未处理会话 ②读某会话消息 ③发测试回复且 desk 收件箱 UI 可见 ④读联系人——全过：①list+meta 交叉 ②messages_list 逐字 ③propose→ActionCard→批准→执行器 stdio→Chatwoot 消息 #2（API 复核一致）+读回复核 ④contact #4 全字段；证据落 reports/acceptance.md（种子消息为 outgoing 已如实注明：v4 WebWidget 箱禁 agent API 伪造 incoming）

## 7. 失败口径验证（4.3）

- [x] 7.1 token 改错一轮：GitOps 把 `CHATWOOT_API_TOKEN` 翻为无效值 → 重启/重组 → 运行技能，验证 agent 输出「凭据无效」分类（401 透传）而非空列表/静默成功、desk 收件箱既有会话原状（UI 或 API 双证），记录后恢复 env
- [x] 7.2 BASE_URL 改错一轮：同法把 `CHATWOOT_BASE_URL` 翻为不可达地址，验证「网络不可达」分类与会话原状——实绩见 reports/failure-modes.md：401 原文+凭据无效分类+拒绝空结论+收件箱原状（消息 1/2/3 在）；7.2 注入窗口首回合与 pod 重启赛跑报了过渡态 401（反成 7.1 二次印证），env 稳定重试轮 fetch failed+网络不可达+分层判断（鉴权层 vs 传输层）+收件箱原状；恢复后四链路回归全绿（历史与 resolved 状态在库）

## 8. 收尾与回勾

- [x] 8.1 `openspec validate add-crm-desk-bridge --strict` 绿；回 finddata `crm-board-adoption/tasks.md` 勾 4.1/4.2/4.3——validate 绿（80c00a17）；finddata tasks.md 4.1/4.2/4.3 已勾并注明证据落点（finddata 非 git 仓无法提交，编辑已落盘）
