# fix-zhiyu-seat-settle-missing-billing-key

## Why

智语席位能答，但**答完的账落不下去**。生产实测（2026-11-10 19:03，镜像 `sha-0ef03c7`）：

```
[zhiyu] settle failed for bTnrv2P_JhmCzqqXCF0GIA:intro-guide in zy_42ce690574b5423bd2 (seq 112):
        host-settle HTTP 404: {"error":"no such deployment"}
```

即：访客提问 → 产品向导正常作答（seq 112 落了 agent 行）→ 回合结束后结算被拒 404。**内容是通的，计费是断的。**

### 404 的真实形态（`curl -i` 原样抓取，pod `platform-7db8449c78-zr7gf`）

```
### 404 case: intro-guide
POST {PACKS_INTERNAL_BASE}/api/packs/internal/deployments/bTnrv2P_JhmCzqqXCF0GIA/intro-guide/host-settle
  -H "Content-Type: application/json"  -H "Authorization: Bearer <internal token>"
  -d '{"usage_id":"probe-headers-1","minutes":1}'

HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Content-Length: 30
ETag: W/"1e-8ouT8eCVcN2daXbYJt2Dcg5Z28I"
Date: Tue, 10 Nov 2026 11:16:43 GMT
Connection: keep-alive
Keep-Alive: timeout=5

{"error":"no such deployment"}
```

同一端点、同一凭据、同一请求体，对另一个部署行的对照（`wx-alpha`）：

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Content-Length: 50
ETag: W/"32-bRtZWlBNuP4Kq387P4+xzLN86/s"

