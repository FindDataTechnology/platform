# Tasks: add-agent-builder-workspace

按四批交付（design.md - Migration Plan）：批 1 纯前端修面 → 批 2 服务端对象统一（附加式，先于依赖它的前端件出片）→ 批 3 图与闭环 → 批 4 收尾与度量。每批以真机走查+出片收口，批间可停可续。

## 1. 批 1 · 工作区骨架（文档库 / 检查器跟随 / 自动保存）

- [x] 1.1 重建 AgentStudioPage 为三栏工作区：左栏文档库（GET /api/blueprints 列表 + 状态徽章 + 搜索 + 打开），中栏画布（当前文档：三桶卡 + 蓝图专属段一等区块），右栏检查器（规格书/校验/动作区三段）；BlueprintTeamMode 页签与第二编辑宿主退役（AgentBucketsEditor/AgentSpecSheet 共享组件保留复用）。验证：新 e2e spec——打开任一文档后，检查器校验项逐条属于该文档（断言不再出现「编辑 A 校验 B」错位）。
- [x] 1.2 头部文档身份与自动保存：文档名就地编辑、保存态三档（未保存更改/保存中/已保存 vN）、防抖 1.5s PUT + expectVersion 在途单发合并、新建即 POST 落盘。验证：e2e——编辑后离开路由再返回，内容逐字段完好；PUT 请求计数证明防抖生效。
- [x] 1.3 版本冲突处置：409 时冲突横幅（刷新查看 / 以我为准），「以我为准」经 confirm-dialog 后才以最新 version 强写，默认永不静默覆盖。验证：单测（helper 模拟 409 流）+ e2e 断言横幅两选项与确认框存在。
- [x] 1.4 检查器选中联动：画布岗位芯片/工具条目/边选中 → 规格书对应段高亮；校验语义恒为「属于当前文档」。验证：e2e 点选岗位 → 规格书角色段高亮断言。

## 2. 批 1 · 生命周期 ribbon 与错误可行动

- [x] 2.1 生命周期 ribbon（team 文档）：草稿→批准→铸造→试跑→签字→(重封) 档位投影，只亮一个下一步主操作；批准仅校验全绿可用、试跑仅已铸态提供、非批准人铸造禁用带提示；散落的发射/闸位按钮列退役。验证：e2e 按 status 矩阵断言档位与禁用态（含试跑在未铸态不可点）。
- [x] 2.2 修生命周期文案撒谎：空态与说明文案改为服务端真序（校验→批准→铸造→试跑→签字→重封），五语同步。验证：grep 全 locale 无「试跑」在「批准」之前的顺序串；check:locales 绿。
- [x] 2.3 校验错误点击定位：可编辑字段挂 data-anchor（entry 路径映射），点错误行 scrollIntoView+focus+1.5s 高亮环；原文逐字可见 + 复制按钮（code 摘要映射留待批 2，本批直显原文）。验证：e2e——制造 name 超长错误，点击后对应输入框 document.activeElement 命中。
- [x] 2.4 AI 起草浮层化 + 逐字段评审卡：右侧浮层（与检查器互斥，画布不缩），产物按字段（名称/描述/persona/技能/工具）各 采用/跳过 + 全部采用；采用仍是唯一写入门，取消逐字段不变。验证：e2e——仅采用 persona 后其余字段 byte 不变；取消后零污染。

## 3. 批 1 · 导航、hub 与深链

