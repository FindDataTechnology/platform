# MCP Registry 上架指南（谦面公开 server → 官方 Registry）

> 面向：运维/发布执行者。本文讲**怎么把谦面的公开 MCP server 挂到官方 MCP Registry**，
> 以及为什么只有一条发布路径。
> 相关文档：[marketplace-landscape.md](marketplace-landscape.md)（全景调研与事实核对表）、
> [universal-keyless-mcp-auth.md](universal-keyless-mcp-auth.md)（免键车道）、
> [client-matrix.md](client-matrix.md)（六客户端能力矩阵）。
> Spec：`openspec/specs/ecosystem-access`（投影需求已并入；change
> `add-marketplace-projection-fanout` 已于 2026-10-31 归档）。

## 1. 这条通道是什么

官方 MCP Registry（`registry.modelcontextprotocol.io`）是社区驱动的 MCP server 目录，
**只托管元数据、不托管产物**，免费公开。用户在主流客户端里搜得到、加得上，就是我们想要的
**零摩擦发现入口**；真要 7×24 常驻就跑萬星。

我们的做法是**再挂一个投影头**，不加第二套规则：

```
registry-bridge 快照（enabled server）
   ↓  facet/mcp-catalog.js  visibleTo(entry, null)   ← 唯一可见性规则
公开 server（groups = []）
   ↓  facet/mcp-registry-json.js  projectServerJson
GET /api/mcp-registry.json   →   { servers: [server.json…] }
   ↓  scripts/publish-mcp-registry.mjs
<out>/<ns>__<server>/server.json
   ↓  mcp-publisher publish（GitHub Actions OIDC）
registry.modelcontextprotocol.io
```

## 2. 端点（facet 侧，已实现）

| 路由 | 形态 | 缓存 |
|---|---|---|
| `GET /api/mcp-registry.json` | `{ "servers": [ … ] }` 全集 | `public, max-age=3600` |
| `GET /api/mcp-registry/<server>.json` | 单条；不可投影/不可见 → 404（探测不给信息） | 同上 |

拒写时两侧都答 **503 + `code: PROJECT_REJECTED`**（响亮失败，不是静默部分产出）。

## 3. `server.json` 形状与逐字段来源

schema：**`2025-12-11`**（`$schema` 常量集中在 `facet/mcp-registry-json.js` 的 `SERVER_JSON_SCHEMA`，
schema 一变只改这一处）。

| 字段 | 来源 | 缺失时 |
|---|---|---|
| `$schema` | 常量 | — |
| `name` | `io.github.FindDataTechnology/<entry.name>` | 无 name → 跳过 |
| `description` | `entry.description` 截到预算内 + 尾部漏斗文案，**整条 ≤ 100 字符**（见下） | 空 → **跳过该条** |
| `version` | **无来源 → 固定 `0.0.1` 占位** | — |
| `remotes[0].type` | 固定 `streamable-http` | — |
| `remotes[0].url` | `entry.configTemplate.url`，**必须 https + 公网域**（见 §6） | 空/内网 → 跳过该条 |
| `remotes[0].headers` | **一律省略** | — |
| `title` | `entry.displayName`（与 name 不同时） | 省略 |
| `repository` / `websiteUrl` | **省略**（server 条目无 `repositoryUrl`，那是 skill 才有的） | — |

### `description` 为什么有 100 字符上限

官方 schema 对 `description` 有 **100 字符硬上限**，超了 registry 直接
**422 `expected length <= 100`（`location: body.description`）**。这条**只有真发布才会暴露**——
dry-run 是我们本地校验，看不见服务端约束。2026-10-31 首次真发布时，14 条里
6 条短的过了、8 条长的被拒，就是这么发现的。

所以整个描述（正文 + 漏斗尾缀）**共享一个 100 字符预算**：先预留尾缀
（`— 想 7×24 常驻 → 萬星`，12 字符），剩下的才是正文额度，正文按**码点**截断
（不是 UTF-16 code unit——中文一个字就是 1，emoji 算 1 但要占 2 个 code unit，
按码点截才不会劈开代理对）并补 `…` 表示被截。

实测：`airegistry-tools` 211→100、`fd-legal-search-mcp` 230→100、`vaas-wanxing` 166→100。

