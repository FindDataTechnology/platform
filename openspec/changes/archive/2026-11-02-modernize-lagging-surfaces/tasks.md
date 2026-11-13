# Tasks: modernize-lagging-surfaces

> 红线：Memory / Agents / Fleets 三面分别被 `add-knowledge-memory-surface`(10/13)、`add-agent-builder-hub`(12/14)、`add-teams-hub-formation-board`(9/11) 占用，**三支归档前不得动同名文件**。本轮先做 Apps / Zhiyu 首页 / Resources 三面（无在途冲突）。

## 1. Apps 发现面（`AppCenterPage.tsx`）

- [x] 1.1 页头经 `PageShell` 归位（标题第一读点、搜索/筛选下移），卡片改用 `Card` 原语。验证：tsc ✓ + PageShell 补 rest-props 透传 data-testid。
- [x] 1.2 卡片在场信号：连接态改 `StatusPill`（running/paused/failed + 文字），可用性如实标注（不可用显式文案）。验证：tsc ✓、源码无自绘胶囊（emerald/amber 映射表已删）。
- [x] 1.3 去模板脸：品牌色图标墙降为统一色系字形/图标体系，蓝色收敛到唯一主操作。验证：实施发现本分支 Apps 卡本就是单色 Lucide 图标砖（生产旧图的多彩观感来自旧部署），仅需收敛链接蓝色——已达成。
- [x] 1.4 design-lint 该文件债基线收紧。验证：AppCenterPage 条目已从基线消失（named 8 → 0）。

## 2. Zhiyu 首页（`ZhiyuPage.tsx`）

- [x] 2.1 删渐变英雄区与多余蓝灯：仅保留唯一主操作。验证：实施发现本分支 ZhiyuPage 无渐变英雄区（生产旧图的多灯观感来自旧部署）；主操作唯一（创建按钮入 PageShell actions）。
- [x] 2.2 标题/输入主次归位（标题第一读点）。验证：PageShell 结构保证标题先行。
- [x] 2.3 空间列表条目改 `Card` + `StatusPill`（active→running / ended→paused，带文字），空态改 `EmptyState`，不可用态改 `ErrorState`+重试。验证：tsc ✓、zhiyu 测试 16/16、lint 该文件 named 4→0。

## 3. Resources 资源库面（`ResourcesPage.tsx`；实施发现：本分支该页为资源库而非生产版的配额计量面——按实际面修真）

- [x] 3.1 tier 徽章走状态词表：canonical 的 amber 高亮改 `status-waiting` token（颜色永不单独表意，标签在场）。验证：tsc ✓、lint 该文件 named-color 3→0。
- [x] 3.2 删除改主题化确认：`window.confirm` → `ConfirmDialog`（danger 变体、焦点落取消）。验证：tsc ✓、lint native-confirm 1→0。
- [x] 3.3 图表序列色阶：EChart 在 option 未自带色板时按序应用 `series-1..4`（运行时经探针元素从主题 token 解析 `var(--color-series-N)`，暗亮联动；数据自带色板时数据优先）。验证：chart 相关测试 64/64、palette 门 5/5、EChart hex 债零增量（探针方案避免 hex 镜像）。

## 4. 挂账面（等归档后开工，本轮不动）

- [x] 4.1 Memory tier 徽章词表化（canonical amber→status-waiting token；分层结构需求随 `add-knowledge-memory-surface` 已归档的主 spec 承载，本单只还色彩债）。验证：tsc ✓、lint MemoryPage named 3→0。
- [x] 4.2 Agents 终止钮 token 化（bg-red-600→destructive-deep 填充步）；头像纪律在 builder-hub 归档时已由其四区承载（v3 复评：单灯、无孤儿色）。验证：tsc ✓、lint AgentsPage named 2→0。
- [x] 4.3 Fleets hub 收灯+确认替换：EDGE_STYLES 六类边徽章词表化（dispatch=灯、handoff=waiting、其余中性，文字承载分类）、design.on/implicit 派发蓝→灯、模型回退 amber→waiting token、两处 window.confirm（解散/归档）→ConfirmDialog(danger)。验证：tsc ✓、fleet 相关测试绿、lint FleetsPage named 21+confirm 2→全部清零。

## 5. 合闸

- [x] 5.1 门：`check:locales`（零新串）✓、`web:build` ✓、`tsc --noEmit` ✓、定向测试（app-center 19/19、zhiyu 16/16、chart 64/64、palette 5/5、design-lint 14/14）✓、`design-lint` 全量绿且基线收紧（named 210→194、confirm 15→14；Apps/Zhiyu/Resources/EChart 四文件债清零）。
- [x] 5.2 视觉复评：本地实例（DB_PATH 临时库）五面截图过子代理两轮判读。第一轮逮两处真缺陷——Apps 卡 12 块装饰蓝图标砖（违灯纪律）、Zhiyu 错误分支无页题——当场修复（图标砖改中性 muted 砖、错误态也走 PageShell 保页题）；第二轮 apps-light/apps-dark/zhiyu-light 全部 **fixed**，resources 暗/亮两态首轮即 **pass**。0 pageerror。【终轮补充：解锁三面（memory/fleets/agents）第三轮判读全部 **pass**（memory/fleets/agents 空库形态下体系一致、无孤儿色、页题先行；tier 徽章/边徽章/终止钮的具体规则在空态不可见，由 lint 零债+tsc 兜底）】