- [x] 3.1 导航退役：blueprints 从 FACTORY_PRESETS 两档 nav 移除（注册表 slug 保留），NAV_FAMILIES「构建」成员改 [agents, fleets]，/blueprints 重定向保留。验证：layout-configuration/sidebar-nav-families 对应单测更新绿；fresh 解析无蓝图项、带存量预设用户仍可见。
- [x] 3.2 hub 构建区升级：最近文档板（top6 + status-pill + 更新时间序）、「新建蓝图」入口、「进入工作区」直达；读既有列表端点零新端点。验证：e2e——构建区列出文档并点击直达 /studio?doc=。
- [x] 3.3 深链契约落地：/studio?doc= 打开、?fork= 播种（不可读回落文档库+toast）、?from=blueprint 落库；/agents 深链不动。验证：e2e 三深链 + 不可读 fork 回落断言。
- [x] 3.4 五语词条 + 词表登记：工作区/文档库/ribbon 档位名/冲突横幅等新键 en/zh-CN/es/fr/ja 全量；新 UI 词入 native-lexicon 词表。验证：check:locales 2682+ 键绿；词表 diff 评审。
- [x] 3.5 批 1 走查与出片：hermetic 走查脚本（工作区全态截图）+ visual-judge 渲染门 + 五语言真机腿 + e2e 全量绿；fd-build-channel 判路 → 快照 → bump → 核 imageID（假绿律）→ 生产走查 → 台账 §15 记账。验证：走查腿全绿记录在案；生产眼见 ribbon/定位/冲突横幅 LIVE。

## 4. 批 2 · 服务端对象统一（kind 与轻骨架）

- [x] 4.1 content.kind 显式字段：agent|team，缺省（存量无字段）=team；POST 创建接受 kind 参数，agent 用轻骨架（无 boundary/fleet/acceptance）。验证：单测——存量记录读出 kind=team；新建 agent 记录形状正确。
- [x] 4.2 校验链 kind 感知：agent kind 跳过 parseFleetTemplate 段，manifest 段/凭据/数据源闸两 kind 全量照跑；agent kind 的 approve/cast 服务端显式 409（不靠 UI 藏按钮）。验证：单测钉住两 kind 校验矩阵 + 409 闸。
- [x] 4.3 skills 入蓝图 content：BlueprintContent 增 skills[]（复用 validatePackManifest 技能段），工作室发射口（预设/草稿包）从持久文档读取。验证：单测——含 skills 的文档过校验；发射产物与旧工作室文档路径逐字段一致（回归）。
- [x] 4.4 前端接 kind：新建智能体/新建团队双入口（agent 一次点击即带已选岗位+名称聚焦）、ribbon 按 kind 分支（agent=草稿+两发射口常驻）、文档库两 kind 统一列。验证：e2e 新建智能体零二次点击；agent 文档无团队档位渲染。
- [x] 4.5 批 2 走查与出片：服务端先行出片（旧 UI 对新服务端零感知回归）→ 前端随班；存量蓝图行为不变走查 + 新 kind 真机腿 + 台账。验证：存量文档打开/批准/铸造全绿；agent 文档发射真预设落地。

## 5. 批 2 · 稳定错误码

- [x] 5.1 校验器内联 code：validatePackManifest 与 blueprint-validate 每条 finding 附稳定 code（如 name_too_long / pack_needs_one_reference / handoff_cycle），error 原文逐字不动。验证：单测——findings 形状 {code,error,entry?}；旧客户端消费面（facet/市场）零破坏回归。
- [x] 5.2 客户端映射表：error-codes.ts code→五语摘要键；未知 code 回落原文（不猜纪律）；原文 tooltip + 复制保留。验证：对表单测——每条 code 恰一摘要键、五语齐全（check:locales 覆盖）；未知 code 用例显示原文。
- [x] 5.3 批 2 收口走查：错误行中文摘要+定位+原文三同框真机眼见；台账记账。验证：走查截图入册。

## 6. 批 3 · 可写团队结构图

