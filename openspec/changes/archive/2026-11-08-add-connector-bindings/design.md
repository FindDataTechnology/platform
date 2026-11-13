## Context

见 proposal.md — Why。设计约束来自三处现状：

1. **声明已有、消费者为零**：`connector_bindings` 只在两个 pack.json 与两份文档中出现；`fleet-packs/blueprints/schema.md` 已有同族先例 `mcpServers[{registryName, allowTools}]` 与发布门「allowTools ⊆ 商业集」。
2. **凭据存储形状**：`user_connector_credentials(email, slot, token, pat_id, stale, active, updated_at)`，主键 `(email, slot)`，v25 已有「重建表」的迁移先例；`credential-refs.js` 是 ref→解析器注册表，契约 `refName / isRef(config) / liveToken(email) / markInvalid / staleEvent`，消费点 `dsh-profile.js:738/939/1025` 走 `liveTokenForRef(ref, email)`。
3. **对侧能力已就位**：`scoped-pat-grants` 提供范围铸造、衰减派生与范围自省（按动作解释拒绝、按 provider 回答目录覆盖）。

## Goals / Non-Goals

**Goals:**

- 把「包声明 → 解析 → 窄面注入」这条链打通，且目录知识不落到壹座。
- 让未满足的绑定可见、可修、可撤销，而不是靠人读散文。
- 迁移不能让存量用户掉连接。

**Non-Goals:**

- 不做 served agent / 访客（③），不做桌面零粘贴（④）。
- 不改 `fleet-packs/blueprints/schema.md`（蓝图书在 finddata 根，非 git 仓，单独裁定）。
- 不在壹座复制或缓存目录内容（只调自省面）。
- 不做「按目录逛着挑 provider」的策展 UI。

## Decisions

### D1 声明 schema 跟 `allowTools` 同族，校验放进包 manifest 校验器

绑定条目字段：`key`、`provider`、`allowOperations[]`（`read`/`write`）或 `allowActions[]`（更精确，可选加严）、`connectionHint`、`optional`、`alternativeProviders[]`；人读字段保留但不参与判定。

- 校验位置：`pack-store.js` 侧（包入库/安装前的 manifest 校验），不新增独立校验器——那里已经校验 `mcpServers` 与内联件下限。
- 为什么在 paas 侧校验而不在连接器：绑定是**包的产品契约**，连接器只提供目录事实。连接器校验 provider 存在性可以后置到解析（`unwired`）。
- 与 `allowTools` 的关系：两者不合并。`allowTools` 管 MCP 服务行的工具子集，绑定管外部 SaaS 的动作类；合并会让「装的工具」和「碰的外部系统」两个正交概念绑死。

### D2 目录知识唯一存在于连接器，壹座只调自省面

解析每一步都问 `scoped-pat-grants` 的 `catalog-coverage`：provider 是否存在、读/写各类是否有可执行动作。壹座**不**拉目录、不缓存目录、不内置 provider 白名单。

- 理由：目录 1571 provider / 数百万行动作，上游双周合并会漂移；复制一份必然陈旧，且两份会打架。
- `unwired` 与 `missing` 的分界因此是确定的：`missing` 只需「本用户没有该 provider 的连接」（本地事实），`unwired` 必须「连接器说目录覆盖不了」（远端事实）。
- 备选「让包作者在 pack.json 里写 `provider_status` 当作事实」被否决——那正是今天的问题：散文自称，无人校验。

### D3 存储分两类行 + 一张台账表，主键重建

`user_connector_credentials` 加 `kind`（`account` / `binding`）与 `purpose`、`source_account`，主键由 `(email, slot)` 重建为 `(email, kind, slot)`——`slot` 对账号行是账号名、对绑定行是绑定 key，两者同名不得互相覆盖。

新增 `connector_binding_ledger(email, pack_id, pack_version, binding_key, provider, operations, connection_id, status, optional, granted_at, updated_at)`，主键 `(email, pack_id, binding_key)`。

- 为什么台账独立成表而不是塞进凭据表：凭据行是「密文 + 生命周期」，台账是「声明 + 解析结论」，两者读路径不同（凭据永不返回明文，台账要进 `GET /api/connections` 投影）。混表会让每次投影都得绕开密文字段。
- `pack_version` 入台账用于识别「包升级后声明变了」：同 `binding_key` 但声明范围变化时重建绑定并要求重新授权，旧令牌吊销。

### D4 注入走 ref 契约的签名扩展，行名 `connector:<binding>`

