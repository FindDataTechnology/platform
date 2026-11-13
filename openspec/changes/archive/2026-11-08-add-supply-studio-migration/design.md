# Design: add-supply-studio-migration

## Context

三个现状事实决定本设计：

1. **蓝图文档**在壹座 per-cell SQLite（`server/routes/blueprints-db.js`，better-sqlite3+WAL，镜像 fleets-db 模式），落笔前过 `blueprint-validate.js` 凭据扫描（凭据禁带闸），仅 v2 形状可存；特性 11-01 起三批建成，存量文档量小且 owner 集中。
2. **谦面应用**（gateway，3200）已有 Logto 身份、发布闸（`publish-gate.js` + `validatePackManifest`）、SQLite 存储纪律（packs 同款）。
3. **壹座侧耦合面**：`/agents` 四区（agent-builder-hub）、`/studio` 路由、sidebar 入口、from-template 装机通道、舰队详情回链芯片、AI 起草判官桥（`BLUEPRINT_JUDGE_MODEL` 车道为外部域）。

约束：W1 已使目录单源（studio 发布后的产物经既有 pack 链即入统一目录）；创作者漏斗断点在身份，不在数据；壹座回归纯运行域是 W2 的验收判据之一。

## Goals / Non-Goals

**Goals:**
- 创作者用谦面身份完成「注册→创作→试跑→发布」全程，壹座只在「运行」时入场。
- 蓝图文档、生命周期状态机、校验、AI 起草的行为语义逐字承接（用户可见行为零回退），宿主换到谦面。
- 壹座侧创作面退役干净：无死路由、无双宿主并存。

**Non-Goals:**
- 不做供给域自有 cell 执行（v1 预览=干跑；真执行仍归壹座/萬星）。
- 不动调优行为契约（`skill-self-evolution` / persona 评审语义不变，只换门面位置）。
- 不做 W3 域名归一（facet. 域身份沿用，机器面静态化留 W3）。

## Decisions

### D1. 文档宿主 = 谦面侧独立 SQLite，不是脊柱五物种表，也不是留壹座走 API 桥

- **A（选定）**：谦面侧新建 `studio-docs` SQLite（与 packs 同宿主同纪律：WAL、ensureSchema、dump 备份），owner=谦面身份 id；蓝图文档是**草稿**不是素材物种，不进五物种登记表（脊柱），避免把未发布草稿混进目录真源。
- B：塞进脊柱五物种表——草稿没有 listed 语义，会污染「目录=可获取素材」的契约。
- C：文档留壹座、谦面走 API 桥读写——壹座仍是创作依赖，漏斗断点只挪不除，且跨域乐观锁/自动保存延迟放大。

凭据禁带闸（`blueprint-validate` 扫描）随存储层整迁：谦面侧写路径结构性拒绝携带端点/token/secret 的文档，v1 形状不可存。

### D2. 存量迁移 = 一次性搬库 + email 身份映射，不是双写

蓝图文档量小（特性上线数日）：静窗一次性 `blueprints.db` → studio-docs 迁移，owner email 在两套 Logto 间同域映射（同邮箱即同人；无谦面身份的 owner 首次访问时按邮箱认领）。壹座原库转只读归档。`?doc=` 文档 id 跨迁移不变，壹座 `/studio?doc=` 重定向直翻供给域 URL。

### D3. 预览沙箱 v1 = 干跑三件套，不含 cell 执行

预览=静态校验 + manifest 组装 + LLM 起草干跑（复用起草桥逻辑），在谦面服务端执行；每身份每日配额 + 单次时长/token 帽在服务端强制；零持久化（预览产物随响应返回，不落任何存储）。理由：roadmap 要求「试跑不依赖壹座」，而真执行需要 cell/凭据/舰队语境——那正是壹座运行域；v1 用干跑满足「发布前看得见形状」，真执行预览挂账为后续探索。防免费算力口：配额超限返回显式语义码，匿名身份不给预览。

### D4. 跨域部署 = 深链承接，不做服务端联合会话

Studio「部署团队」→ 携 pack 安装态深链进壹座 → 壹座会话（已有则直达，无则登录后回跳）→ `POST /api/mypacks/install`（reused 幂等）→ `POST /api/fleets/from-template`（born paused）→ 团队页。不做跨域 SSO 代换：装机瞬间需要壹座会话是运行域的诚实边界，创作者在此步被如实引导注册壹座。回链芯片读 `_casting.blueprintId` 指向供给域 Studio URL。

### D5. 壹座侧退役映射

| 壹座既有面 | W2 后去向 |
|---|---|
| `/studio` 三栏 | 重定向 → 供给域 Studio（query 原样透传） |
| `/agents` 构建区 | 深链 → 供给域 Studio |
| `/agents` 供给区 | 深链 → 供给域市场（三柜由门厅/橱窗承接；Settings 别名入口保留不动） |
| `/agents` 我的创作 | 深链 → 供给域控制台 |
| `/agents` 调优区 | 壹座原生调优面（新路由 `/tuning`，挂 workspace 语境，行为契约=skill-self-evolution 不变） |
| sidebar「智能体构建器」 | 改「智能体市场」深链 + 装机动作面板（slug/testid 身份不变，词表 v4 增行） |
| `/settings/packs`、`/settings/presets` legacy 重定向 | 改指 Settings 原生面或市场深链，MUST NOT 404 |

## Risks / Trade-offs

- [跨域部署的会话摩擦] → 深链回跳承接既有壹座登录流；「发布不需要壹座、运行需要」在 Studio UI 如实标注，不静默降级。
- [组件随迁的双仓漂移] → 迁移是搬不是抄：壹座侧同组件随四区解体一并删除，无双宿主并存窗口（三桶编辑器等共享组件除外，循「工作区是唯一创作面」既有语义）。
- [`?doc=` 旧链失效] → 文档 id 跨迁移不变 + 壹座重定向透传 query；回归钉进 e2e。
- [沙箱被当免费算力] → 配额+时长/token 帽+匿名不给预览三闸；超限语义码显式。
- [晋升通道语义未定案] → v1 只 fork preset/配置/skills、显式排除记忆与会话历史，provenance 带来源实例；扩围留单独探索（roadmap 挂账原样保留）。

## Migration Plan

1. 谦面侧先落：studio-docs 存储+生命周期+校验+起草端点、Studio web 面、发布闸接线、预览沙箱（全部上产后处于内部灰度，壹座面未动）。
2. 静窗数据迁移：`blueprints.db` → studio-docs（对账：文档数+逐文档 content_json 相等；owner 映射表落档）。
3. 壹座侧切换一次上线：`/studio` 重定向、四区解体、sidebar 换装、调优原生面、芯片改链（单 release，无双宿主窗口）。
4. 回归：六客户端装包链路、e2e（工作区/深链/闭环/晋升）、机器面对账（studio 发布产物入统一目录）。

回滚：步骤 3 单 release 可整体回退（壹座面恢复原状；谦面侧 Studio 面无数据写入回滚无损）；数据迁移回滚=原库只读归档未动，翻回指即可。

## Open Questions

- 无阻塞项。调优原生面路由定 `/tuning` 为暂定名（词表归档前复核）；晋升扩围（记忆类状态）按 roadmap 挂账另行探索。