- [x] 6.1 图适配器：team 文档画布一等卡片渲染 FleetCanvas（只读默认），输入=content.fleet 投影（members 来自 agents+pack 引用），@xyflow 维持懒加载。验证：e2e 渲染断言 + 首屏 chunk 不预载（network 面板断言或构建产物门）。
- [x] 6.2 设计模式编辑态：显式开关；拖线连边/断边/改 kind 产 draft 边（虚线）；确认=并入 content 并跑同一校验 dry-run，非法拒并锚定图上边；退出即弃未确认草稿。验证：e2e——拖线确认落 fleet、未确认退出零变化、成环边被拒并定位。
- [x] 6.3 位置本地持久：localStorage 键按文档（doc:<id> 与 fleet:<id> 同构），声明数据零污染。验证：单测 + 刷新后位置保留且 PUT body 无位置字段。

## 7. 批 3 · 铸造→运行→回编辑闭环

- [x] 7.1 部署团队动作：铸造成功 toast + ribbon 下一步「部署团队」→ POST /api/fleets/from-template（castPackId），出生 paused，navigate /fleets/:id。验证：真机腿——铸一份真包部署真团队，团队页可见 paused+待启动横幅。
- [x] 7.2 来源蓝图回链：FleetsPage 详情读 manifest._casting.blueprintId → 「来源蓝图」芯片 → /studio?doc=；已铸文档续编辑 ribbon 显性重封档。验证：真机腿闭环——铸→部署→回链→改→重封→市场包更新。（真机补记：改→重置 draft→重批准眼见；末段重铸被发布限流 10/h 闸如实拦，铸通道当日两度眼见——台账 §9 批3 ③）
- [x] 7.3 team kind AI 起草：/api/studio/draft kind=team-doc（blueprint-author 桥既有），评审卡同 agent 面。验证：真机一次起草采用腿；车道 503 如实红不假绿。（车道恢复后真机全腿：46.7s 真草稿（boundary/dataSources/fleet×3/acceptance）→真 UI 评审卡勾选→采用→fleet×3 落库、跳过字段逐字节未动——逐字段写门正面证据；台账 §9 批3 ⑦）
- [x] 7.4 批 3 走查与出片：全链真机活体（含 7.1/7.2 两腿）+ visual-judge + 台账。验证：闭环一次成型记录在案。

## 8. 批 4 · 收尾、防护与度量

- [x] 8.1 调优区回链：skill/persona 候选评审面显示来源文档芯片 → /studio?doc=。（勘误：候选本无文档 lineage——提案出自 cell MCP 无文档上下文；诚实设计=propose 合同可选 sourceDocId（studio 发起才带）+迁移 v113 双列+双视图芯片+诚实缺席；e2e 回链可达+缺失零芯片）
- [x] 8.2 官方 starter 作文档种子：文档库空态「从模板」接官方 starter 清单（清单=GET /api/packs/official templates 段即货架共定清单收口 Open Question；starter-seed.ts 纯投影 manifest→文档骨架，零新端点零服务端改动；e2e 新建自模板腿+validate 净）
- [x] 8.3 多标签软锁：BroadcastChannel 同文档他窗打开提示（只提示不接管；ack+seen 去重截断回声，可关、跨文档零渗漏；数据面 409 横幅照旧兜底）。验证：双页 e2e 提示断言。
- [x] 8.4 度量埋点：首次发射耗时、校验错消解点击数、cast→部署转化率（取数口收口=浏览器本地环 localStorage 上限 2000 与画布位置键同惯例、零出网；七事件点接线+aggregate-studio-metrics.mjs 聚合脚本+金值单测）。验证：本地跑一轮出三数（脚本聚合）。
- [x] 8.5 终局走查与归档准备：全量 e2e + 五语真机 + 性能门（/studio 首屏不劣化）+ validate --specs 对齐预演 + 台账终章。验证：三度量对照批 1 基线改善；归档差集纪律预检绿。（补记：生产真机=starter 数据面 20 支可达+软锁双窗眼见+度量 doc_created/validation_error_seen 落环+清理净；@xyflow 懒加载维持零首屏 chunk=批 3 承接不劣化；validate --specs 245/0+change strict 绿；归档待主班次窗口）