`credential-refs.js` 的解析契约从 `liveToken(email)` 扩为 `liveToken(email, config)`（`liveTokenForRef(ref, email, config)` 透传），使 `connector-binding` 这一个 ref 能按 `config.bindingKey` 取对应令牌。

- 为什么扩签名而不是为每个 key 动态注册 ref：动态注册把「包安装」变成「改模块级注册表」，多进程/多次写 profile 的时序不可控；扩一个可选参数是机械改动，三个消费点各传一次 config。
- 基线 `mcp.json` 的 `connector` 行降级为**模板**：只提供 `url`，不再携带 `credentialRef` 直接注入；profile 写入时按台账展开成 N 行，行名 `connector:<bindingKey>`，各自 `credentialRef: "connector-binding"` + `bindingKey`。
- 单轨的收口条件：任何会话写入时，若台账为空则不注入任何连接器行（聊天车道从空范围起步），全局行不得复活。

### D5 令牌获取两条路，按可用会话选择

| 场景 | 路径 | 前置 |
|---|---|---|
| hosted 壹座（浏览器持有连接器会话） | cross-mint（既有端点，`purpose=binding:<pack>/<key>` + 范围） | 部署 `CROSS_MINT_ORIGINS` 含壹座域名（已具备） |
| 无浏览器会话（后台重铸、桌面） | 衰减派生：以账号行 PAT 为 Bearer 铸同租户**更窄**令牌 | 对侧 `scoped-pat-grants` 的 PAT 鉴权铸造（本变更硬依赖） |
| 桌面首连 | 手工粘贴（现状） | ④ 用回环配对替换 |

- 为什么以衰减为主路：单调安全、无需放开 origin 白名单、不要求用户在场；cross-mint 保留为「首次授权」这条用户在场的路径。
- 粘贴路径下没有账号 PAT 的 `patId` 时无法吊销派生令牌——此时以「撤销本地行 + 连接器侧范围自然过期」为准（令牌无 TTL，靠用户撤销），并在 UI 标注该绑定的令牌「无法自动吊销」。

### D6 渐进授权：拒绝不自动重试，授权后下一轮生效

授权动作 = 调 ① 的 `scope-explain` 拿到 `(provider, operationType)` → 用户确认 → 用 D5 的一条路径重铸该绑定（并集）→ 写 profile → **不重放**原调用。

- 写操作绝不自动重放：外部系统副作用不可回滚。
- 读操作同样不自动重放：保持「一次用户动作 = 一次授权，一次模型动作 = 一次调用」的因果清晰，避免授权与执行在同一回合内互相掩盖。
- 同类只授一次：授权单元是 `(provider, operationType)`，范围内已有该类操作时不再弹窗（判断依据来自 `scope-explain` 的拒绝层，而不是本地推断）。

### D7 状态与事件：失效只落一条绑定

`stale` 的产生仍沿用既有机制（401 触发、每轮只重应用一次），但作用域从「该用户的活跃账号」收窄到「该绑定」：只省略该绑定的服务行，其他绑定不受影响，不自动改选任何替代连接。

`unwired` 不进 401 链路——它在解析期判定，属静态结论，随包声明或目录变化重算（重算时机：包安装/升级、手动刷新状态）。

### D8 存量迁移按「主账号 + 内置自由探索绑定」

单账号用户迁移后：账号行 `kind=account`（标签 `default`，为主账号）；新增绑定行 `kind=binding`，`slot=chat:explore`，`purpose=内置自由探索`，范围=全权（对侧空白名单），**显式呈现为一条已授权绑定**。

- 全权是有意的默认：迁移不得降低既有能力，否则用户升级即失能。
- 显式呈现是有意的：让「我的全部 SaaS 暴露给了聊天助手」这件事成为用户看得见、可撤销的一条记录，而不是藏在默认值里。
- 多账号历史数据：原活跃账号为主账号，其余账号保留为可选来源，不自动获得任何授权。

## 代码落点

