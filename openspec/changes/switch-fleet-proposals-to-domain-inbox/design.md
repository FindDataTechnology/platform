# 设计：舰队提案目标切到域提案箱

## 现状（写这份设计时能核实的事实）

- **知验台侧已就绪**：C5 交付了 `POST /api/d/{domain_key}/proposals`（鉴权：域 token 或岗位身份行；
  幂等键 `(domain, source, external_key, pending)`；缺依据 400；跨域 403；同键已驳回需新证据）、
  提案箱只读列表、确认/驳回两条写路由，以及内核唯一写入路径。验收证据见 law-bench
  `openspec/changes/add-domain-first-workbench/acceptance.md` §5.3：真确认一次 → `knowledge_units` +1、
  `authoring_events` +1、`domain_proposal_events` pending→confirmed。
- **柏讯侧是今天的提交目标**：交付前，本体草案由舰队的提案岗交给柏讯动作审批队列，再由人确认。
  这条链与「已发布本体的权威源是平台」相悖（C3 裁定），且其动作提案模型不认识业务域。
- **取证已完成（2026-11-08，任务 1.1）**：出口链路、驱动位置与「不止一个出口」的情形见下节
  「切换点」。取证同时修正了本 change 立项时的一个措辞 —— 它不是「往审批队列塞一条提案」，
  而是**在客户租户里声明实体类型**，两件事的语义差别决定了切换的后果。

## 切换点（D1）—— 取证结果（2026-11-08）

### 一个出口函数，两处驱动

| 层 | 位置 | 事实 |
|---|---|---|
| 出口工具 | `wire-ops-mcp/wire_ops_mcp/tools_console.py:280` `wire_action_propose(action_type_id, values, source_ref=None)` | MCP 工具，POST `{target_cell}/api/v1/domain-actions/propose`；**即时返回 pending**，工具面结构性无 execute |
| 上游实现 | `fd-wire/api/fd_wire_api/domain_actions/routes.py`（`/api/v1/domain-actions/propose`） | 落动作实例台账，owner 在柏讯控制台确认后才执行 |
| 动作类型 | `fd-wire/api/fd_wire_api/domain_actions/builtins.py:41-50` `BUILTIN_ENTITY_DECLARE="entity-declare"` / `BUILTIN_RELATION_DECLARE="entity-relation-declare"`（内置、负数哨兵 id `-1`/`-2`） | 平台内置类型，不是客户自声明 |
| 岗位驱动 | `fleet-packs/blueprints/ontology-builder/blueprint.json:121`（`agents[ob-deployer].promptTemplate`）、`:292`（persona）、`:311-313`（`allowTools` 声明 `wire_action_list/propose/status`） | **生产里真正决定投递的是这段提示词**，不是某个 if 分支 |
| 执行落点 | 同上 `builtins.py` 确认执行 | 直调 `entities.service.create_entity` / `create_relationship`：写入**该客户租户的实体/关系元数据**，不写客户数据行 |

### 「不止一个出口」的那一半

`blueprint.json:121` 同时写着过渡态：**若内置动作类型尚未在册，当日改走 `escalate` 提案**
（「过渡态：owner 手工落」）。任务是逐点覆盖，所以切换必须同时处理：

1. `wire_action_propose` + `entity-declare` / `entity-relation-declare`（主路）；
2. `escalate` 过渡态（备路）—— 否则内建类型一旦不可用，草案又悄悄回到人肉兜底，
   而落点仍在客户租户，平台域提案箱拿不到任何东西。

### 语义差别（决定了这个 change 的后果，必须记下来）

今天的出口**按客户租户**声明实体类型：每个客户 cell 一份，owner 逐个确认，落点是该租户的元数据。
C5 的目标**按平台域**收敛本体：一个域一份权威本体，域负责人确认进 `knowledge_units`，
再经发布面（`ontology_publications` + 消费面拉取）下发。