### `version` 为什么是 `0.0.1`

`registry-bridge.js` 的 `mapServer` **不产出任何版本语义**，而官方 schema 必填 `version`。
三个选项里我们选第三个：

1. 伪造 `1.0.0` → 假装有版本管理，升级时说不清；
2. 挪用 `packs.db` 的 pack 版本 → 那是**功能集**的版本，不是 server 的；
3. **固定 `0.0.1` 占位 + 文档写明无版本语义** ← 当前的诚实做法。

真正的语义化版本要等 registry 侧（或我们的 bridge）有 server 版本概念，届时改这一处常量即可。

### 为什么 `remotes[].headers` 整块不写

`configTemplate.headers` 里是字面量占位符 `Authorization: "Bearer <your_token>"`——
**不是真凭据**，`CREDENTIAL_RE` 也不会命中它。但仍然一律不写：免键端点的鉴权走
OAuth discovery，静态 header 塞进去只会让没有凭据的客户端**装成坏的**。

## 4. 认证与 namespace —— 只有一条正路

| 方式 | 拿到的 namespace | 结论 |
|---|---|---|
| `mcp-publisher login github`（设备流） | **仅个人** `io.github.<你的用户名>/*` | ❌ **不能用**（见下） |
| **GitHub Actions OIDC** | **组织** `io.github.<org>/*` | ✅ **唯一免费正路** |
| `login github --token <PAT>`（Owner + `read:org`） | 组织 | 备选，需造长期 PAT |
| `login dns` / `login http` | 自有域名 `cloud.finddatatech/*` | 后续品牌升级（§7） |

**硬约束（官方 Warning + registry issue #1468）**：交互式 `login github` 走 GitHub App token，
**读不到组织成员关系**，registry 只会授予个人 namespace。所以本地手工登录**发不到**
`io.github.FindDataTechnology/*`——它不会报错，只会静默发到**另一个 namespace**，
这是最坏的失败形态。

→ 因此 CI 化不是省事选项，是**组织 namespace 的唯一免费正路**。

## 5. 上架流程

> **管道宿仓（重要）**：`workflow_dispatch` 要求 workflow 在**默认分支**，而主仓
> （私有）是 PRIVATE 且其账号私有 Actions 额度已耗尽（2011/2000，run 5 秒即红）。
> 所以实际执行仓是 **`FindDataTechnology/mcp-registry-publish`**（公开、只放管道）：
> 公开仓标准 runner 免费无限，OIDC 又按**仓库所属组织**授权命名空间。
> 脚本与 workflow 的**源仍在主仓**（`scripts/publish-mcp-registry.mjs` +
> `.github/workflows/mcp-registry-publish.yml`），改那里再同步过去，不要两头各写一套。
>
> **两仓一致性（2026-10-31 起）**：workflow 与脚本自 `reconcile-registry-workflow-source`
> 起**两仓逐字节一致**；源在主仓，改动后同步执行仓（`gh api -X PUT …/contents/…`）。
> 判据：`diff` 主仓文件与 `gh api` 解码结果为空。`retire` 通道与默认 skip 名单已在两侧
> 同型；`environment:` 两侧均未引用（加门步骤见 §5.1 第 3 条）。

### 5.1 一次性准备（人工，每个执行者一次）

1. 执行者账号必须是 **`FindDataTechnology` 组织 Owner**（OIDC 按组织角色授权，不按名字）；
2. 确认 `facet` 服务可匿名访问 `/api/mcp-registry.json`；
3. （可选）给发布仓的 `publish` job 加 Environment 审批门——两仓 workflow 一致，
   均**未引用** `environment:`；加门需在 workflow 里补一行，并在**执行仓**建同名
   Environment（主仓建了也没用，它不承担运行）。

### 5.2 dry-run（先验，不写也不发）

```bash
node scripts/publish-mcp-registry.mjs --facet-url https://facet.finddatatech.cloud --dry-run
# 或在管道仓：
gh workflow run mcp-registry-publish.yml -R FindDataTechnology/mcp-registry-publish
```

输出逐个 server 的目标 URL + 整批校验结论。workflow 的 `dry-run` job 每次跑这条
（含每周一定时），**投影回归会在 CI 变红，而不是让发布列表悄悄变陈旧**。

