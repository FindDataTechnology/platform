# 上产与演练记录

日期：2026-11-10　真源 paas `5c3508c4e`　镜像 `law-bench/platform:sha-eb20ffb`

## 一、根因（一句话）

停车判据是 `e?.code === -32003`，而 `-32003` **只在** `platform/stream` 的
`finish` + `reason.kind === "error"` 帧上产生（`harness/dsh.js:530`）。模型 SDK 抛的
`APIError("403 status code (no body)")` 在帧之前冒泡，`e.code` 为 `undefined` ⇒
分类器不触发 ⇒ 从不探测、从不 parking，只剩 `rollover.js:128` 一行 warn。

旁证：`status code (no body)` 这串字**在 paas 仓里一处也不存在**——它是 SDK 的措辞，
不是我们的。判据与病因不同形态，所以保险连续数周一次没生效。

## 二、实现

- `isBillingRejectionShape(e)`（纯函数，模块级导出）：`e.status`/`statusCode`/
  `e.response.status` ∈ {401,403}，或 message 匹配 `/^40[13]\b.*status code/i`。
- 触发：`e?.code === -32003 || isBillingRejectionShape(e)`。
  **安全支点**：形态只买一次零花费 `/models` 探测；停车权仍在探测裁决（fail-open 不变）。
- 失败分支 `turn_ended` 增 `error_kind`：`timeout` / `child_exit` / `llm_failed` /
  `billing_unconfirmed`，无形态则**字段缺席**（不是 null）；`billing_rejected` 不在此处
  ——探测是 fire-and-forget，判决由随后的 `billing_parked` 事件承载。

## 三、测试

| 套 | 结果 |
|---|---|
| `scripts/test-billing-shape-classification.mjs`（新增） | 3/3 |
| `agent-runner/test/` | 37/37 |
| `scripts/test-persona-park-lane.mjs` | 9/9 |
| `scripts/test-agent-runner.mjs` | 36/73 —— **改动前后逐条相同**（`git stash` 对照），既有环境问题（`options is not defined`） |

## 四、上产链

1. gitee `fd-craw-private` @ `release/cell-session-persona`：提交 `5c3508c4`
   （本地 `44c198cfd` 被 pre-push `oxlint` 挡住——报错在**他人提交的**
   `scripts/missed-recalibrate.mjs:93`；用干净克隆 cherry-pick 只带自己的提交）
2. 公开快照：`make-public-snapshot.mjs --ref release/cell-session-persona`
   （私有仓不能直推公开仓，`fd-build-snapshot` 主动拒绝了；裁剪：排除 4596 内部文件、
   35/36 引用改写、2109 文本禁词净、gitleaks 净）
3. 快照仓 `scs001/platform-image-verify` 提交 `eb20ffb` → run 42693171900 绿（5m6s）
4. 手工补 ccr（relay 未轮到）：`skopeo copy --all hkccr→ccr`
5. GitOps 三件（`agent-runner-b/c/serving`）`sha-b3a68fc → sha-eb20ffb`；
   `agent-runner-c` 与 `-serving` 已 successful rolled out 并跑在新镜像上

## 五、过程中踩的两个坑（都值得记）

### 5.1 我改错了容器

第一版 GitOps 提交用正则改 `image: …/platform:sha-b3a68fc`，命中了文件里**第一个**
镜像——`initContainers` 的 `chown-home`，而不是 `containers` 里的 `runner`。
结果：pod 重建了、看起来"滚了"，但真正跑回合的代码还是旧的。

判据：`awk '/- name: runner/{r=1} r&&/image:/'` 取到的那一行必须是新 tag。
修正提交 `18a6fa0`。

### 5.2 rollover 只滚「热」的子进程

```js
async check() {                       // 每 60s 一次
  for (const [key, entry] of this.manager.entries) {
    if (this.manager.pausedKeys.has(key)) continue;
    if (this.manager.isParked?.(key)) continue;
    if (!this.manager.children.has(key)) continue;   // ← 冷 agent 直接跳过
    await this.#roll(key, entry, day);
  }
}
```

所以**一个冷掉且坏掉的 agent 永远不会重试它的 digest**。之前"每分钟一次 403"是因为
当时它还有热子进程在重试；重启（滚版）之后 `0 child(ren)`，重试就停了。

