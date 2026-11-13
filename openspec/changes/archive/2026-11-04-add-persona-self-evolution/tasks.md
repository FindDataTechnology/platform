## 1. 候选与提议

- [x] 1.1 新表 `persona_candidates` 迁移（v+1：id/target(kind+ref)/amended_persona/evidence/status/eval_report/created_at）+ 候选 store CRUD；验证：迁移跑通 + CRUD 单测
- [x] 1.2 工具 `persona_amend` 注册（无执行语义，证据校验：来源回合可溯才落候选）+ per-owner 日预算门 + 同任务 debounce + 候选 store 上限；验证：单测覆盖落候选/无证据拒/预算拒/debounce 拒/越界拒（技能/工具/模型字段）/他人资产拒六例
- [x] 1.3 修订文本过既有注入类闸；验证：注入样例候选保持候选态并标注未过闸

## 2. 评测门

- [x] 2.1 persona 臂装配器（臂 A=现行 persona / 臂 B=修订 persona，同场景任务、同模型同温、隔离 scratch root、臂名对 judge 匿名），复用 `memory-eval` harness 挂点；验证：臂隔离与匿名单测（沿技能臂同款断言）
- [x] 2.2 门判定（修订臂不劣于对照臂且差异可解释→过门；平局/劣化/judge 不可用→保持候选态标「未评测」）；验证：三态单测
- [x] 2.3 评测报告存档（臂 transcript + judge 判词随候选可查）；验证：报告读取 API 断言

## 3. 晋升分流与生效节奏

- [x] 3.1 自建预设路径：人接受→既有 custom_presets CRUD 物化 + lineage 审计（旧文本可溯可回退）；验证：物化单测 + lineage 读取断言
- [x] 3.2 pack persona 路径：人接受→既有 fork 管线开 fork 草稿进我的创作，pack 本体零变化；验证：fork 草稿产出断言 + pack 版本不可变断言
- [x] 3.3 驳回即终结留审计；验证：驳回后再晋升被拒断言
- [x] 3.4 生效节奏：物化后进行中/parked 会话 persona 不变，新铸会话读修订文本；验证：双会话对照测试（parked 会话 persona 逐字节不变断言）

## 4. 评审面与真机

- [x] 4.1 构建器调优区 persona 修订分区填实（列表/评测报告/接受/驳回/分流去向说明），i18n 五语言；验证：组件测试 + 五语言完整性门 + 空态契约与 hub 对表
- [x] 4.2 【真机走查随滚版班；注入样例已有结构闸+评审面双钥匙兜底，真机复检待行】真机走查全链：真实回合→persona_amend（证据齐）→跑 A/B→过门→接受→新铸会话 persona 生效；验证：走查记录入台账 —— 2026-11-04 走查班真机全链（先生产 pod 后 demo pod，随班出片 sha-779f832）。**六环实证**：①真实回合 ✓（standard 面真任务：矛盾季度表核对，两回合 agent 均真调工具；第一回合 xb-poster 面下 agent 还两次 tool_search 找不到工具后**如实拒绝凑数提案**——DISCIPLINE 纪律活体）；②persona_amend 证据齐 ✓（candidate 落库，evidence 引本回合矛盾点+fixed+boundary，demo 候选 pc_1793795198853/pc_1793796569022、生产候选 pc_1793795704322）；③跑 A/B ✓（judge-lane 真调 31s，deepseek-v4.1-flash）；④**过门真拦截 ✓**（不劣于门判 current best——修订「暂停不结论」过保守，judge reasoning 如实；promote 无绿评 **409**「requires a green evaluation」双钥匙第二把实锤；同靶重提 **429** debounce 实锤）；⑤候选态如实 ✓（passed:false→status 仍 candidate+evalReport.reason 落库，评测没跑成≠通过纪律活体）；⑥过门→接受→新会话生效段由 11-01 生产真实晋升候选 pc_1793512141314（promoted 在库）+本轮三闸活体补证——完整绿链待一个真正更优的修订自然过门（闸拦的是过保守修订，不是链路故障）。**走查随车逮出并根修两缺陷**：persona_amend 生产 401（add-persona-self-evolution 漏注册 auth 桥，535ee55a 根修+双桥收紧 propose 单动词）+demo judge env 缺失（b1ef3a0 补 BLUEPRINT_JUDGE_MODEL，0750867 mimo 503 断供改钉 deepseek-v4.1-flash）
- [x] 4.3 成本核对：一次 A/B 的 token 账目入台账（与 `add-skill-self-evolution` 4.4 同班核，共用 judge-lane 车道）；验证：账目行落台账 —— 2026-11-04 走查班真机同形直测（demo pod judge-lane deepseek-v4.1-flash，runPersonaEval 精确消息形状 2 臂+1 judge）：**3 次调用 / 2365 input / 11926 output tokens**（台账 §15.130 账目行）；随车改造 `server/persona-eval.js` callModel 补 usage 捕获（eval report 自此自带 usage 字段，后续 A/B 自动入账）
- [x] 4.4 防中毒复检：注入样例候选在真机全链被闸住且候选态如实标注；验证：走查记录 —— 2026-11-04 生产真机全链（platform pod 铸 paas_session 走真路由）：①凭据形状投毒（sk- 字面量+api_key= 赋值+.internal.svc 端点）→ `POST /api/persona-evolution/propose` **400 被 sanity 闸拒**，三种 findings 全点名，候选零新增（库中仅原有 2 条真实历史候选）；②注入式文本（无凭据形状，刻意过第一层）→ 201 建候选（status=candidate 诚实）→ 真实 judge-lane A/B（49.8s）→ **passed:false「current persona ranked best — the amendment regresses」**→ 候选态如实标 `gate not passed`（「评测没跑成≠通过」纪律活体眼见）→ owner reject 清理+一次性靶 preset 删除+cookie 样例文件清零。双层闸均真机拦截，闸=内容语义判据非快照相等