| 路径 | 改动 |
|---|---|
| `connector-credentials.js` | 两类行的投影与读写；去掉「全局活跃账号决定注入」；`liveToken(email, config)` 按 binding key 取 |
| `db.js` | v114 迁移：两张表的列与重建 + 台账表 |
| `credential-refs.js` | 新增 `connector-binding` ref；契约扩 `liveToken(email, config)`；`liveTokenForRef(ref, email, config)` |
| `dsh-profile.js`（738/939/1025） | 传 config；基线 connector 行按台账展开多行 |
| 新增 `connector-bindings.js` | 解析器 + 台账读写 + 四态判定 + 授权/撤销（唯一新增业务模块） |
| `pack-store.js` | `connector_bindings` 声明校验 |
| 安装/激活路径（pack 安装路由） | 绑定解析门 + 声明式授权弹窗后端 |
| `web/src/components/settings/ConnectionsSection.tsx` | 卡片改绑定为主视图 |
| `chat-connect-guidance` 分类器 | 新增「范围不足」类与 scope 指针 |
| `GET /api/connections` | connector 条目加绑定投影 |

## Risks / Trade-offs

- **[单轨导致存量用户升级后连接器能力"消失"]** → 迁移必须生成内置自由探索绑定且保留全权；迁移用例必须逐项断言「升级前后同一个动作仍可执行」。
- **[重铸频繁写 profile]** → 只在授权/撤销/失效时写，不按轮次写；profile 写入幂等（内容相同不重写）。
- **[令牌数随包增长]** → 每绑定恒一枚有效令牌（对侧同名并集）+ 撤销连带；`GET /api/tenant/pats` 的 `purpose` 让用户能对上号。
- **[`unwired` 判定引入远端依赖]** → 自省面不可达时绑定状态退化为「未判定」（`missing` 需本地事实，`unwired` 必须远端事实）；不得在缺证据时猜成 `unwired`，否则会误报产品缺口。
- **[包升级改声明]** → `pack_version` 入台账，声明范围变化即重建 + 要求重新授权；只在 key 消失时把旧绑定标 `deprecated` 不自动删令牌（用户仍可能在别的会话用它），由状态面提供清理入口。
- **[桌面端令牌获取断链]** → 首连走粘贴、重铸走衰减派生；若账号无 `patId`（手工粘贴）则标注「无法自动吊销」。④ 落地后替换为回环配对。

## Migration Plan

paas 的迁移是 `db.js` 里的版本化条目（不是 .sql 文件），接现有最大版本 113：

```js
{
  version: 114,
  // add-connector-bindings: account rows vs binding rows must not collide on
  // slot (an account name may equal a binding key), so the primary key grows a
  // kind column via the same rebuild pattern used in v25.
  apply: (db) => {
    const cols = new Set(
      db.prepare("PRAGMA table_info(user_connector_credentials)").all().map((c) => c.name)
    );
    if (!cols.has("kind")) {
      db.exec(`CREATE TABLE user_connector_credentials_v114 (
        email TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'account',
        slot TEXT NOT NULL,
        token TEXT NOT NULL,
        pat_id TEXT,
        purpose TEXT,
        source_account TEXT,
        stale INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (email, kind, slot)
      )`);
      db.exec(`INSERT INTO user_connector_credentials_v114
        (email, kind, slot, token, pat_id, purpose, source_account, stale, active, updated_at)
        SELECT email, 'account', slot, token, pat_id, NULL, NULL, stale, active, updated_at
        FROM user_connector_credentials`);
      db.exec(`DROP TABLE user_connector_credentials`);
      db.exec(`ALTER TABLE user_connector_credentials_v114 RENAME TO user_connector_credentials`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS connector_binding_ledger (
      email TEXT NOT NULL,
      pack_id TEXT NOT NULL,
      pack_version TEXT,
      binding_key TEXT NOT NULL,
      provider TEXT NOT NULL,
      operations TEXT NOT NULL DEFAULT '[]',
      connection_id TEXT,
      status TEXT NOT NULL,
      optional INTEGER NOT NULL DEFAULT 0,
      granted_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (email, pack_id, binding_key)
    )`);
  },
},
```

- 现有 `active` 列在账号行上重读为「主账号」，绑定行恒 0（不参与注入决策）。
- 数据回填分两步：迁移只改结构；内置自由探索绑定由启动后的一次幂等回填生成（有账号行且 `chat:explore` 缺失时补一行），避免迁移里做业务判断。
- 回滚：结构删列需重建表（SQLite 无 drop column 的历史包袱已由重建模式覆盖）；业务回滚保留台账表不读即可，令牌在连接器侧由用户撤销或自然过期。
- 部署顺序：先 `scoped-pat-grants`（连接器），再本变更（壹座）。

## Open Questions

- 授权弹窗里是否要为 `unwired` 绑定列出 `alternativeProviders` 的候选（如「该 provider 无写面，是否改接 X」）？不影响规格与任务拆解，实施时按弹窗容量定。
