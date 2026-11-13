## Why

`add-blueprint-llm-assertions` 与 `add-blueprint-judge-model-choice` 归档后，真跑迭代（台账 §15.89–§15.94）
在产线修了四处语义，实现已走在主 spec 前面：

1. **判据没跑成 ≠ 证据不足**（paas `20f304c3`）。主 spec 现文写「模型不可达、超时…一律归
   `insufficient-evidence`」。判决值确实不变，但两者处置方向相反：车道故障重跑即可，证据不足要改证据
   或判据。实现现在在审计件打 `laneError = { status, kind }`，界面分开显示「模型：未跑成（车道不可用）」。
2. **来源判定曾经撒谎**（paas `48addabc`）。主 spec 的落级场景把「部署默认配了、只是不在本 cell 名册」
   与「真的回落到名册首个」混为一谈。生产 40/41 个 cell 的 `llm-providers.json` 为空，此时走的是部署
   env 路由，**用的就是配的那个模型**，没有回落。旧实现却标 `judgeSource: "fallback"` + 「fell back to
   the first listed model」，使 `GET /api/blueprints/judge-default` 自相矛盾。
3. **证据缺集群身份**致 `llm-judged` 恒判不足证据。rubric 说「在试跑集群中」，证据却从不点名集群。
4. **模型输出尾噪声**（如多一个引号）致 3/8 解析失败被当证据不足；判定模型名常与路由名不同
   （`minimax-3.1-flash` 展示名 ≠ `minimax-m3.1-flash` 路由名），错名只会在车道层暴露成快失败 503。

另有本轮新增的两项能力需入册：**判据结果缓存**（只缓存 pass/fail，绝不缓存基础设施失败）与
**每 owner 日配额**、以及**部署默认判据车道可探测端点**。本 change 只补 spec，不改行为——
测试已覆盖（judge 28 条 / trial 10 条 / routes 21 条全绿），生产三态已真机实证。

## What Changes

- 三态判据需求：新增「车道故障与证据不足必须在审计件上可区分」的约束与场景；明确判决值不变。
- 来源判定需求：`judgeSource` 三分按「最终真正用了哪个模型」判，名册空走部署 env 路由归 `deployment`。
- 证据组装需求：试跑证据 SHALL 含集群身份（名称 + id）。
- 输出解析需求：尾随噪声 SHALL 能解析出判决；仍解析不出才归 insufficient-evidence。
- 成本闸需求：新增缓存与日配额两条约束（缓存只存 pass/fail）。
- 新增需求：部署默认判据车道可探测（`GET /api/blueprints/judge-default`）。

## Capabilities

### Modified Capabilities

- `fleet-blueprint-studio`: 模型判据断言的证据、审计、来源判定、成本闸语义细化；新增判据车道探针端点。

## Impact

- 仅 spec 文本。实现与测试已在 `20f304c3` / `48addabc` / `282ebf8f` 等提交中在产；
  `openspec validate --specs --strict` 不得新增失败。