所以这不是「换个 URL」，是「本体权威源上移」的落实：**切换后舰队不再在客户租户里声明实体类型**，
改为向平台域提案；客户侧拿到的本体改由发布面供给。`entity-declare` 类型本身留在柏讯
（客户侧域动作仍有它的位置），本 change 只关停「舰队把本体草案发到那里」这条用法。

### 出口形状

- 入口保持一个：岗位每轮产出草案 → 出口函数 → `POST {BENCH_URL}/api/d/{domain}/proposals`。
- 出口函数必须是**单函数命令式**、目标 URL 与凭据全部来自 env、`transport=` 注入缝供测试
  （与 `fd-wire` 的 `bench_pull/client.py` 同款形状，理由相同：契约测试不发真网）。
- 明确**不做**「双写」（柏讯 + 知验台同时写）。双写会让「谁的确认算数」变成长期悬念，
  正是本 change 要消灭的问题。

## 切换前基线（D5 左值，2026-11-08 实测）

在 `fd-prod` 的 `fd-wire-api` pod 内直接查库（`FD_WIRE_DATABASE_URL`）：

```
select type_id, status, count(*) from domain_action_instances group by 1,2;
```

| type_id | 含义 | status | 条数 |
|---|---|---|---|
| -1 | `entity-declare`（内置） | executed | 5 |
| -2 | `entity-relation-declare`（内置） | executed | 6 |
| | | **合计** | **11** |

- **零条客户侧业务动作**：这个断面上今天的流量 100% 是本体类提案。
- 来源标注全是本体舰队：`fleet=fleet_1793422472811_i28xac; post=m_1793422472811_lnok88`（声明提案员），
  外加一条 `fleet=ontology-smoke;post=deployer;target=cell:drillcust00` 冒烟。
- 没有 `pending` 行（11 条全 executed）—— 切换不会把任何人的待办留在柏讯。

**判据**：切换后一轮真跑，此断面 `type_id in (-1,-2)` **增量必须为 0**；同时知验台对应域提案箱
`+N` 且控制台可见。左值 = 11，右值 = 11（不增）。


## 身份行（D2）

提交体字段（与 C5 提交面逐字对齐）：

| 字段 | 来源 | 约束 |
|---|---|---|
| `source` | 岗位身份 | `fleet:<fleet_id>/<post_id>`，跨轮稳定；不得含空格或 `/` 以外的分隔歧义 |
| `kind` | 本轮草案 | 必须在该域模板词表内（对端 400 拒绝出表 kind） |
| `external_key` | 本轮草案 | 实体的业务键；关系类按 `{from}->{kind}:{to}` 约定 |
| `evidence` | 本轮草案 | **必填**且可核对；对端缺依据一律 400 |
| `submitted_by` | 岗位身份 | 用于对端「自提自确认」禁令判定 |

去掉了柏讯动作提案里的 `target（账号/工作区）`：本体的归属是**域**，不是某个客户的工作区。
`tool_risk` 一类字段也不进提交体 —— 提案本身不执行任何动作。

## 域 key 从哪来（D3）

域 key 是**岗位配置**（`BENCH_PROPOSAL_DOMAIN`），由舰队开岗时显式给出，与岗位的 `target` 同源。
理由：

- 从内容猜域（关键词匹配）会静默投错域，错了没有人会察觉 —— 提案箱里有一条不属于本域的草案是
  最难发现的一类错误。
- 硬编码 `legal` 会把第一条垂直线固化成平台默认值，等银行/供应链开域时必然复制粘贴。
- 缺配置时提案岗本轮**失败**并报明缺失的 env 名，不退化到任何缺省域。

## 幂等与失败纪律（D4）

- 同 `(domain, source, external_key)` 且对端已有 pending 行 → 对端返回既有行，本轮记为「幂等命中」，
  不新增、不报错、不重复计数。
