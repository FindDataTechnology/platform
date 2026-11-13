# add-chat-memory-injection — Design

调查依据（2026-10-25 本窗口实地核对）：主聊天链路 = gateway catch-all → cell WS `case "prompt"`（server/ws.js）→ run 闭包 → `ctx.session.prompt`（server.js:878-891）→ dshBridge.prompt；**paas 不组装 system prompt**（persona 在子进程 preset 层），回合级可改写的只有发出的用户文本——与 cron-runner 的 taskPrompt 改写完全同构。

## D1 挂点：ws.js run 闭包，expandDocRefs 之后

`promptWithDocs` 已是"最终发给 agent 的文本"（ws.js:578-579），在其后前置记忆块即 cron 挂点的同构移植。远程 fork（ws.js:562-570）提前分叉、bots（server/bots.js:535）、delegation 各自直连 bridge——**v1 均不注入**（非目标）；/skill 命令 lane（ws.js:479-488）同理不动。

## D2 project = "default"（读面=写面）

person token namespace `u/<email>` 经 `namespaceParts`（fd-memory `src/auth.ts:260`）得 project **"default"**——chat agent 经 MCP 写的 note/handoff 全落此处；/digest 的 notes 段按查询 project 过滤（`src/http.ts:320`）。集群 note 能被集群 digest 召回，是因为 cron hook ② 写的是 `clusterProjectId(clusterId)`；两 lane 写面不同，读面各自对齐。若读错 project 就是 §15.31 补记三 t2 空块的开环复辟。

## D3 阶梯复用：抽内部共享函数，两个薄壳

`server/cluster-memory.js` 内部抽 `digestLadder(cm, project, prompt, digestOn, k, budget)`（digest→标题→原样，逐档 warn 一行）；`memoryInjectionFor` 保持对外签名与语义**零变化**（cluster 调用点不动，既有测试钉死）；新增 `chatMemoryInjectionFor(clusterMemory, prompt, env)`：project 固定 `"default"`，独立开关 **`CELL_MEMORY_CHAT_DIGEST=0`**（默认开），k/budget 与集群共用 `CELL_MEMORY_DIGEST_K/BUDGET`。chat 侧 owner 取 `ws.identity.email`，memory client 按邮箱惰性构建缓存；任何构建/网络失败 warn 一行、原样 prompt（不阻塞回合）。

## D4 历史保真

`chatHistory.recordMessage(sid, "user", text, …)`（ws.js:575）记录 raw text 不动；注入块只进发出的 prompt——与 expandDocRefs「用户消息保 raw refs、agent 见展开」先例一致，UI 回放不含记忆块。

## D5 note 纪律单一来源

`memory-discipline.js` MEMORY_DISCIPLINE 加一行（zh+en 镜像）：用户明示「记住这个」或学到跨会话有价值的偏好/事实时，调用 `memory_write_page` 记 note，开场会自动带上最近 note。fleet runner persona 与 cell preset suffix 两面经既有管道自动生效；挂载关闭时输出字节等同（既有断言覆盖）。fd-memory `src/mcp.ts` note 工具描述（现仅"Write a durable note page…"）追加同义触发提示，覆盖不经 dsh persona 的 MCP 消费者。

## D6 eval note 场景

`fixtures/eval/continue-scenes.json` 增 ≥3 个场景：expected_background 严格取自 note 体（mk-continue-scenes 同一 sanitization，review 标 reviewed），validateScenes 的 ≥12/≥3 项目门槛照旧；digest 臂全场景重跑，既有门槛（重推导度 avg diff ≥0.5、win/noninferior ≥70%）不放松，结果入 continue-baseline 并回填 docs/eval-continue.md。

## D7 延迟与量级

每回合 1 次 /digest（readDigest 5s AbortController 既有）；S0 实测主聊天量级低。embed 慢（观察项 10.9s）时 hybridCandidates 自动 keyword 降级（digest 带 model_note），不阻塞回合。出片后观察项：每回合注入延迟分布、note 写频次变化（纪律行生效的间接证据）。

## D8 缓议：u/ 根蒸馏

`distill-scheduler.ts:88/:142` 的 `d-` 前缀闸不动。理由：note 已有读面（L1 召回）；u/ 蒸馏 = per-owner LLM 成本 + 平台蒸馏器读 person 根的隐私姿态变化，且需要自己的质量闸（蒸馏产物直接进 L2 影响所有后续召回）。留给独立 change。
