## MODIFIED Requirements

### Requirement: Tabs 键盘与角色契约

Tabs 原语 SHALL 以 `role=tablist`/`role=tab`/`aria-selected` 呈现，方向键在 tab 间移动焦点、Home/End 跳首尾，激活态 SHALL 以 `aria-selected=true` 标注。

产品内**每一处页签条** SHALL 由该原语渲染，MUST NOT 再有手搓的 `role="tablist"` + 类名活动态实现：分散实现丢掉的不是外观一致性，而是键盘可达性（方向键不换页、Home/End 不跳首尾、无 roving tabindex），对只有键盘的用户等同于禁用。活动态的判据 SHALL 是 `aria-selected`，MUST NOT 由某个颜色类（如 `border-primary`）承担——类名是外观细节，语义属性才是契约。

既有 testid 契约（如 `*-tab-<slug>`）SHALL 通过原语的 `itemProps` 注入保留，MUST NOT 因为收编而改名或消失。

#### Scenario: 方向键换页

- WHEN 焦点位于任一 tab 且按下 ArrowRight
- THEN 焦点移至相邻 tab 且其内容可见，`aria-selected` 随焦点更新

#### Scenario: Home 与 End 跳首尾

- WHEN 焦点位于中间某个 tab 且按下 Home（或 End）
- THEN 焦点落到首个（或末个）可用 tab，内容随之切换

#### Scenario: 每一处页签条都走原语

- WHEN 在 `web/src` 里检索 `role="tablist"`
- THEN 除 `components/ui/tabs.tsx` 自身外没有第二处手写实现

#### Scenario: 活动态由语义属性承担

- WHEN 任一页签条的选中项被检查
- THEN 它带 `aria-selected="true"`，且其样式不依赖 `border-b-2`（2px 彩色边）表达选中

#### Scenario: 收编不改公开锚点

- WHEN 某页面签条从手搓迁到原语
- THEN 其既有 `data-testid`（如 `extensions-tab-market`、`board-tab-<name>`）逐字保留，引用它的 e2e 无需改选择器即可定位
