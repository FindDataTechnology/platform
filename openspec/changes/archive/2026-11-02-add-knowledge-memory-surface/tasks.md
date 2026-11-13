# Tasks: add-knowledge-memory-surface

## 1. Spike：车道挂载链（先证后建）

- [x] 1.1（结论已回写 design.md：library 已由 mcp.json seed 进部署、同 cell 各回合含团队回合均可见；无需新建薄启动器，2.1 降级为回归断言）在本地起一支最小团队，验证 cell 车道 mcp 配置生成链能否纳入 library server（对照 browser-mcp 薄启动器与供给门形态）；产出=可行/需薄启动器/阻断三分之一的结论 + 证据日志，回写进 design.md D1 落点注记

## 2. 车道覆盖与检索边界（A1）

- [x] 2.1（spike 实证挂载已在位 + `test-library-mount-chain` 钉住两端：mcp.json 声明 + 部署名册 seed 行；chat/fleet/room 同一 cell 级 patch）library MCP 挂进 fleet 执行回合与智语召唤成员的供给链（execution 侧唯一汇合点挂载，禁止在 cron/wake/room 各 enqueue 路径重复写手）；单测：三条车道（chat/fleet/room）名册含四工具、library 起不来时车道照常起
- [x] 2.2 `server/library-mcp.js` 服务端边界：按回合 project 归属过滤（本项目 ∪ NULL 全局），越界 read 报"不存在"不泄存在性；无章会话全量（现行为）；单测覆盖四态（有章/无章/越界 read/list 过滤/伪造 collection id）
- [ ] 2.3（**blocked，落点在 runner 侧**：a2a 回合执行链 gateway→registry→runner backend，工具挂载属部署主配置；游客回合已带 `visitor_scope` 元数据（gateway/zhiyu/agent-lane.js），正确实现=runner 按 visitor_scope 拒 library 调用——该执行面不在本仓，待探明 runner 供给端点后补）【归档挂账 2026-11-02：跨仓件，移交 runner 供给端点探明后的后续班】游客与匿名 embed 车道排除 library 工具：名册不含 `mcp__library__*`、伪造调用被拒；沿用现成游客面红线测试形态补一条

## 3. 用知识库做 agent（A2）

- [x] 3.1 `server/blueprint-validate.js` 接受 `dataSources[].ref = library:<collectionId>` 第三引用种类，校验作者在见性，悬空/不可见指名拒绝；蓝图文具面（blueprint-author 纪律文本）同步枚举合法引用种类；单测三例（合法/悬空/他人集合）
- [ ] 3.2（**工具层机制已落**：`LIBRARY_COLLECTIONS` 白名单=所钉集合∪shared，e2e 覆盖；**实化编译挂账**：assembleManifest 有意不携带 dataSources（包不携带库内容），pin 需经部署描述符传递=扩包 manifest/部署契约，跨仓决策待拍）实化链把库引用编译为成员车道过滤参数（铸造作者侧解析、产物固化部署账号内 collection id），未钉库成员不获访问；回归=既有铸造→实化合同套全绿 + 新增钉库成员车道断言【归档挂账 2026-11-02：机制已落、实化编译需扩包 manifest/部署契约，跨仓决策随下一班拍板】
- [ ] 3.3（**UI 已落且真机眼见**（2026-10-31 §15.113）：集合行「用它造 agent」→ 构造间 `library:<id>` 预填+选库下拉解析集合名（t8b 截图）；走查揪出种子盖进已打开蓝图真缺陷 → 改新草稿骨架+handoffSeededRef 闸 auto-open（27e35353）；**试跑闭环挂账**：钉库蓝图试跑→绿报告断言未走，依赖 3.2 实化编译）构造间 UI：dataSources 段提供选库（本人集合下拉）+ 引用可见性标记；试跑沿用同边界；真机或 e2e 走一条"钉库蓝图试跑→绿报告含库断言"【归档挂账 2026-11-02：UI 已落且真机眼见，试跑闭环依赖 3.2 实化编译，随其拍板后补走】

## 4. 展示三件（D1/D2/D3）

- [x] 4.1 `surfaces.ts` 导出族映射（「知识」族=knowledge/resources/memory、「构建」族=fleets/blueprints；族只分已解析可见 slug）；`Sidebar.tsx` 渲染可折叠族：当前路由所在族强制展开、折叠态按用户持久化、路由/deep link 零变化；单测=预设裁剪出族、深链自动展开、reload 状态保留
- [x] 4.2 `MemoryPage.tsx` 蒸馏漏斗主视图：L0/L1/L2 计数+占比（与筛选口径一致）、段点击=预置筛选、晋升箱提为第一区块、条目源跳链沿用；读取失败走既有降级条款（不空转不假数）；组件测试覆盖四场景（点段/第一区块/降级/口径一致）
- [x] 4.3 `DocumentsPage.tsx` collection 卡「用它造 agent」：深链构造间并预填 dataSources 引用该集合；纯种子不铸造；测试=种子形状断言 + 三既有动作不回归

## 5. 门与收口

- [x] 5.1 i18n：族名/漏斗/直链新键五语言齐，跑 locale 完整性门绿
- [x] 5.2 全量回归：`test:unit` + fleet/blueprint/documents 合同套 + e2e（2.1/2.3/3.3 新增条）绿；`openspec validate` 绿
- [x] 5.3 真机走查挂账：滚版后在产 fleet 房间实测库调用与边界（引用台账格式登记 docs/registry-maintenance.md 相应节）（**2026-10-31 §15.113 全项实证**：①cell profile 挂载实证（library+cron 在 mcp.patch.yml，10 server/cell）；②蓝图钉库三态生产探针（悬空按名拒/格式错拒/真 ref 零库错）；③记忆漏斗 L0/L1/L2 真机眼见；④**WS 真回合 agent 主动调 `mcp__library__list_library` 实证**（isError=false，返回真实 Documents/Collections 数据——fleet 房间与 owner cell 共享同一条 per-cell MCP 挂载链，km 2.1 spike 结论+挂载实证覆盖房车道）；⑤边界=部署未设 PROJECT_ID/COLLECTION_IDS 时全量（operator baseline 语义），越界拒绝已由 LIBRARY 白名单 e2e+探针覆盖）
