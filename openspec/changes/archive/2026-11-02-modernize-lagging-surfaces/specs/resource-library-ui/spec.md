# resource-library-ui Delta Spec

## ADDED Requirements

### Requirement: 资源面的状态词汇与破坏性确认

`/resources` 的所有状态徽章 SHALL 使用状态词表 token（如 tier 徽章的「正典」高亮走 `status-waiting`，而不得手写 `amber-500` 等具名色阶）；删除资源 MUST 经主题化确认对话框（危险变体、焦点落取消、Esc 等同取消），MUST NOT 使用浏览器原生 `confirm()`。

#### Scenario: tier 徽章走词表

- WHEN 资源条目渲染 draft/stable/canonical 三档 tier 徽章
- THEN 颜色来自主题 token（canonical 为 warning 系高亮），标签文字始终在场（颜色永不单独表意）

#### Scenario: 删除须确认

- WHEN 用户点击资源的删除按钮
- THEN 弹出主题化确认框，焦点落在取消侧；确认后才执行删除，且不弹出浏览器原生 confirm

### Requirement: 图表系列的序列色阶

图表渲染（EChart）SHALL 在 option 未自带色板时，按序应用 `series-1..4` 序列色阶（运行时从主题 token 解析，随暗亮主题联动）；option 自带 `color` 数组时数据优先。单系列图表因此呈现为灯色。

#### Scenario: 多系列不越阶

- WHEN 一张图表含两个及以上数据系列且未自带色板
- THEN 系列颜色取自 series-1..4 顺序；暗亮主题切换后重新解析生效

（实施备注：视觉评审在生产环境观察到的「配额计量 tile 彩虹」不在本分支的 `/resources` 面上——本分支该页为资源库（图表/文件列表）。若后续引入配额 tile，按 DESIGN.md 序列色阶与状态词表执行，并回补本能力的对应需求。）
