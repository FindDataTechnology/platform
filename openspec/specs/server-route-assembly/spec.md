# server-route-assembly Specification

## Purpose

保证「实现存在、导出存在、测试绿、装配没了」这种塌方在合并前就被抓住。判据是静态的：从三个
可部署入口（cell `server.js` / 网关 `gateway/index.js` / 谦面宿主 `facet/index.js`）出发求相对
import 的可达集，再在可达集内找每个导出的路由注册函数的调用点。只被测试脚本自己 import 再自己
register 的模块不算装配。

不挂载的合法情形进带理由的豁免基线（`scripts/route-assembly-baseline.json`），拒绝通配与
目录级条目——行内豁免注释会在文件被整份替换时一起消失，那正是本能力要防的失败形状。

## Requirements

### Requirement: 路由族的装配可达性可判定

服务端 SHALL 保证：`server/routes/**` 与 `server/archive/**` 中导出的每一个路由注册函数
（`register*Routes` / `create*Routes`，下称「路由族」）在生产装配的可达集内存在至少一个调用点。

可达集 SHALL 定义为：从三个可部署入口 —— `server.js`（cell）、`gateway/index.js`（网关）、
`facet/index.js`（谦面宿主）—— 出发，递归跟随相对 import 能够到达的全部源文件。
判定 SHALL 在可达集内进行，而不是只在入口文件本身；装配存在两跳以上的合法路径
（例如 `facet/index.js → studio.js → blueprints.js`）。

测试脚本、脚本化夹具、`dist-opensource/` 快照与 `docs/` 下的原型 MUST NOT 计入可达集。

#### Scenario: 多跳装配算作已装配

- WHEN 某路由族由入口文件间接挂载（入口 import 了中间模块，由中间模块调用注册函数）
- THEN 该路由族判为已装配，闸保持绿

#### Scenario: 缺失装配时构建红并点名

- WHEN 某路由族在实现文件里导出，且可达集内没有任何调用点，也不在豁免基线里
- THEN 装配闸以非零退出码失败，逐条输出 `文件 → 符号`，使修复者不必再猜
- AND 输出不包含任何已装配的符号

### Requirement: 豁免必须带理由且不可批量

一处路由族若确实不应挂载，SHALL 登记在带理由的豁免基线
（`scripts/route-assembly-baseline.json`）。每条 SHALL 含 `path`、`symbol`、`reason`、`date`
四个字段，且 MUST NOT 以通配、目录级或前缀形式批量豁免。

#### Scenario: 豁免缺少理由

- WHEN 某条豁免条目缺 `reason` 或 `date`
- THEN 闸报红并指出该条目

#### Scenario: 通配豁免被拒

- WHEN 某条豁免条目的 `symbol` 或 `path` 含通配符
- THEN 闸报红

### Requirement: 注入式测试不构成装配证据

只被测试脚本以「import 后自行 register」方式覆盖的路由族 SHALL 仍被判为未装配。
本能力的判据 MUST 对一个「实现存在、导出存在、测试绿、但装配缺失」的模块报红 —— 这正是
本能力要防的失败形状。

#### Scenario: 单测绿不改变判定

- WHEN 某路由族在 `scripts/test-*.mjs` 中已有全绿的用例，但生产可达集内无调用点
- THEN 该路由族仍被判为未装配，闸保持红

### Requirement: 装配闸在单元套件中执行

装配闸 SHALL 作为单元套件文件表中的一员被每轮执行，使装配缺失在同一次 CI 运行里暴露。

#### Scenario: 装配闸随套件执行

- WHEN 运行单元套件的完整文件表
- THEN 装配闸作为其中一个文件被执行，缺失装配会使该次运行失败
