# Tasks: add-cron-automation-parity

## 1. 调度模型（服务端）

- [x] 1.1 job 记录扩展可空字段 `interval{number,unit,phase?}`、`maxRuns`、`runs`（读侧 kind 判序：cron 优先、interval 其次，缺字段=旧语义），`jobs.json` 原子持久沿用；单测断言旧记录读取零改写
- [x] 1.2 调度器认 interval kind：发生序列=锚点+k×步长（锚点=创建接受时刻，服务端时钟），day/week 级带 phase 按 job tz 算日历相位；kind 全矩阵单测（cron/interval/once 绝对/once 相对 × 暂停/恢复/重启恢复）绿
- [x] 1.3 相对一次性落服务端锚定：create 收 `delayMinutes`（正整数≤525600）→ 解析成绝对 `when` 持久；过期/非正结构化拒绝；单测含「重启后不二次锚定」
- [x] 1.4 maxRuns 收口：完成执行计数（run-now/重跑完成计入）、达 cap 自动 `completed` 停火；update 把 cap 降到已跑数以下即刻 completed；单测三例

## 2. 管理通道（WS + MCP）

- [x] 2.1 `cron_*` WS 面新增 update 消息（id + name/prompt/schedule/maxRuns 子集，保 id/历史/暂停态，改 schedule 重算 next-run，目标绑定拒改），与 `cron_update_failed` 类错误事件；合同测试沿用既有 cron 套形态
- [x] 2.2 `server/cron-mcp.js` 增 `cron_update` 工具 + create 参数面扩展（delayMinutes/interval/maxRuns），工具描述钉「相对延迟别自算时刻」纪律；非法组合（once+maxRuns、cron+interval）指名拒绝；工具面合同测试绿
- [x] 2.3 list 输出带已跑 x/N 进度与 interval 人读形态；dsh 合同套相应断言更新

## 3. Web 表单与执行史面

- [x] 3.1 `TasksPage.tsx` 表单增：相对一次性输入（「N 分钟后/N 小时后」，预览近似落点、提交只发延迟）、every-N interval 构造器（数值 1–200×单位枚举+可选 phase）、maxRuns 可选字段；既有模板/NL 预填与 assist 行为不回归
- [x] 3.2 自然语言输入支持相对短语（「20 分钟后」解析进相对模式）；解析失败回退手工控件条款沿用；单测补两短语例
- [x] 3.3 任务行增「编辑」动作（重开表单预填当前值，保存走 update 通道，保历史与未读态）与执行史展开区（时刻/结局/耗时/tokens/missed 补跑标记，纯读 history；加载失败不拖列表内联区）；组件测试覆盖编辑保 id、missed 标注两场景
- [x] 3.4 `lib/cron-text.ts` interval/相对/maxRuns 人读文案五语言（locale 完整性门绿）；已跑 x/N 渲染

## 4. 门与收口

- [x] 4.1 全量回归：`test:unit` + cron/调度合同套 + e2e 相关条绿；`openspec validate` 绿；判红两分法纪律适用（flaky 仅已知项）
- [x] 4.2 真机走查挂账（台账登记）：滚版后实测——「8 分钟后」上眼、every-40-days 列出短语、maxRuns 收口、编辑保历史四眼见
