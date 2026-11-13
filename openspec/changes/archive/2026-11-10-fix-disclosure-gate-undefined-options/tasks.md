# Tasks — fix-disclosure-gate-undefined-options

## 1. 定位

- [x] 1.1 抓到抛点
  - 实证：`scripts/test-agent-serving-billing-park.mjs` 单跑 3/3 红，栈顶是
    `ChildManager.turn (agent-runner/manager.js:1005:28) ReferenceError: options is not defined`
- [x] 1.2 确认 `options` 不是"值为空"而是未定义标识符
  - 实证：`turn(entry, sessionId, text, { kind, onDelta, onAsk, delegationDepth, visitorScope })`
    的签名里没有它；全文件再无其它 `options` 绑定
- [x] 1.3 确认它在成功路径上（不是边界分支）
  - 实证：该行位于 `child.turn()` 返回之后、结果返回之前，故**每个正常完成的回合**都会抛
- [x] 1.4 确认引入提交与为何其自测没拦住
  - 实证：`1ac6bb6c5`；其提交信息称"37 例 runner + 172 例全绿"，说明验证集没覆盖
    "回合真正跑完"这条路径

## 2. 修

- [x] 2.1 `turn()` 解构参数补 `mandateDomain = null` / `declaredSources = []` /
      `channelRevocable = false`
- [x] 2.2 三处 `options?.X` 改为读上述局部量；保留 `entry?.mandateDomain` 回退
      （现网把车道声明在 agent entry 上）

## 3. 验

- [x] 3.1 `test-agent-serving-billing-park.mjs`：修前 3/3 红 → 修后 14/14 绿（2s）
- [x] 3.2 覆盖 `turn()` 的其余套件
  - `test-agent-runner.mjs` **73/73 绿**（74s）
  - 出站闸与委派/舰队：`test-outbound-gate` / `test-outbound-no-bypass` /
    `test-agent-delegation-a2a` / `test-fleet-core` **45/45 绿**
  - `test-agent-serving.mjs` 5 条红，全是 deploy 阶梯超时（各撞 90s 上限），**与本单无关**：
    这些用例不走 `turn()`，且该文件自己的注释就记着这是主线 978b05088 的老问题
    （"3.2/3.3 author deploys a version … (335360ms)"）。已作为 unit 车道的独立待办记在
    `slim-unit-suite-runtime`
- [x] 3.3 `biome check agent-runner/manager.js` 无告警
