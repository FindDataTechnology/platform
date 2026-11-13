# add-chat-memory-injection — Tasks

## 1. paas 主聊天注入

- [x] 1.1 `server/cluster-memory.js`：内部抽 `digestLadder`（digest→标题→原样，逐档 warn）；`memoryInjectionFor` 对外语义零变化；新增 `chatMemoryInjectionFor(cm, prompt, env)`——project 固定 `"default"`、开关 `CELL_MEMORY_CHAT_DIGEST=0` 独立、k/budget 共用 `CELL_MEMORY_DIGEST_K/BUDGET`、任何失败 warn 一行原样返回
- [x] 1.2 `server/ws.js` run 闭包：expandDocRefs 之后、`ctx.session.prompt` 之前挂 `chatMemoryInjectionFor`（owner=`ws.identity.email`，memory client 按邮箱惰性缓存；无身份/未配记忆 no-op）；`chatHistory.recordMessage` 仍记 raw text 不动
- [x] 1.3 单测：注入块拼接（digest/标题两档）/ `CELL_MEMORY_CHAT_DIGEST=0` 字节等同 / 未配记忆 no-op / digest 5xx 与超时降级原样不抛 / 历史行 raw text 断言 / cluster 侧既有测试全绿（零行为变化钉死）

## 2. note 写纪律

- [x] 2.1 `memory-discipline.js` MEMORY_DISCIPLINE 加 note 触发行（zh+en 镜像）；跑 dsh-profile / runner 两侧既有测试（含 CELL_MEMORY_ENABLED=0 字节等同断言）
- [x] 2.2 fd-memory `src/mcp.ts` note 工具描述加触发提示；相关测试更新跑绿

## 3. eval note 场景

- [x] 3.1 `fixtures/eval/continue-scenes.json` 增 ≥3 个 note 场景（expected_background 取自 note 体，review:"reviewed"）；digest 臂全场景跑，门槛照旧（avg diff ≥0.5 / win/noninferior ≥70%）；结果入 continue-baseline + `docs/eval-continue.md` 回填

## 4. 出片与真机验收

- [x] 4.1 双端出片（fd-build-channel 判路；GHA→hkccr→relay→ccr 标准线）+ GitOps 滚产（platform / fd-memory 两清单）
- [x] 4.2 真机 drill：聊天回合①令 agent 记 note（纪律行生效眼见）→ 回合②该会话（或新会话）成员 prompt 含该 note 注入块眼见（会话留档）；`CELL_MEMORY_CHAT_DIGEST=0` 一轮验证零注入；恢复
- [x] 4.3 台账回填（上线记录 + drill witness + 观察项：每回合注入延迟分布、note 写频次基线）
