# Design: add-tool-scope-register-shadow

## D1 — 接缝实证（先于设计成立的先决事实）

上游 #9385 回帖（argszero）给出的接缝：`Reflect.get(ctx.get('tools'), Symbol.for('cordis.original'))`
解出共享的原始 ToolRuntime 实例；在实例上写 own property `register` 即影子化原型方法，任何
view 通过 `ctx.tools.register(...)` 的注册都会经过包装器。本仓在**生产 pin 的确切组合**
（@deepseek-ai/dsh-tools 0.1.1-rc.2 + @deepseek-ai/cordis 4.0.4 + dsh-system-prompt，
即 package.json 全队版本）上以两轮探针实证 14/14：

1. view/全局注册均被 own-prop 影子拦截（含「另一 view」的注册路径——mcp-client 的注册
   形状）；
2. 丢弃分支下越权 leaf **不出现在 `schemas()`**（never-registered 语义、上下文节省真实）；
3. 非 MCP 名（`bash` 等）与未映射服务器直通；
4. 丢弃返回的 disposer 为惰性函数（mcp-client 持有它 dispose 时无害）；
5. **receiver 保留**：cordis 以调用方 view 为 receiver 调转发方法，包装器内
   `protoRegister.call(this, …)` 的 `this.ctx` 携带调用方 scope（`scopeOf` 断言相等），
   scoped 注册不泄漏全局层——这是采纳该接缝的最大风险点，已证伪；
6. `delete inst.register` 还原原型方法（HMR/卸载纪律）。

## D2 — 三层不对称语义（guard / shadow / restrict）

| 层 | 时机 | 语义 | 失效模式 |
|---|---|---|---|
| guard | 调用期 | 硬拦（字符串匹配，永不 throw） | 无（漂移免疫） |
| **shadow（新）** | **注册期** | **越权不进注册表**（每代生效） | 接缝缺失/异常 → 透传，退回两层 |
| restrict | 组合期 | roster 掩码（best-effort） | 未知名 throw → 降级 guard-only |

影子装在 preset 桥 `apply()`（插件启动期，`installMcpToolGuard` 旁）。要点：

- **顺序前提**：桥行须先于 mcp-client 行装载，否则错过首代（argszero 明确警告；插件无法
  注销他人工具）。runner 侧 `agent-runner/compose.js` patchPaths 已是
  `[presets, skills, mcp, …]`；**web cell `dsh-bridge.js patchArgs` 现为
  `[mcp, skills, presets, …]`，本 change 对调为 presets 先**。安全性：presets 补丁插入的
  `agent-presets`/`platform-sdk-server` 两行不依赖 mcp 行（tools 服务来自 base bundle，
  桥在 apply() 用 `ctx.get('tools')` 与 mcp 无关）；两补丁无 id 交叠。对调后两队一致。
- **过滤器纪律**：与 guard 相同，每次注册时重读 `readMcpToolFilter()`（注册稀有：boot +
  resync，文件读开销可忽略；HMR 的 filter 变更无需重启即辖后续代）。
- **透传即底线**：包装器任何内部异常（filter 读失败不计——那返回 null=不过滤）一律
  `protoRegister.apply(this, arguments)` 原样透传；接缝形状意外（`cordis.original` 缺失、
  非 ToolRuntime）则**不安装**，静默退回两层。性能/行为不劣于现状是硬约束。
- **scope 保留**：透传与丢弃分支都经 `protoRegister.call(this, …)`（D1-5 实证 receiver
  正确）；丢弃分支返回 `() => {}` 惰性 disposer。
- **还原**：经 `ctx.effect(() => { …安装…; return () => { delete inst.register } }, label)`
  ——fiber dispose/HMR 时还原原型；桥自身重启重装即恢复。

## D3 — 什么不做

- 不做计数/报告面（unusedLeaves 等）——发布门已有对拍与漂移防线，运行期静默；
  guard 的拒绝文案仍是唯一可观测面。
- 不替换 restrict（影子生效时其 deny 集自然为空，近似 no-op；影子降级时它是 roster 收窄
  的兜底）——三层共存，代码各 ~30 行，风险面互不耦合。
- 不动 dsh-mcp-client 包本身、不 fork、不等上游 allowedTools（#9385 已递交；上游落地后
  本影子整体删除换原生字段，D1 探针测试同时作为「上游版本升级接缝失效」的哨兵）。
- public-leaf 匹配限制（raw name 不合规时 public 形态带 12-hex 后缀）与现状 guard/restrict
  完全同界——不新增边角，发布门对拍的是 registry tool_list 真值，越权声明在发布时即 fail。

## D4 — 测试策略

1. `scripts/test-tool-scope-bridge.mjs`（stub 面）补影子单元：drop/直通/异常透传/惰性
   disposer/还原；stub 的 inst 形状 `{ [Symbol.for('cordis.original')]: rawInst }`。
2. 新增 `scripts/test-tool-scope-register-seam.mjs`（**真 cordis**）：以仓库依赖起
   `new Context()` + systemPrompt + ToolRuntime，移植 D1 两轮探针的全部断言——这是接缝的
   活体哨兵（上游升级破接缝时 CI 红）。
3. 既有 e2e 三件（聚焦收窄/兼容回归/漂移兜底）不改编——它们从外部行为验证，三层对它们
   透明；patchArgs 顺序对调由 dsh-bridge 现有单测覆盖（order 数组断言更新）。
