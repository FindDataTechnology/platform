# app-center Delta Spec

## ADDED Requirements

### Requirement: 发现面卡片的在场信号呈现

`/apps` 的每个产品卡 SHALL 以平台自身的状态语义承载「真实在场信号」：连接状态用状态词表（`status-running` 已连接 / `status-paused` 未连接 / `status-failed` 连接失败）配文字标签呈现，可用性如实标注（不可用须显式文案而非静默隐藏）；卡片 MUST NOT 以品牌色图标墙作为主要视觉主张，蓝色的使用 MUST 限定在唯一主操作与活体信号上。搜索与筛选控件 SHALL 位于页头之下，页头标题 MUST 为视口第一读点。

#### Scenario: 连接态非色盲单通道

- WHEN 某产品已连接、另一产品未连接
- THEN 两卡分别以 running 与 paused 状态胶囊呈现，且胶囊各带可读文案，色觉障碍用户仅凭文字即可区分

#### Scenario: 页头不被筛选控件压过

- WHEN 用户打开 `/apps`
- THEN 页面标题先于搜索/筛选控件出现，标题是该视图唯一的一级读点
