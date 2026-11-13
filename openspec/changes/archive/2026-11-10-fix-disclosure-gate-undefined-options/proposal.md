# fix-disclosure-gate-undefined-options

## Why

`1ac6bb6c5`（`feat(disclosure): runner 侧出口闸`）在 `agent-runner/manager.js` 的成功路径上
加了对外披露闸，写的是：

```js
const gateDomain = options?.mandateDomain ?? entry?.mandateDomain ?? null;
```

但 `turn(entry, sessionId, text, { kind, onDelta, onAsk, delegationDepth, visitorScope })`
**从来没有 `options` 这个参数**。`options` 不是"值为 undefined"，而是**未定义标识符**，
所以每次走到这一行都抛：

```
ReferenceError: options is not defined
    at ChildManager.turn (agent-runner/manager.js:1005:28)
```

这一行在 `child.turn()` 成功之后、返回结果之前，也就是说**每一个正常完成的回合都会抛**。
它不是边界情况：`scripts/test-agent-serving-billing-park.mjs` 单跑 **3/3 红**，
四条驱动真实回合的用例全部是这个 ReferenceError。若该提交已部署，表现就是"所有对话回合
直接失败"——而且失败形态和"模型/上游坏了"极像。

那个提交自述"37 例 runner + 172 例全绿"，说明它的验证集没有覆盖"回合真正跑完"这条路径
（跑的用例要么在更早处结束，要么没走到成功分支）。

**它是在我这轮 120 文件并发对照里被当成"并发新增红"抓到的**：串行批次在 rebase 之前跑的，
该文件是绿的；rebase 把 `1ac6bb6c5` 带进树里之后，并发批次里它红了 4 条。差别不是并发，
是树里多了这个提交——差集把我引到了真因上。

## What Changes

把闸的三个输入加进 `turn()` 的解构参数（`mandateDomain = null`、`declaredSources = []`、
`channelRevocable = false`），并把三处 `options?.X` 改成读这三个局部量。

语义保持不变：

- 现网所有部署把 `mandateDomain` 声明在 **agent entry** 上，所以 `mandateDomain ?? entry?.mandateDomain`
  仍按文档工作（`docs/upgrade-personal-agent-2026-11-09.md`：被服务的 agent 条目上声明）。
- 逐回合覆盖的通道保留下来（同一 entry 走两条车道的调用方可用），只是不再读一个不存在的变量。
- 失败关闭不变：`mandateVerdictClient` 为 null 时对外车道仍拒绝发出。

## Capabilities

（无 —— 修的是未定义标识符，闸的判据与边界都没动。）

## 非目标

- **不改闸的判据**：`#mandateVerdict` 的失败关闭、`-32013` 的流式划界、抛错而非返回空文本，
  都是 `1ac6bb6c5` 的裁决，本单只让它**能被执行到**。
- **不改 `resolveMandateContext`**：`server/routes/actions.js` 那条链路是 self-serve 防护，
  与这里的 runner 侧闸是两回事。

## 验证

- `node --test --test-timeout=60000 scripts/test-agent-serving-billing-park.mjs`
  修复前 **3/3 红**（ReferenceError），修复后 **14/14 绿**，2 秒完成。
- 覆盖 `turn()` 的其余套件见 tasks 3.2。