- 被驳回的键再次提交同一 `evidence` → 对端 400（`同键已驳回，需新证据`）；提案岗 SHALL 把这条
  如实记进本轮报告，并**停止对该键的自动重试**（换证据是人的判断，不是轮次的机械行为）。
- 对端 401/403/5xx/超时 → 本轮记失败，草案留在本轮产物里等下一轮；绝不吞成「已提交」。
- 凭据缺失 → 启动不崩，本轮明确失败（报 env 名）。

## 柏讯侧收口（D5）

- 柏讯的 `/api/actions/propose` 继续服务**客户侧域动作**，语义不动。
- 本体类提案 SHALL 在柏讯侧零新增。判据不是「代码里删了调用」而是**一轮真跑后两侧计数对照**：
  知验台提案箱 +N，柏讯队列该类 +0。
- 历史行不迁移、不删除：已确认的历史提案是审计记录。

## 风险

- **回归风险集中在出口函数被谁调用**。若生产里不止一个调用点（例如巡检岗也提交草案），切换点必须
  逐点覆盖，否则会出现「一半进知验台、一半还在柏讯」的中间态。任务 1.1 取证要覆盖所有调用点。
- **对端不可达时的表现**：本轮失败，下一轮重试同一草案 —— 需要确保草案跨轮可重现（岗位产物落盘），
  否则失败即丢失。这是提案岗既有产物纪律，本 change 不新增机制，只要求在报告里体现「失败未丢」。

## 上产实证（2026-11-08）

出口、接线与岗位三件已全部落产，证据都取「能红的那一侧」：

| 环节 | 证据 |
|---|---|
| law-bench 提交面 `created` | 线上同键两投 → `created:true` 后 `created:false`（id 1），证明「新增 vs 幂等命中」不是自检查 |
| 舰队凭据 | `fleet:ontology-builder` 自管 api key（`content:read`+`content:write`）+ `legal` 域 `expert` 成员；提交口只挂 `_WRITE_GATES` |
| 生产接线 | `platform` 镜像 `sha-0b54470`；pod 内 `server/bench-proposal-mcp.js` 与 `lib/bench-proposal-client.js` 存在、`BENCH_*` 三项在 env 里 |
| 工具可见 + 真提交 | pod 内 stdio 探针：`initialize` → `bench-proposal-mcp`，`tools/list` → `['bench_proposal_submit']`，`tools/call` → `{"id":1,"created":false,"result":"幂等命中"}`（复用探针键，零新增行） |
| 岗位切换 | pack `YT87-2Axuu49I123zVYyhA` v9 上架并回读：`wire-ops` 只剩 7 个只读工具，`bench-proposal:["bench_proposal_submit"]`，提案员提示词指向新出口 |
| 左值不增 | `domain_action_instances` 断面 `type_id in (-1,-2)` 仍为 11（-1:5 / -2:6，全 executed），切换后零新增 |

**两个必须记住的接线陷阱**（都会「看起来对了、实际静默失败」）：

1. **dsh 会擦除 MCP 子进程环境里形似凭据的名字**（含 `*TOKEN*`）。只把 `BENCH_CONSUMER_TOKEN` 放进环境变量不够，
   mcp.json 那一行必须用 `envRefs` 显式转发，否则子进程只看到「未配置」。
2. **bench 的 Bearer 通道是绑定式的**：存在但非法的 Bearer 直接 401，不回落到 `X-API-Key`。
   因此自管 `lbk_` key 只能走 `X-API-Key`，JWT 才走 Bearer —— 客户端按前缀二选一，绝不同时发两条
   （第一版镜像就是在这里 401 的，探针抓到、第二版修正）。

**仍待一轮真跑**：上表证明的是「通道通、计数不增」，还差一次真实舰队回合把 `+N` 打出来
（左值 11 → 右值仍 11，同时提案箱 +N 且控制台可见）。探针行已带理由驳回，不占提案箱。