含义：本 change 让「有回合发生」时的分类正确，但**"根本没有回合"是另一层静默**——
那一层只能靠外部回合或它的 rhythm 把它热起来才会暴露。`wx-alpha` 的 rhythm 是
`[{"every":"1h"}]`，所以要等下一次 tick。

## 六、演练状态

- 已做：resume `wx-alpha`（200，`paused:false`）；观察 ~6 分钟，时间线只有
  `agent_unhealthy` / `resumed` / `state_changed paused→warm`，**无 digest 尝试**
  （与 5.2 一致），因此 `billing_parked` 尚未出现。
- 待做：等下一个整点 rhythm tick 把它热起来（`onSpawn` 钩子会立即滚一次），
  届时应在**一个失败回合**内看到 `billing_parked`，且 `turn_ended` 带 `error_kind`。
- 无论结果，验证完都要把它 `pause` 回去——计费键仍然失效，不该继续跑。

## 七、遗留

1. 5.2 那层静默（无回合）本 change 不覆盖。要覆盖需「无回合」也进入健康判定——
   fd-wanxing 侧的 `silent` 态已经区分了这件事，但 runner 侧的 digest 重试不动，
   两者是不同层面。
2. `error_kind` 目前只有形态级精度；`billing_rejected` 的确认值仍只在
   `billing_parked` 上。若观测面想直接显示"凭证失效"，读 park 事件即可。

## 八、第三层：探测"通过"与"没跑"长得一模一样（2026-11-10 上产后追查）

### 现场

`-32003` 路径已确认被走到（`turn_ended` 带 `error_kind: llm_failed`），停车开关也开着
（`AGENT_RUNNER_BILLING_PARK` 为空），但**从不 parking**，且两个 runner pod 上
`park/probe` 日志行均为 0。递归查下来是三层前提，前两层都通过了、第三层是坑：

| 层 | 判据 | 实测 |
|---|---|---|
| ① 分类器触发 | `e.code === -32003` 或形态命中 | ✅ 通过（`llm_failed` 即来自它） |
| ② pin 记录存在 | `#billingPins` 有该 key 且 `providerType === "openai-completions"` | 存疑（见下） |
| ③ 探测判定 | `/models` 返回 401/403 且 body 带 `INVALID_API_KEY` / `INSUFFICIENT_BALANCE` | ❌ 返回 **200** |

### 关键实测（在 runner pod 内直接跑）

```
provider 记录: id="finddata" type=openai-completions
               baseUrl=https://token.finddatatech.cloud/v1  hasKey=true
GET {baseUrl}/models  → status=200  bodyLen=13845（模型列表）
```

也就是说：**探针用的 runner 级 key 是健康的**，探测正确地返回 `pass`，正确地不停车。

### 真因

回合的 403 来自**另一把 key**——该 agent 描述符里钉的 `pk_43810d…`（已失效），
子进程用它；而探针用 runner 级 key。两者不是同一把，于是出现悖论式的组合：
**回合一直 403，探针一直 pass，永不 parking。**

而 pin 记录本该指向那把被钉的 key，但两个 pod 在 6 小时内
`own billing key` 与 `billing key fetch failed` 各 **0 行**——捕获块
（`if (keyRef != null && config.packsBaseUrl)`）本应二选一打一条，却一条都没有。

### 已知与未知

- **已知**：`AGENT_RUNNER_PACKS_URL` 已设且在 `config.js:200` 映射到 `config.packsBaseUrl`；
  provider 记录存在且可探测；`/models` 200。
- **未知（留给日志回答）**：为什么捕获块一行日志都没有——是 `descriptor.billing_key_ref`
  在该 spawn 分支上不存在，还是走了另一条 spawn 路径（`manager.js:1455` dsh / `1629` 另一
  分支 / `1797` pod 成员），还是 `#fetchBillingKeyValue` 静默返回了 null。

### 处置

1. **补可观测性**（本次提交）：`#probeBillingPin` 的每个 `undecided` 分支带 `why`；
   `#classifyBillingFailure` 在非 rejected 时 warn 一行（verdict + why）；
   `#recordBillingPin` 丢弃记录时 warn 一行，显式写出 `route.baseUrl` 与 key 是否缺失。
   **只加日志，不改任何判定**——判定本身是对的，缺的是"说清为什么"。
