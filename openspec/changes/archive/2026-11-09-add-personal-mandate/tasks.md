## 1. 纯求解器与模型（无 IO，先行）

- [x] 1.1 在 `lib/personal-mandate.js` 实现 `normalizeMandatePolicy(raw)`：兼容扁平旧结构与多域新结构，输出统一 `{version, domains:{...}, defaultMode:'advise'}`；未知域名拒绝并返回结构化错误 —— 用单测覆盖「旧结构视作 ops」「多域原样」「未知域拒绝」三例
- [x] 1.2 实现 `resolveMandate({policy, domain, action, args, usage, principal})` 纯函数：返回 `{decision, tier, disclose, reasons[], mandateRef}`；不含任何 IO —— 单测穷举四档模式 × 五级风险，断言 `publish/destructive` 恒不降级
- [x] 1.3 实现额度与回落：额度耗尽或有效期过后自动降一档且只降不升，返回 `reasons:['quota_exhausted'|'expired']` —— 单测覆盖额度边界（第 N 条放行、第 N+1 条回落）与过期回落
- [x] 1.4 实现「不可撤销动作不得自动执行」规则：`reversible_until` 为 null 的动作被配置为 `act-notify/act-silent` 时回落 `draft`，且配置写入阶段即拒绝 —— 单测断言写入拒绝与运行时回落两个方向
- [x] 1.5 导出 `NON_DOWNGRADABLE` 常量并与 `lib/action-registry.js` 的风险常量放在同一模块边界内 —— 单测断言设置面选项生成函数对 `publish/destructive` 不产出自动档

## 2. 策略存储与迁移（等价性是硬门）

- [x] 2.1 扩展 `server/routes/fleets-db.js:1913-1966` 的 `normalizeDelegationPolicy`，接入 `normalizeMandatePolicy`，保留既有导出签名 —— 既有 delegate 相关单测全绿
- [x] 2.2 存量迁移读取路径：扁平结构 → `domains.ops`；写入一律 `version:2` 且迁移期双写 `ops` 扁平字段 —— 单测断言读旧写新后的结构形状
- [x] 2.3 编写等价性对照测试：同一组 `(item, policy)` 在「扁平旧结构」与「v2 结构」两条读取路径上跑 `routeForItem`，逐格断言路由结论相同；并断言舰队覆写里的缺省键不会被 DEFAULT 复活（cell=替换语义、fleet=合并语义）—— 该测试红则本 change 不可上线
- [x] 2.4 设置面读写端点支持域维度（沿用既有 `/api/fleets/delegation-policy` 路径族），未声明域默认 `advise` —— 接口测试断言未配置域不获得任何执行额度

## 3. 动作路径接入

- [x] 3.1 `lib/action-preflight.js:186` 的 `preflightAction` 增加委托状步骤（在既有凭据/目标检查之后），返回 `deny/advise/draft/execute` 结论 —— 单测断言既有检查顺序与错误文案不变
- [x] 3.2 `lib/action-executor.js:269` 的 `executeRegisteredAction` 消费 `resolveMandate` 结论：`draft` 入待放行队列、`act-notify` 执行后发通报、`act-silent` 只入日报 —— 集成测试覆盖三条路径
- [x] 3.3 通报与草稿面：`act-notify` 通报含动作、目标、影响面、可撤销截止时间；`draft` 草案可编辑可丢弃 —— 测试断言通报字段齐全、草案未放行时底层工具未被调用
- [x] 3.4 副驾路径隔离：副驾（只含读 + `propose_action`）不读委托状、恒走原确认档位 —— 单测断言副驾的 `write` 动作仍返回行内确认

## 4. 披露闸

- [x] 4.1 `lib/action-registry.js` 为对外发送/发布类条目补 `contentArgs` 声明；注册表加载时校验：对外类条目缺失 `contentArgs` 即 fail-closed 失败 —— 单测断言缺声明时加载报错
- [x] 4.2 披露校验在 `preflightAction` 中对 `contentArgs` 取**原文**逐项比对 `disclose_scope`，越界返回结构化越界项且不执行 —— 单测覆盖「越界拦截」「范围内放行」「多个参数部分越界」三例
- [x] 4.3 `read_scope` 落为读类动作的授权闸（`checkReadScope` + `resolveMandate` 的 read 分支）；记忆读面本身属独立 MCP 仓，跨仓接线记在 `add-principal-disclosure-gate` —— 单测覆盖「可读不可说」与「读范围外拒绝」两种组合
- [x] 4.4 连续越界计数进日报，避免静默失败 —— 测试断言越界 N 次后日报出现该域条目

## 5. 台账与撤销

- [x] 5.1 审计表加列 `mandate_ref/domain/mode/disclose_level/reversible_until/content_digest/revoked_at`（沿用既有 `ALTER` 迁移惯例）—— 迁移后既有查询不受影响，单测跑通既有审计用例
- [x] 5.2 受委托状驱动的执行写入上述字段；对外发言存摘要 + 目标，不存全文 —— 单测断言摘要与目标落库、全文不落库
- [x] 5.3 按域、按可撤销状态检索端点 —— 接口测试覆盖两种筛选
- [x] 5.4 撤销实现为受闸动作：窗口内可撤销并向下游发撤销信号，窗口过后拒绝 —— 测试覆盖「窗口内成功」「窗口过拒绝」两例，并断言撤销本身带审计

## 6. 设置面

- [x] 6.1 设置面四域配置（模式/动作范围/额度/有效期/两个 scope），初始全 `advise` —— UI 冒烟：新建 cell 打开设置面，四域均为 `advise` 且无额度
- [x] 6.2 「本域代理动作清单」读面：模式、披露层级、撤销状态、撤销入口 —— UI 冒烟：清单可筛可撤销
- [x] 6.3 不可降级与不可撤销约束在设置面如实呈现（`publish/destructive` 无自动档选项）—— UI 冒烟断言选项集合

## 7. 验收

- [x] 7.1 等价性对照测试与既有委托合同（首裁定局/越权 403/预算 429）全绿 —— `node --test` 相关用例集零失败
- [x] 7.2 端到端：新 cell 未配置 → 代理只给建议；配 `draft` → 产出草稿不发送；配 `act-notify` → 执行并通报、窗口内可撤销 —— 路由级集成测试 + `e2e/settings-mandate.spec.js` 浏览器冒烟（真 PUT + 刷新读回）
- [x] 7.3 披露端到端：配 `read_scope` 含人事、`disclose_scope` 不含人事 → 起草对外回信被拦并给越界项 —— 单测 `checkReadScope`/`checkDisclosure` + 真实注册表条目（`facet.pack.publish`）的出站拦截断言
- [x] 7.4 回滚演练：把结构写回扁平 `ops`，旧读取路径仍工作 —— 演练记录留档
