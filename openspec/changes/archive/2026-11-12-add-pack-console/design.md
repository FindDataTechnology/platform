## Context

见 `proposal.md — Why`。相关的既有事实（实现的边界条件）：

- `agent-fleet-cockpit` 已经把主人视角的读面写成契约：组织画布为主位、KPI 卡墙、拍板横幅、日报流，且明确"纯读面，不引入新写路径"。控制台**不能**改造这张画布——它是主人视角的固定形态，控制台是"团队自己的脸"，两者并存。
- `agent-fleet-cockpit-projection` 已经给出"有界投影"的先例：`GET /api/fleets/overview`，`v:1` + `sampledAt` + 硬界截断 + "复用既有派生，不另造"的纪律。控制台的 view model 沿用同一套纪律。
- `/:id/cockpit` 的聚合体里已有 `members` / `statusCounts` / `decisions` / `stream` / `orchestration`（`server/routes/fleets.js:1747`），另有 `/:id/spend`、`/:id/runs`。**首批六个块不需要任何新数据面**。
- `packages/core` 已确立"多前端共用一个 workspace 包"的先例（"Shared protocol core for the platform frontends"，web 与 miniapp 共用，解析走 `packages/core/node_modules` 符号链接）。
- 谦面是独立部署（`facet/index.js` 第二角色，`FACET_DATA_ROOT=/data/facet`，只有 packs.db），与千座无进程依赖；`facet-platform` 要求"千座全停时市场面仍可用"。
- `lib/pack-manifest.js` 是发布面与安装面共用的唯一校验器；`lib/pack-locale.js` 是五语标注解析的唯一来源。

## Goals / Non-Goals

**Goals**

- 团队控制台 = pack 的一个声明面：选块 + 参数 + 面向哪个宿主，带不带取数方式。
- 一份 view model、一份渲染实现、两个宿主；新增块只改注册表与共享包。
- 分享面在服务端裁剪，匿名可读且只读。

**Non-Goals（设计层排除）**

- 不做自由 UI DSL / 自定义查询：那会引入第二套渲染与注入面，且让声明变成"配置"。
- 不改造 `agent-fleet-cockpit` 的画布布局，也不在分享面提供任何管理动作。
- 不做"每团队一个 facet 镜像"：facet 是单节点 hostNetwork 部署（`facet.yaml` 钉在 cheap-3），N 个镜像等于 N 个单点。
- 不做跨进程缓存：view model 每次实时派生，避免"台账里的空其实是读了别的节点"那类事故。

## Decisions

**D1. 控制台是新面（`/fleets/:id/console` 与 `/t/:slug`），不是驾驶舱的一个模式。**
替代方案：给驾驶舱加"精简模式"。否决理由——驾驶舱的契约要求画布为主位且不引入写路径，加模式会让同一个页面背两套布局契约，正是"同一件事有第四处要改"的来源。新面还能让分享面天然只读。

**D2. 块是服务端注册表（`id → builder(ctx)`），不是前端组件注册表。**
替代方案：前端按 `block` id 映射组件，数据各块自取。否决理由——前端自取意味着每个块各写一条取数路径与一份裁剪逻辑，`surface` 裁剪会退化成前端隐藏（假隔离），且两个宿主必然漂移。服务端注册表让 view model 成为唯一事实，前端只渲染。

**D3. 单一端点 + `surface` 参数，而不是两个端点。**
替代方案：`/console` 与 `/console/share` 两条。否决理由：两条路径的块集合与字段会各自演化；单端点 + 服务端裁剪让"share 是 platform 的子集"在代码结构上成立，测试也只需比对同一次响应。

**D4. 一份实现放 `web/src/components/console/`，谦面通过既有 `@` 别名复用（不新建 workspace 包）。**
实施时读了 `facet/web/vite.config.ts`：它已经把 `@` 别名指向 `web/src`，并显式 dedupe React / react-i18next / react-router（两条 runtime 副本会炸 hook 与 i18n 实例）。facet 的市场面早就是这么复用 `components/packs` 与 ui kit 的。
替代方案：（a）新建 `packages/console-blocks`——多余，等于给已通的缝再包一层；（b）服务端出 HTML 片段——丢掉交互且与两个 SPA 的组织方式冲突。
**验证已做**：`npm --prefix facet/web run build` 通过（1893 modules，零配置改动），证明共享组件真的进了谦面包。

