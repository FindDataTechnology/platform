## ADDED Requirements

### Requirement: 自由文本槽位单行呈现与时间线岗位过滤

画布节点卡与检查器中的 KPI 槽位值 SHALL 单行呈现:值超出可视宽度的部分 SHALL 以省略号截断,完整文本 SHALL 可通过悬停提示读取;槽位容器 SHALL NOT 横向溢出撑破卡片。执行时间线 SHALL 提供按根岗位过滤:选中岗位后仅呈现该岗位的 run,无匹配时呈现诚实的空态文案(区别于「尚无任何 run」)。

#### Scenario: 长文本不撑破卡片

- **WHEN** 某岗位把整段散文写入 KPI 槽位
- **THEN** 节点卡宽度保持设计尺寸,该槽位显示截断值,悬停可见全文

#### Scenario: 按岗位过滤

- **WHEN** 时间线列出多岗位 run 时选中某岗位
- **THEN** 仅呈现该岗位的 run;清空过滤恢复全部

#### Scenario: 无匹配空态

- **WHEN** 选中岗位在本页无 run
- **THEN** 呈现「本页无该岗位的 run」而非「尚无任何 run」