> ⚠️ **dry-run 绿 ≠ 能发布**。服务端约束（如 §3 的 description 100 字符上限）
> 只在真调用时才会以 422 暴露。dry-run 只能证明我们的形状自洽。

### 5.3 发布

```bash
gh workflow run mcp-registry-publish.yml \
  -R FindDataTechnology/mcp-registry-publish -f confirm=publish
```

workflow：`dry-run` → `publish`（`permissions: id-token: write` → `mcp-publisher login github-oidc`
→ 逐 server `mcp-publisher publish`）。首次发布即认领组织 namespace，其后是更新。

**重复发布是正常的**：已上架的版本会答
`400 invalid version: cannot publish duplicate version: <name>@<version> already exists`。
这不是失败——该条已在目录里。版本固定 `0.0.1`（见 §3），所以重跑必然命中这一条。

### 5.4 验证

```bash
# 用 /v0.1/ —— 2026-10-31 实测：/v0/servers 已改为服务另一套旧数据集
# （6100 条里 io.github.* 命中 0），当前名录在 /v0.1/servers。
curl -s "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.FindDataTechnology&limit=50" | head -c 800
```

> **当前状态（2026-10-31，三轮上产 + 真发布打通）**
>
> | 轮次 | 镜像 | 生产实测 |
> |---|---|---|
> | v1 | `sha-e8ab24c` / digest `5bdcab7b` | `GET /api/mcp-registry.json` **200**，返回 **21** 条——其中 **7 条端点是集群内网**（`http://cheapN.mesh.finddata.cn:3189x/mcp`） |
> | v2 | `sha-f9c81fa` / digest `2c513040` | 同端点 **200**，返回 **14** 条，**内网端点 0 条**；单条 `fd-info.json` 200 + `Cache-Control: public, max-age=3600`，被丢弃的 `fd-quant.json` 返 **404**（不给信息） |
> | v3 | `sha-08f4835` / digest `f3db9969` | 同端点 **200**，14 条**描述全部 ≤100 字符**（211→100、230→100、166→100）；`publish-mcp-registry.mjs --dry-run` **14/14 全绿** |
>
> **发布结果（2026-10-31 终态）：名录 11 active / 14 含已撤**，与投影逐条一致。
> `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.FindDataTechnology&limit=50&include_deleted=true"`
> → 14 条，逐条核 `version=0.0.1`、`remotes[0].url` 全为 `https://mcp.finddatatech.cloud/<server>/mcp`、
> 描述超 100 字符 **0 条**；其中 3 条测试 cell 为 `deleted`（见下）。
>
> 两轮打通的细节：首发 run 41142472745（OIDC 一次就通，6 条过 / 8 条 422 描述超限）→
> v3 修复后复跑 run 41143983762（8/14 新发布成功，另 6 条 duplicate 属重复提交）。
>
> **测试 cell 已撤（2026-10-31）**：官方 Registry **没有 DELETE 端点**（规格标 optional，实测 501），
> 撤单机制是生命周期状态——`PATCH /v0.1/servers/{name}/versions/{version}/status`（或
> `mcp-publisher status --status deleted --all-versions`）。`deleted` 默认不出现在名录，
> 且可 `--status active` 恢复。工作流新增 `retire` 通道（`confirm=retire`）与**默认 skip 名单**，
> 后者防止未来的发布 run 把这三条重新发回去。
>
> 7 条内网 server 已被投影层丢弃；要公开发布，先在 registry 源侧把注册地址改成公网网关
> （已按线开出需求单，见 `docs/registry-maintenance.md` §15.108 续记四）。

## 6. 发布前核对门（每次发布都要过）