{"settled":true,"duplicate":false,"amountUsd":0.1}
```

### 面有多大（同一时刻逐个打）

| 部署 | 版本 | skills | host-settle |
|---|---|---|---|
| `intro-guide` / `intro-yizuo` / `intro-lex` / `intro-wire` / `intro-facet` | v1 | `[]` | **404 ×5** |
| `wx-alpha` | v2 | `["wx-wizard-check"]` | 200 `$0.1` |
| `data-scout` | v1 | `["quick-look"]` | 200 `$0.1` |

### 根因（已定位到行）

404 出自 `facet` 的 `/app/gateway/packs-internal-routes.js:93`：

```js
const key = registry.deploymentKeyForAgent(
  decodeURIComponent(req.params.packId),
  decodeURIComponent(req.params.agentId),
  typeof req.body?.deployed_by === "string" && req.body.deployed_by ? req.body.deployed_by : null,
);
if (!key) return res.status(404).json({ error: "no such deployment" });
```

而 `deploymentKeyForAgent`（`/app/gateway/packs.js:1118`）查的是 **`deployment_keys`** 表，**不是 `deployments`**：

```js
deploymentKeyForAgent(packId, agentId, deployer = null) {
  if (deployer) {
    const mine = db.prepare(`SELECT * FROM deployment_keys WHERE pack_id = ? AND agent_id = ? AND deployer = ?`).get(packId, agentId, deployer);
    return mine ? { keyRef: mine.key_ref, keyValue: mine.key_value, deployer: mine.deployer } : null;
  }
  const rows = db.prepare(`SELECT * FROM deployment_keys WHERE pack_id = ? AND agent_id = ? ORDER BY created_at ASC`).all(packId, agentId);
  return rows.length ? { keyRef: rows[0].key_ref, keyValue: rows[0].key_value, deployer: rows[0].deployer } : null;
}
```

`intro-*` 五个部署**在 `deployments` 里齐全、在 `deployment_keys` 里没有行**（它们部署于 2026-10-30 前后，`deployedBy=aloadtree@gmail.com`，`skills=[]`），于是席位能路由（agentPath 有效）但结算找不到计费键。错误的**文案是误导性的**——"no such deployment" 掩盖了真正缺失的是计费键。

## 两条路线的影响面、回滚成本与先后顺序

### ① 补发计费键（回填 `deployment_keys`）

**改哪里**：只动数据，不动代码。按 `deployments` 里缺少对应键的行，生成 `deployment_keys`（`key_ref` / `key_value` / `deployer`），五个 `intro-*` 各一行。

- **影响面**：仅"今后还能结算"——`intro-*` 五席从"能答不能算账"变成"答了就记账"。**不追溯**：已发生的 10 次作答（演示房 `answers=10`）不会补账，历史账本不变。
- **风险点**：①`key_value` 从哪来。若由 sub2api 侧签发，则需先确认它在对方系统里有对应主体，否则补了键也会在真正扣费时报错（把 404 换成 4xx）。②`deployer` 必须与部署行一致（`aloadtree@gmail.com`），否则 `deploymentKeyForAgent` 带 `deployed_by` 查询仍会落空——这一条是 ① 最容易做错的地方。
- **回滚成本**：**低且干净**。删掉这五行即回到今天的状态（`DELETE FROM deployment_keys WHERE pack_id='bTnrv2P…' AND agent_id LIKE 'intro-%'`），无代码回滚、无镜像重出。
- **验证成本**：一次 `curl -i` 打五席即可（期望 `200 {"settled":true,"duplicate":false}`）；再加一次真机提问，看 `pack_host_settlements` 增行、日志无 `settle failed`。

### ② 结算侧降级（区分"无计费键"并如实标注）

**改哪里**：`facet` 的 `packs-internal-routes.js`（404 文案/状态码，如 409 + `{"error":"no billing key"}`）＋ `paas` 的 `gateway/zhiyu/agent-lane.js`（结算失败不再只 `console.warn`，要让回合结算记录里带"未计费"标注）。

- **影响面**：**所有**包、所有部署——不只是智语。任何调用 host-settle 的路径都会看到状态码/文案变化，若上游有按 404 分支的逻辑，会被打断（需先 grep 消费方）。
- **风险点**：这是跨服务契约改动（facet ↔ paas），且 `agent-lane.js` 的标注要落进回合记录，涉及 `captureTurnOutcome` 的字段形状——比 ① 大一个量级。
- **回滚成本**：**中**。代码改动需重新出片 + 滚版；且若已把"未计费"写进历史回合记录，回滚代码不会回滚数据。
- **验证成本**：两个仓分别出片；还要造一次"无键部署"的样本才能验降级路径。

### 先后顺序（建议）

1. **先 ②，后 ①**（与我最初的直觉相反，理由是判据而非偏好）：② 是**观测能力**——它让"有多少部署在裸答"变成可见事实；没有它，①补完五席之后，**下一个漏签的部署仍然静默裸答**，我们只在有人翻日志时才知道。先把"看不见"变"看得见"，再补已知的五个。
2. ② 落地后，用它的输出**重新数一遍**真实缺键面（可能不止 `intro-*` 五个），再执行 ①。
3. ① 单独一次 dry-run → apply，可随时 `DELETE` 回滚，不留代码债。

**如果你只想做一件**：做 ①（立刻止损、可回滚、零代码）；但要接受"下次还会静默漏"。**如果要做对**：② 在前。

## 裁决与 A/B 结论（2026-11-10，用户裁决：走 ② 降级，不动 `deployment_keys`）

**裁决**：结算侧降级。`deployment_keys` 有多消费者（wanxing facade、matters、admin 管理面），擅动会连带中断，故**一个字节都不改**；相关项在 tasks 里挂起并注明。

**A/B：套件挂起与本次改动无关**。跑 `scripts/test-platform-billing.mjs` 时该套件任何真实用例都会挂起（`cancelled`，`Promise resolution is still pending`）。用 `git stash push -- <我改的 5 个文件>` 把改动整体挪开、在**原始代码**上重跑，记录如下：

| 场景 | 代码状态 | 结果 | 耗时 |
|---|---|---|---|
| `--test-name-pattern="gate, shape, happy path"`（既有 host-settle 用例） | **原始**（改动已 stash） | `cancelled`，`Promise resolution is still pending` | 100s（撞 `timeout` 退出码 124） |
| 同上 | 我的改动 | `cancelled`，同一条消息 | 100s |
| `--test-name-pattern="deploy: no sub2api config degrades to keyless"`（**不碰** host-settle） | **原始** | `cancelled`，同一条消息 | 90s |
| `--test-name-pattern="ZZZ-no-such-test-name-ZZZ"`（空过滤） | 原始 | 通过 | **1s** |

结论：不是我的改动引入的，也不是 host-settle 这条用例特有——**该文件里任何真实用例在本机都会挂**（空过滤 1 秒退出，说明模块本身能加载）。定位到 harness 收尾：`close: () => new Promise((r) => server.close(r))`，`server.close()` 要等既有 keep-alive 连接结束才回调，undici 的连接池不主动关，于是永不 resolve。这与既有记忆「该套件在 CI 上历史全 cancelled、可挂 50+ 分钟」一致。

**用不依赖该 harness 的最小脚本验证契约本身（PASS，34ms，干净收尾）**：

```
{
 "keyless": { "status": 409, "code": "NO_BILLING_KEY",     "error": "no billing key for this deployment" },
 "missing": { "status": 404, "code": "NO_SUCH_DEPLOYMENT", "error": "no such deployment" },
 "elapsedMs": 34, "verdict": "PASS"
}
teardown clean (no keep-alive hang)
```

脚本路径与要点：`createPackRegistry` + `registry.publish` + `registry.recordDeployment`（**只写部署行、不写计费键**）→ `registerInternalPackRoutes` → 两次 `POST .../host-settle`（带 `Bearer runner-svc-token`）→ 断言 409/`NO_BILLING_KEY` 与 404/`NO_SUCH_DEPLOYMENT` → `server.closeAllConnections(); server.close()`。

**zhiyu 侧回归**（settle 失败不再只 warn，改为落 `settle_unbilled` 事件行 + 回合记录带 `detail.unbilled`）：

```
test-zhiyu-billing        pass=3  fail=0 cancelled=0
test-zhiyu-rooms          pass=17 fail=0 cancelled=0
test-zhiyu-room-lifecycle pass=11 fail=0 cancelled=0
test-zhiyu-router         pass=8  fail=0 cancelled=0
```

## What Changes

（本单先记录与定性。修复方案见任务，实施前需一次决策：是**补发计费键**还是**让结算对无键部署优雅降级**。）

- 记录：404/200 的完整响应形态、五个受影响部署、根因到行、以及"文案与事实不符"这一点。
- 待决策：①部署时未签发计费键的席位，补键（回填 `deployment_keys`）还是 ②结算侧识别"无计费键"并返回一个可区分的状态（如 409/404 但 body 明说 `no billing key`），让上层能如实标注"这条回合未计费"。
- 无论选哪条，`zhiyu` 侧 SHALL 在结算失败时**如实降级**：目前只 `console.warn`，房间与运维面都看不到"这条回答没计费"。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

（无——待方案定稿后再定是否动 spec。若最终选择"结算对无键部署降级并如实标注"，则需在 `zhiyu-room` 的「计费与配额挂钩」上补一条 delta；本单当前阶段只记录，不动契约。）

## Impact

- 受影响：演示房 `zy_42ce690574b5423bd2` 的四个 agent 席（+ `intro-facet` 一个未在席的部署）。它们**每一次作答都不计费**。
- 不在本单范围：费率、历史用量回填、其它包。
- 关联线索：本次发现源于 `clarify-zhiyu-guest-failure-copy` 的真机验证回合（访客提问 → 作答 → 结算 404）。
