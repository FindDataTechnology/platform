# Design: intent-onboarding

## D1 — 问卷面形态

`ChatWelcome.tsx` 顶部条件面板（`profile empty ∧ ¬skipped` 时渲染），角色卡多选（1-3，就绪清单来自 recipe 数据）+ 待办注记输入 + 跳过链接。与 `OnboardingTour` 融合：tour 第一步"选专家"的 coach-mark 改锚问卷面板（面板存在时），面板消失后回落既有锚点——tour 逻辑不动，只换锚。提交后同一位置切换为**一键确认清单**视图（见 D3），激活后清单淡出、欢迎提示卡已随新默认专家变化（既有机制零改动）。

## D2 — REST 与原子性

- `GET /api/onboarding/profile`（self）：档案 + 就绪角色清单（服务端算，客户端不判就绪）。
- `POST /api/onboarding/answers`（self）：`{ roles: slug[1..3], note?: string, skipped?: boolean }`。原子动作：写档案 → 经 role-system 指派存储写主/副角色（**self 通道硬限制：只写 roles 字段，永不触 admin 位**；托管走 gateway 指派存储的内部写入，与 admin 面同库）→ 返回装配清单（provisioning plan）。
- `POST /api/onboarding/provision`（self）：按 plan 执行：逐 pack 走既有订阅内部函数（准入校验同面）+ 幂等（已订阅跳过）；设默认专家（写既有选中专家持久化）；角色→布局由 `layout-configuration` 解析链自动兑现，本端点零布局代码。
- 部署预置：env `ONBOARDING_DEFAULT_ROLES` / `ONBOARDING_DEFAULT_NOTE`（stored > env > empty，同族解析序）。

## D3 — 装配清单的准入过滤

plan 生成时逐 pack 校验有效准入集（role-system D4 规则）：不可装项剔除、`unavailableNote: true` 标记；市场关（`packMarketplace=false`）→ pack 段整体为空，清单只余"工作面与默认专家"两行。前端只渲染服务端 plan，不做二次判断。

## D4 — recipe 数据

`packages/core` 静态 const，带 `version`：

```jsonc
{ "version": 1, "ready": ["legal", "stock", "economic"],
  "recipes": {
    "legal":     { "packs": ["legal-contract", "legal-case"], "defaultExpert": "legal.contract-officer", "prompts": "legal-contract", "layoutPreset": "legal" },
    "stock":     { "packs": ["stock-research"], "defaultExpert": "analysts.industry", "prompts": "stock-research", "layoutPreset": "simple" },
    "economic":  { "packs": ["china-macro"], "defaultExpert": "analysts.industry", "prompts": "china-macro", "layoutPreset": "simple" } } }
```

`layoutPreset` 键在 layout-configuration 的预设空间里声明（`legal`/`simple` 等由该案出厂+部署预设承载；此处只是键引用，不定义预设内容）。pack id / expert 引用对不上时按缺项降级（D3 同规则），不阻塞。

## D5 — 只加不减与幂等

订阅幂等靠既有安装态检查；默认专家重设为同值=无操作；角色重写允许（重答换主角色）。任何路径不写卸载。provision 失败重试安全（逐项独立，无事务回滚需求——单项失败在响应中标注，其余成功项保留）。

## D6 — 测试

- e2e：首入问卷出现→选 legal→清单→激活→专家默认合同审查官+提示卡随包+布局按角色解析；跳过不再现；重开换 stock→布局/专家切换、legal 包仍在；非就绪角色不进问卷；市场关部署清单退化为两行；provision 幂等（二次激活零变化）。
- 单测：answers 原子性（档案+角色同写或同不写）、self 通道永不写 admin、plan 准入过滤矩阵。
