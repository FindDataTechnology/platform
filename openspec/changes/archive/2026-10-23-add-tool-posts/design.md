# Design: add-tool-posts

> explore 底稿 §四 T1(对外称 bot/轻量岗,实施名「工具岗」——与 pack skills 撞词故不叫 skill)。执行载体锚定:`lib/action-executor.js` 的 MCP 客户端传输。

## D1 · targetId 约定与校验

`targetKind="tool"`、`targetId="server::tool"`(注册 MCP 服名 + 工具名,双冒号分隔)。写面校验:server 段能被 `resolveServerEndpoint` 解析(注册表条目在即过,工具存在性留运行期如实失败——MCP 服的工具面是动态的,写时强校验会腐烂);tool 段非空;有节奏时 promptTemplate 必须是合法 JSON 对象串;model/fallbackModel 声明 400 明拒(无 LLM 回合)。多岗豁免:唯一岗扫描(findPostByTarget)对 tool 跳过——同 a2a 规则。

## D2 · 执行器:一次确定性调用,零 LLM

`runToolTurn(ctx, job, timeoutMs)`(cron-runner 新分支,targetType==="tool"):
1. `JSON.parse(job.prompt)` → 非 JSON/非对象 → `{ok:false, error, }`(errorKind 落 runtime_not_ready);
2. targetId 拆 server::tool → `resolveServerEndpoint(server)` → 不可路由 → runtime_not_ready;
3. MCP 客户端一次 callTool(复用 action-executor 的传输形状:initialize→callTool→close;凭据沿用该 server 注册条目的 credentialRef 解析,与用户装包调用同一身份);
4. 结果 JSON.stringify 落会话(chatHistory 既有),返回 `{ok, text}`;工具 isError → `{ok:false, error:工具错误文本}`(按文本归类)。
超时默认沿用回合超时。O1 事件:收口既有,model=null 如实。**无身份注入、无 preset 归位、无报数通道**——不适用面全部跳过。

## D3 · manual 车道打通(派发/接棒/execute-now)

`createManualTask({..., tool: "server::tool"})` → targetType="tool"、preset=targetId——dispatch 桥对 tool 岗放行(替换现行 cluster 拒绝位为「cluster 拒、tool 过」)、handoff 触发器同款、决策 execute-now 的 manual 分支同款。运行期统一:manual/cron 任务 targetType=tool 都路由 runToolTurn。

## D4 · 物化与在场判定

materializedSpec:targetKind tool → 任务 targetType "tool"(preset=targetId)。resolveTarget tool 分支:注册表条目存在即 alive(label=server::tool);条目消失 → vacant 如实。

## D5 · 预估与架构师

estimateFleetCost:tool 岗 turns/day 照计、tokens 按 0(标注 `toolPost: true`);fleet-architect 的 validateFleetDraft 增 tool 目标解析(server 路由校验同 D1)、model 拒绝同款、draft/apply 透传。

## D6 · 测试与不做

新套件 `test-tool-posts.mjs`:注入 fake MCP 客户端(传输注入式)驱动 runToolTurn 三态(ok/参数坏/路由失败)、写面校验矩阵、多岗豁免、dispatch/handoff 到 tool 岗、预估 0 token。十二套回归零新增红。
不做:pack skills 执行、动作闸高危操作进舰队、LLM 后处理、新 MCP 服、跨用户凭据。