2. `wx-alpha` 已暂停（12:30:41 `paused`，12:31:10 配对 `agent_healthy recovered_as=paused`），
   燃烧停止。它的 key 仍失效，复活前必须先换键。
3. 本次演练的诚实结论：**任务 4.2 的「一个失败回合内出现 billing_parked」不成立**，
   但不是因为分类器坏了，而是因为探针与子进程用的不是同一把 key——这是设计上的一个
   盲点，不是判据问题。要真正闭合，得让 pin 捕获在前，或让探针用"子进程实际那把 key"。

### 教训（比结论更重要）

**「没有发生」和「发生了但没停」在日志上必须可区分。** 这次三层里每一层都是静默的：
分类器不触发没有日志、pin 缺失没有日志、探测 undecided 没有日志。三层叠起来，
一个每分钟失败一次的 agent 可以安静地烧掉几周。

## 9. 可观测性补丁上产记录（2026-11-10 13:0x）

### 出片

补丁提交 `f1de6a468` 推 gitee release 线后，快照线与镜像线各自前进了两次：

| 环节 | 事实 |
|---|---|
| 快照仓 | `scs001/platform-image-verify` main：`a33512d` = `gitee/release/cell-session-persona@6909f2ef9` 的全量快照（`f1de6a468` 为其祖先），`fecbee4` 再把被清理器摘掉的 `image-publish.yml` 带回 |
| 出片 | run `42758920708` → `hkccr.ccs.tencentyun.com/law-bench/platform:sha-fecbee4`；digest `0c97740…` → `1a17a88…`（内容真变了，不是空 tag） |
| 我先前那次推送 | `f2232f8` 被单车道队列 cancel 掉，随后 main 被整包快照覆盖——**不需要我的快照提交**，主线自带补丁。改镜像清单前先 `git show origin/main:… | grep 判据` 能省掉一次白推 |

### 部署

`fd-infra-deploy` `d052b88`（只改三个 runner 清单）→ gitee main → ArgoCD `all-services-prod`
selfHeal 自动应用，`agent-runner-c`（cheap-7）、`agent-runner-serving`（cheap-4）各 1/1 滚动完成。

**必须一起滚的原因**：停车判定住在 `agent-runner/manager.js`，而生产上它有两个宿主——
platform 容器里的进程内 worker-pool（`[worker-pool] spawned worker-1 for persona …`），
以及 `agent-runner-c/-serving` 部署（`node agent-runner/index.js`，服务 `packs-*` 的 a2a 面）。
两条车道都用同一张 `law-bench/platform` 镜像，但清单分开钉 tag，只滚一边等于只给一半的回合装眼睛。

runner 侧此前停在 `sha-eb20ffb`（真源 `5c3508c4e`），落后 release 线 133 个提交。这次前滚顺带带入
`57b101309`（出口闸读未定义 `options` 导致每个完成回合抛 `ReferenceError`）。**该 bug 不在
5c3508c4e 里**（`git merge-base --is-ancestor` 判定未部署），所以它是前滚拆掉的地雷，不是线上事故。

### 验收（在 pod 内 grep 自己的符号，不看注释）

| 载体 | BUILD-INFO baseCommit | `no billing pin recorded — probe disabled` | `failed a turn but NOT parked` |
|---|---|---|---|
| `platform-74884bdf6f` / platform | `6909f2ef9` | 1 | 1 |
| `agent-runner-c-7b586d99cb` / runner | `f1de6a468` | 1 | 1 |
| `agent-runner-serving-96f988654` / runner | `f1de6a468` | 1 | 1 |

三处容器重启后加载，所以是运行中的代码，不只是盘上的文件。日志显示两个 runner 正常服务
（9 / 20 个 pack，`poll` 循环无报错）。

### 仍未观测到的那一步

新加的 warn 只在「回合失败且不停车」时说话，而此刻系统接近空闲（30 分钟内 4 条回合迹象、
0 条失败），所以**没有活样本**。这不是没上产，是它按设计沉默——和 `flag-stalled-rhythm-agents`
的 4.2 一样，得等下一个真失败。任务 4.2 要闭合仍然需要那一步：让 pin 捕获发生在探针之前，
或者让探针用子进程实际持有的那把 key；在那之前，本补丁的作用是让下一次失败**自证原因**，
而不是让失败不再发生。
