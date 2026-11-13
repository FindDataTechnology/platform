# Tasks: add-agent-memory-foundation

## 1. 写面：一等 metadata

- [x] 1.1 /pages POST 与 MCP memory_write_page 接受可选 `metadata`（对象，值限标量/标量数组；非法 400 结构化拒绝，不落库）
- [x] 1.2 双轨落库：markdown frontmatter 承真源 + SQLite metadata 列承索引（kind/memberId 建索引；先真源后索引）
- [x] 1.3 缺省 metadata 的写入与迁移前逐字节等价；既有 70+ 单测零回归
- [x] 1.4 单测：合法写入可按键检索、非法形状 400、缺省等价

## 2. 读面：结构化筛选

- [x] 2.1 /digest、/pages(GET) 增加可选筛选参数：metadata 键值（数组值取包含语义）、时间范围（写入上下界）、layer
- [x] 2.2 MCP memory_query / memory_recent 增加同名筛选参数；筛选下推查询层（走索引，禁渲染层全量过滤）
- [x] 2.3 forget/superseded 排除纪律在筛选路径沿用；筛选与相关性组合为空时返回空集不报错
- [x] 2.4 单测：按岗位取拍板、缺省等价、筛选×相关性组合、空集

## 3. 回填迁移

- [x] 3.1 独立回填命令：解析存量 `[kind][memberId] ` 前缀（严格匹配五类词表，解析不出跳过并计数），写 metadata 双轨，标题不改写
- [x] 3.2 幂等保证：重跑零变更；回填报告（扫描数/命中数/跳过数）
- [x] 3.3 双轨读验证：旧前缀页与新 metadata 页在同一筛选下均可命中
- [x] 3.4 单测：回填幂等、词表外跳过、双轨命中

## 4. owner oversight（fleet-memory 矩阵扩展格）

- [x] 4.1 铸造面落 root_owner 记录（platform 代铸 deployment 时绑定 owner；存量根一次性回填 owner 绑定，幂等）
- [x] 4.2 Grant 判定扩展：person 对自有 d/ 根只读（列分区/读页/digest 含成员私有分区），零写权；非自有根 403 不泄存在性
- [x] 4.3 监督读取逐读落审计行（谁/何时/根/分区/命中数），经既有 admin 面可查
- [x] 4.4 单测：自有根读过审+审计行、写 403、跨 owner 403、矩阵其余格回归

## 5. memory_overview 工具

- [x] 5.1 MCP 新增 memory_overview：按调用者可达分区返回概览（分区标识/页数/最近写入时间/最近 ≤10 条标题），返回体硬上限
- [x] 5.2 授权与 buildTools readProjects 同源（deployment=own+shared、pod=shared、person=自有根+oversight），不旁路 Grant 判定
- [x] 5.3 单测：部署成员只见 own+shared、pod 无 own、person 含 oversight 分区、不可达分区不泄露

## 6. 收口验证

- [x] 6.1 `npm test` 全绿零回归；新增用例全过
- [x] 6.2 真机冒烟：起本地 serve，走「带 metadata 写入 → 结构化筛选检索 → overview → oversight 读」全链
- [x] 6.3 清理 src/ 中任何内部 IP/秘密/内部项目名；`openspec validate add-agent-memory-foundation --strict` 绿后归档
