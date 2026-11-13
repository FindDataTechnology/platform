## MODIFIED Requirements

### Requirement: 深链契约

Studio SHALL 支持 `?new=agent`（一次点击新建）、`?doc=<id>`（打开指定文档）、`?fork=<id>`（fork 深链）；深链 SHALL 在谦面域下解析。宿主（谦面薄壳）SHALL 把其地址栏的深链参数原样转发给 Studio 的局部路由，且 Studio 内部导航产生的文档切换 SHALL 不改变宿主的顶层视图地址（`#/studio` 保持为唯一顶层 hash）。

#### Scenario: 深链直达文档

- **WHEN** 访问 `?doc=<id>`
- **THEN** 三栏工作区打开该文档并同源高亮

#### Scenario: 宿主转发深链

- **WHEN** 宿主的 hash 形如 `#/studio?doc=<id>`，其中未知参数被丢弃
- **THEN** Studio 以该 `doc` 参数挂载并打开对应文档，宿主顶层视图仍为创作面

## ADDED Requirements

### Requirement: 嵌入宿主的导航必须真实可达

Studio 被谦面薄壳嵌入时，视图内的每一个导航控件 SHALL 要么在宿主提供的局部路由表内解析，要么以真实外链指向壹座对应页面；SHALL NOT 呈现指向宿主不存在路由的控件——静默无操作的按钮视为缺陷。宿主 SHALL 为返回类动作提供域内落点，为运行域动作（集群/团队承接）提供带 SSO 的外链。

#### Scenario: 返回动作落到域内

- **WHEN** 创作者在嵌入态下点击 Studio 的返回控件
- **THEN** 视口回到宿主的智能体市场视图，且不产生无匹配路由的空渲染

#### Scenario: 跨域动作是真外链

- **WHEN** 创作者在嵌入态下触发集群或团队承接类动作
- **THEN** 浏览器以新目标打开壹座对应页面，URL 可复制、可分享

#### Scenario: 不存在静默无操作

- **WHEN** 嵌入态下任意导航控件被激活
- **THEN** 要么宿主视图发生变化，要么浏览器发生了导航；两者皆无时的控件不得渲染