**D5. 分享需要显式公开：`fleets` 增可空 `console_slug`（唯一）+ `console_published_at`。**
替代方案：任何声明了 `share` 块的团队自动公开。否决理由是隐私：团队遥测不该因为作者写了一句 `surfaces: ["share"]` 就对外可见，公开必须是主人动作。slug 由服务端从团队名派生并对撞加后缀，不接受用户自定义（避免抢先占名与仿冒）。未设置 `console_slug` 时 `/t/*` 一律 404 语义。

**D6. `absent` 用枚举原因，`headline` 在块 absent 时解析为 `null`。**
理由：`0` 与"没有数据"在运营读面上是相反的含义（"缺数不算恢复"同族教训）。枚举原因让宿主能说清为什么空，也让测试可断言。

**D8. 块 builder 由路由注入 `memberView`，不把 `memberView` 搬出路由文件。**
实施时发现 `memberView`（`server/routes/fleets.js:311`）与 `resolveTarget` 互相咬合，而 `resolveTarget` 又以 `resolveFleetTarget` 的名字被 `server.js` 的 catalog 钩子引用——搬走它会牵动三处。反过来让 `console-blocks` import 路由则形成环，并把 `dsh-profile.js` 拖进这个模块的 import 图（env-freeze 事故的形状）。因此方向反转：路由把 `memberView` 注入 builder，builder 只依赖传入的 db。代价是 `server/console-blocks` 不能脱离路由单独取数；收益是零搬家、零循环、零 import 顺序变化，且"一份实现"仍然成立（两个面读的是同一个 `memberView`）。彻底提取 `memberView` 留作后续独立变更。

**D7. 校验器扩展放在 `lib/pack-manifest.js`，块 id 与参数白名单来自一个**无依赖的 lib 文件**（不是 server 注册表）。**
理由：发布面与安装面必须同一份规则（既有纪律）。但网关进程也 import 这个校验器，因此承载块规格的文件必须零依赖（同 `lib/generic-bot-types.js` 的既有做法）；只有 builder（真去取数）才住在 `server/console-blocks/`。参数白名单从这份 lib 规格派生，不在校验器里手写第二份枚举。

## Risks / Trade-offs

- **[facet/web 解析不到 workspace 包]** → 先做一条最小验证（在 `facet/web` 里 import 一次并构建）。失败则退回：共享包只出"数据 → 视图模型"的纯函数与无样式原语，样式留在各宿主（仍是一份逻辑，两处样式），并把该退让写进 design 的 Migration 记录。
- **[分享面暴露团队遥测]** → 三道约束叠加：块级 `surfaces` 白名单、服务端裁剪、主人显式公开（D5）。字段级再兜一次：share 响应剔除成员邮箱、模型、工具面、凭据。
- **[view model 变成第二个 cockpit，语义漂移]** → 块 builder 只允许调用既有派生函数；把 `memberView` / 拍板排序等纯函数从 `routes/fleets.js` 提到共享 lib 后，两侧引用同一实现，并由既有 fleet 测试套件保证零行为变化。
- **[控制台成为慢页]** → 每个块独立 `absentReason`，单块上游超时降级为该块 absent，不拖垮整页；`sampledAt` 让宿主能显示"截至何时"。
- **[块 id 成为对外契约]** → 块 id 一旦发布即不可改名；deprecate 走"保留 id、改渲染"，registry 里加别名机制留给后续变更。
- **[facet 单节点]** → 该页与市场面同进程，最坏情况一起抖；因此 `console` 取数必须带短超时与降级，不能让分享页把 facet 的事件循环拖住。

## Migration Plan

1. 建表列（可空）与注册表骨架，先不接任何页面：此时 `console` 段可被校验与存储，但无入口（`console` 缺省行为不变）。
2. 接 view model 端点（platform surface），补 share 裁剪与服务端断言。
3. 接两个宿主页面；先 platform 后 facet（facet 依赖 D5 的公开动作）。
4. 回滚：路由与页面可直接摘除；`console` 段在旧版校验器下被**忽略**（`validatePackManifest` 只做已知字段校验，没有顶层键白名单，实测确认），因此带 `console` 的包在旧版本上照常安装、只是不出现控制台入口——**本变更没有不可逆点**，回滚不会让已发布的包装不上。这个"未知键被忽略"的事实要保留一条向后兼容用例钉住，防止将来有人加顶层白名单时无声破坏它。

## Open Questions

- 小程序是否也渲染控制台（先不做，`packages/console-blocks` 保持无 DOM 假设以外的最小依赖，便于后续接）。
- 分享页是否需要限流/防抓取（当前不设，属于面层策略，可在后续变更里加而不改本契约）。
