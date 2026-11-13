# Spike 1.1 记录：本地 feed → runner 零改动（go/no-go）

日期：2026-10-28 ｜ 环境：macOS arm64, Node v26.3.0, dev（未打包）
工件：`scripts/spike-local-feed.mjs`（假 feed）、`golden-agents.json`（金样）、
`health.json`、`runner.log`、`feed.log`、`runner-trace.log`

## 结论：GO

本地 feed 以 registry 兼容形状透出后，**agent-runner 一行代码未改**即完成
「编目 → 分片 → listener → 五态」全链；返回真实报文时链路推进到 **dsh 子进程
冷启动**（overlay 写入 + `cold-starting` 日志），证明 feed 契约足够驱动生产
路径。设计 D1（feed 同构、runner 零改造）成立。

## 证据链

| 步骤 | 观察 | 证据 |
|---|---|---|
| feed 被消费 | 一次 `GET /api/agents?limit=500&offset=0` | `feed.log` |
| 分片生效 | 席位 2 条全部领回；同 feed 里打别家 `runner_id` 的 1 条被过滤 | `runner.log`「poll: 2 served agent(s)」 |
| listener 绑定 | `serving packs-spike-demo-agent-1 on :8816` 等两条 | `runner.log` |
| 五态词表 | `/health` 返回 `state: "warm"`（未触达=warm，与实现注释一致）+ children/queued/budget | `health.json` |
| A2A 面可达 | `GET /.well-known/agent-card.json` 两端口均 200 | 现场 curl |
| 拉起路径触达 | `[dsh-profile] wrote preset overlay…` + `cold-starting … (harness=dsh, 0 MCP, 1 skills)` | `runner.log` |

## 三个现场发现

### F1（设计已覆盖）私仓 profile 脚手架是硬前提

无 `AGENT_RUNNER_SEED_HOME` 时 dsh 报 `profile "platform" does not exist`。桌面
descriptor 本就注入 `SEED_HOME=~/.dsh`（cell 的 `ensureDshHome` 提供），对齐后
不再报此错。**落地含义**：本地 feed 的部署条目必须能让 runner 拿到可用的
profile 种子——桌面路径已成立；打包内置 Node 的 DSH_BIN 注入亦已成立。

### F2（规格需修正）容量闸的真实计数单位是 **child 进程**，不是「部署条目数」

`acquire()` 的判据是 `this.children.size < config.maxChildren`；pod 模式下同包
多岗共宿**一个** child（`#groupEntries` 按 packId 归组），单人 mode 一岗一 child。
所以 `AGENT_RUNNER_MAX_CHILDREN=4` 在桌面（`AGENT_RUNNER_POD_MODE=1`）意味着
**4 个 pack 组**，而不是 4 个 agent。已回改 spec/design/tasks 口径：容量按
「运行时组」（pod: 每 pack 组 1；solo: 每 agent 1）计，写面返回的 used/cap 以
组为单位并在 UI 文案里说明。

### F3（真缺陷 → 已修，commit bd5a085f）child 中途退出曾把 runner 整体打死

首轮 spike（seed 后首条报文）日志序列：`cold-starting` → `child exited
unexpectedly` → 进程级 fatal（`Error: agent runtime exited mid-turn` 逃逸为
unhandled rejection，栈指向 `harness/dsh.js:406` 的 settle）。随后 `pgrep` 无
runner 进程。**含义**：本地集群里一个坏 child 即可让整个 runner（所有 listener
与后续回合）消失，直到 supervisor 重启——与 `agent-runner` spec 的
「一个 listener 失败不得打死进程」同精神，但 turn 路径未覆盖。
复现受 dev 环境 child 不稳干扰（后续观测到 `-32603 inactive context` /
`cannot read properties of undefined` 两种 child 自身失败，此时 runner 存活、
调用方拿到结构化错误）。**处置（已完成）**：任务 5.5 落了根因修复，详见下节。

#### F3 根因（已定位并修复）

`agent-runner/harness/dsh.js` 的 `turn()` **先建 `collected` Promise，再
`await client.prompt(...)`，最后才 `return collected`**。child 在 prompt 在途
时死亡 → pump 的 `_child_exit` 分支 `reject(collected)` —— 此刻**还没有任何
handler 挂在它身上** → Node 判定 unhandled rejection（默认
`--unhandled-rejections=throw`）→ 整个 runner 退出 → 本机所有 hosted agent
陪葬，直到 supervisor 重启。

复现与验证（`scripts/test-local-fleet-turn-death.mjs`，栈与现场摘录逐帧一致）：
- 去掉修复 → 该用例以现场同款 `Error: agent runtime exited mid-turn` 红；
- 装上修复 → 3/3 绿（含「在途死亡」「prompt 拒绝」「回合中死亡」三种形态）；
- 真机（真实 dsh 子进程）SIGKILL 复核：调用方拿到结构化 `-32002`，runner 存活。

修法三处：`collected` 立即挂 no-op catch（拒绝永不再无人处理，调用方仍收到
同一个拒绝）；prompt 与 collected **竞速**（child 已死时在途写入可能永不完成，
回合不能陪挂）；`settle` 幂等（collector 路径与 prompt 失败路径可能各触发
一次，第二次不得再减 activeTurns）。

## 未覆盖

- 分页（limit=500 单页读全，>500 条未演练；客户端多页循环代码已读，属合同测试项）
- 真实 LLM 回合成功（dev 无车道凭据；不影响本 spike 的契约结论）