| 门 | 判据 | 由谁保证 |
|---|---|---|
| 发布源是公开投影 | 只消费 `/api/mcp-registry.json`（groups=[] 的 server），不读私有源码仓 | 脚本只接受 facet URL |
| 零凭据形状 | 整份序列化产出跑 `CREDENTIAL_RE`，命中即整批 `PROJECT_REJECTED` | `facet/mcp-registry-json.js` |
| 无 headers 块 | `remotes[].headers` 恒缺席；脚本二次校验 | 投影器 + 脚本 `validateDoc` |
| **端点公网可达** | `remotes[].url` 必须 https 且非内网（`mesh.finddata.cn` / `cheapN` / RFC1918 / loopback / `.local` / `.internal`） | 投影器 `isPubliclyReachable`（运行时丢弃该条）+ 脚本 `validateDoc` 二次拒（整批不发布） |
| 形状合法 | 必填 `name`/`description`/`version` + `remotes[]`；name 反向 DNS 恰好一个 `/` | 脚本 `validateDoc`（整批，不部分发布） |
| **描述 ≤100 字符** | registry 服务端硬上限，超了 422 | 投影器 `composeDescription`（码点截断保漏斗尾缀）+ 脚本 `validateDoc` 二次拒 |
| last-good | 暂存目录构建 → 全过才原子替换；失败保留上一份 | 照抄 `export-marketplace-repo.mjs` |

### 为什么「端点公网可达」是硬门（2026-10-31 上产实测）

投影首次上产时暴露：registry 里有 **7 个 server 的 `configTemplate.url` 是集群内网地址**
（`http://cheap6.mesh.finddata.cn:31893/mcp` 一类）。直接投出去有两条后果，任一都不可接受：

1. **对陌生人是一条死链**——公共 Registry 的读者在公网上解析不到 `.mesh.finddata.cn`，
   也到不了 `cheapN` 节点端口；
2. **永久泄漏内网拓扑**——Registry 是公开目录，收录后主机名与端口布局就留在那儿了，
   和「公开即不可撤回」叠加。

所以这类条目**不投影**（运行时 `isPubliclyReachable()` 返回 false → 该条跳过并记原因，
其余照出），发布脚本再拒一次（整批不发布）。修法不是在投影层"改写成公网域名"——
那会凭空造出一个我们没验证过的地址；正确修法是把该 server 的注册地址改成公网网关
（`https://mcp.finddatatech.cloud/<server>/mcp`），这是 registry 侧的运营动作。

## 7. 后续品牌升级路径：`cloud.finddatatech/*`

域名验证命名可以让 server 叫 `cloud.finddatatech/<server>`，比 GitHub 组织名更像品牌，
但要多一次性的 DNS（或 HTTP）证明。**本变更不实现，只记录路径**：

```bash
mcp-publisher login dns --domain finddatatech.cloud --private-key key.pem
# apex 加 TXT（注意：落在 apex，不是 selector）：
#   finddatatech.cloud. IN TXT "v=MCPv1; k=ed25519; p=<PUBLIC_KEY>"
```

三个实操坑（已核）：TXT 必须在 **apex**；Ed25519 需 **OpenSSL 3**（macOS 自带 LibreSSL 会失败，
换 ECDSA P-384 可绕）；轮换必须先删旧 TXT 再发新的。

## 8. 三条诚实边界

1. **官方 Registry 仍在冻结/预览期**（v0.1 API freeze，v1 未 GA）。我们按 `2025-12-11` 实现，
   官方可能 breaking change 甚至数据重置——所以 `$schema` 与字段映射集中在一处，变动时一处改。
2. **公开即不可撤回**。一旦被 registry 收录、被客户端缓存/安装，改靠 unlist 与通知，
   **用户已安装的副本收不回**。发布前那几个核对门就是为这一刻准备的。
3. **投影不反映写状态**。投影只读快照；registry 侧停用/改可见性在**下一个刷新周期**（≤1h 缓存
   + bridge TTL）生效，不是瞬时。

## 9. 排错

| 现象 | 根因 | 处置 |
|---|---|---|
| 端点 503 + `PROJECT_REJECTED` | 某个 server 的 description 等字段里有凭据形状串 | 按上游发布闸查该 pack；**不要**临时放宽 `CREDENTIAL_RE` |
| 发布成功但 registry 搜不到 | 发到了个人 namespace（用了交互式 login） | 改用 workflow 的 OIDC job，核对 `name` 前缀 |
| `mcp-publisher publish` 403 | 执行者不是组织 Owner / 未开 `id-token: write` | 见 §5.1 |
| dry-run 报 `name 不是反向 DNS 形` | server 名带非法字符（含额外 `/`、空格） | 在 registry 侧改名，投影器不放宽 |
| registry 列表少了一台 server | 该 server 有 required groups（非公开），或 description/url 缺失 | 预期行为（design C2/C3），不是 bug |
