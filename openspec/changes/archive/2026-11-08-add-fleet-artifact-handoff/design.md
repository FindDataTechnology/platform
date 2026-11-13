# Design — add-fleet-artifact-handoff

## D1 句柄用什么寻址

两半，各有各的用处：

- **资源库标识**（`resources.id`）：稳定、服务端权威、跨会话可寻址；人可以在资源库里打开它。
- **workspace 相对路径**（`file_path`）：常驻 persona 与上游共用同一 cwd，直接 `read` 就能用；
  相对路径也避免了把机器绝对路径写进 prompt。

两个都给，下游按自己能力取用。**不写绝对路径**（会泄漏部署布局，也在换机后失效）。

## D2 窗口为什么必须界定

资源库按会话累积，若只按 session 取，交棒时会把**上一轮甚至上周**的产物一并塞给下游——
prompt 变噪音，下游还可能误用旧文件。所以取 `created_at >= ledgerTurn.startedAt`（本回合起点），
且限最近 8 条。没有 `ledgerTurn`（无账本部署）时退化为"最近 8 条"——比塞满历史好，
且这层只是提示，不是契约。

## D3 只给 persona

- **a2a**：另一个服务，资源库标识在它那边不存在；给它一个它能理解的东西需要跨服务契约，本变更不做。
- **tool**：prompt 就是 JSON 参数，多一个字符都算非法（既有铁律，测试逐字节钉住）。

## D4 `async` 的代价与边界

产物读取要打库，`igniteFleetEdges` 因此变 async。两个调用方（`server.js` 的
`triggerFleetHandoffs` 与 `cron-runner` 的 `await ctx.triggerFleetHandoffs(...)`）本来就
按 Promise 处理，签名变化对它们透明；测试也早已 `await`。

**降级**：`upstreamArtifactSection` 内部 try/catch，任何失败返回空串——接棒不会因为
"资源库打不开"而停下。这条与边缘上下文、记忆摘要同一姿势（degrade open）。

## R1–R4

- **R1 无产物零变化**：`artifactSection` 为空时不插入任何字符，prompt 与改动前逐字节一致。
- **R2 顺序**：散文在前（下游先知道发生了什么）、句柄在中、上下文占位符在最后（渲染器替换点不变）。
- **R3 幂等/点火键**：产物段只影响 prompt 内容，不影响 `hopKey`；同一回合重入被 ⑦ 拦住。
- **R4 资源库写入面**：一行未改——本变更只读。
