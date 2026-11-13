## MODIFIED Requirements

### Requirement: 浏览器产物按 cell 可读性路由

共享服务产生的产物（截图、下载、页面导出）SHALL 落进发起该调用的 cell 可读的位置，并以该 cell 既有的文件可见性语义对外提供；调用未指定文件名时的自动命名产物 SHALL 同样如此。一个 cell SHALL NOT 因共享服务而能读到另一 cell 的浏览器产物。

归属判定 SHALL 依据「本次调用之前共享根目录里没有这个文件名」这一事实（调用开始前的名字快照），SHALL NOT 依据墙上时钟与文件时间戳的比较：文件系统会把 mtime 向下取整到自己的 tick（Linux 常见 1–10ms，某些 overlay/tmpfs 更粗），因此一次快速调用写下的自动命名文件可能带一个早于调用起始时刻的 mtime，从而不被认领、留在共享根目录里，被下一个 cell 的调用顺手扫走——那正是本条禁止的跨 cell 泄漏。时间戳比较 MAY 仅作为拿不到快照时的退路。

#### Scenario: 截图落在发起方 cell
- **WHEN** cell A 的会话要求截图且未指定路径
- **THEN** 该文件出现在 cell A 的可读文件面并可经既有文件接口获取

#### Scenario: 跨 cell 读不到产物
- **WHEN** cell B 尝试按其文件接口列举或获取 cell A 的浏览器产物
- **THEN** 该产物对 cell B 不可见

#### Scenario: 粗粒度文件时间戳不改变归属
- **WHEN** 一次调用写下的自动命名产物的 mtime 被文件系统取整到早于该调用起始时刻
- **THEN** 该产物 SHALL 仍被认领进发起方 cell 的目录
- **AND** 共享根目录 SHALL NOT 残留该文件（否则它就等着被下一个 cell 扫走）
