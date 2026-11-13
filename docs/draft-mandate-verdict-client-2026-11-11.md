# 已落地 · 在 `agent-runner/index.js:112` 注入 `mandateVerdictClient`

> **2026-11-11 已按用户全权授权落地**：提交 `a5ca95d9b`，两文件 42 行纯插入。
> 验证：`node --check` 双通过、agent-runner 五套 34 项全绿、outbound-gate/fleet-delegation/
> personal-auditor 全绿、四种 env 组合的「缺一即不注入」实测符合预期。
> 回滚：删 `MANDATE_VERDICT_URL` 与 `MANDATE_VERDICT_TOKEN` 即回 `no_verdict_client`。
> 以下保留起草时的判断与判据原文，便于复核。

> 只起草。本轮**没有改任何代码**。下面是需要批准的补丁、判据、回滚点与验收。

## 一、为什么要这一步（实测结论）

`agent-runner/manager.js:1186-1192` 的闸门：

```js
async #mandateVerdict({ domain, text, declaredSources, channelRevocable }) {
  const client = this.mandateVerdictClient;
  if (typeof client !== "function") return { ok: false, reason: "no_verdict_client" };
  ...
}
```

`agent-runner/index.js:112` 生产构造只传三个实参：

```js
const manager = new ChildManager({
  config,
  registryClient,
  clientFactory: wrappedFactory,
});
```

⇒ `mandateVerdictClient` 恒为 `null` ⇒ 只要某个 agent entry 声明了 `mandateDomain`，
**那一轮必被 `no_verdict_client` 拦下**（`manager.js:1030-1040` 抛 `-32013`）。
全仓唯一注入方是测试文件。**这是对外车道的真实断点，A/B 与密钥都排在它之后。**

## 二、最小补丁（3 处，共约 30 行）

### 补丁 1 · `agent-runner/config.js`：新增两个可选项（默认空 = 不注入）

在 `fleetUrl` / `fleetToken` 那一组旁边加：

```js
    // 对外披露闸的裁决通道（add-principal-disclosure-gate D8）。
    // 两个都配齐才注入客户端；任一为空 ⇒ 不注入 ⇒ 闸门维持
    // no_verdict_client 的失败关闭，行为与打补丁前逐字节相同。
    mandateVerdictUrl: (env.MANDATE_VERDICT_URL || "").replace(/\/+$/, ""),
    mandateVerdictToken: env.MANDATE_VERDICT_TOKEN || "",
```

**为什么复用 `MANDATE_VERDICT_TOKEN`**：cell 侧 (`actions.js:617`) 读的就是这个变量名，
两侧必须同值；不新起名字就不会出现「两个键各自漂移」。

### 补丁 2 · `agent-runner/index.js`：构造时按配置注入

```js
// 披露闸客户端（design D8）：两个 env 都齐才注入。缺一个就保持 null ——
// 闸门会以 no_verdict_client 失败关闭，与打补丁前完全一致。
const mandateVerdictClient =
  config.mandateVerdictUrl && config.mandateVerdictToken
    ? async ({ domain, text, declaredSources, channelRevocable }) => {
        // 超时即失败关闭：宁可不发，也不要在网上挂着等。
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 5000);
        try {
          const r = await fetch(`${config.mandateVerdictUrl}/api/actions/mandate-verdict`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.mandateVerdictToken}`,
            },
            body: JSON.stringify({ domain, text, declaredSources, channelRevocable }),
            signal: ctl.signal,
          });
          // 非 2xx 一律不成「放行」：503（未配置）/401（错 token）/5xx 都算拒绝。
          if (!r.ok) return { ok: false, reason: `verdict_http_${r.status}` };
          const j = await r.json();
          if (!j || typeof j !== "object") return { ok: false, reason: "bad_verdict" };
          return { ok: j.ok === true, decision: j.decision, reason: j.reason ?? null,
                   violations: Array.isArray(j.violations) ? j.violations : [] };
        } catch (e) {
          return { ok: false, reason: `verdict_error: ${e?.message || e}` };
        } finally {
          clearTimeout(timer);
        }
      }
    : null;

const manager = new ChildManager({
  config,
  registryClient,
  clientFactory: wrappedFactory,
  mandateVerdictClient,
});
```

### 补丁 3 · 无（**不加新测试文件**）

理由：`agent-runner/test/mandate-verdict.test.mjs` 已覆盖闸门的三条路径
（client 缺失 → 拦、client 放行 → 过、client 拒绝 → 拦）。补丁只加「怎么造 client」，
那部分用真机判据验（见 §四），不引入 mock 自证。

## 三、为什么这个补丁是「安全的最小集」

| 设计点 | 为什么这样定 |
| --- | --- |
| 两个 env 缺一即不注入 | **不配置时与现状逐字节等价**，不会因为打补丁而改变任何现有部署的行为 |
| 非 2xx 一律 `ok:false` | 与 `actions.js` 的「未配置 503 = 拒绝，不是放行」对齐；不会把 401/503 误读成放行 |
| 5s 超时 + AbortController | 护栏：网络不通时不能把回合挂死；超时按失败关闭 |
| 异常全捕获并返回对象 | `#mandateVerdict` 已经 catch，但返回 `ok:false` 比让它 throw 更明确 |
| 复用 `MANDATE_VERDICT_TOKEN` | 两侧同值、同名，避免第二个键漂移（本项目已有 `dsh-credentials-yaml-key-drift` 先例） |
| 不在 runner 侧缓存策略 | 沿用 design D8：缓存过期窗口就是越权窗口 |

## 四、验收判据（五条，缺一不可）

| # | 判据 | 怎么验 |
| --- | --- | --- |
| 1 | **不配置时行为不变** | 不打这两个 env 起 runner；声明了 `mandateDomain` 的回合仍以 `no_verdict_client` 被拒，其余回合不受影响 |
| 2 | client 真的注入了 | runner 启动日志或一次性探针确认 `mandateVerdictClient !== null`（**不能只看代码在**） |
| 3 | 能连到端点 | 从 runner 侧发一次请求：拿到 200 或明确 4xx，**不是** 连接失败 / 20s 超时 |
| 4 | 三态正确 | 未配置 token → 503；错 Bearer → 401；正确 Bearer → 200 且响应含 `decision` |
| 5 | 真机一条业务行 | 出现 ≥1 条 `action_audit.mandate_domain` 非空 |

**第 3 条是 A/B 的判据**：它只回答「这个地址通不通」，与选 A 还是 B 无关；反过来，
A/B 怎么选都要过第 3 条。

## 五、回滚点（按硬约束②，先写清）

| 项 | 内容 |
| --- | --- |
| 回滚方式 | **删掉两个 env 即可**——`mandateVerdictClient` 回到 `null`，闸门回 `no_verdict_client`，与打补丁前逐字节相同 |
| 影响面 | runner 进程；**cell 侧与 gateway 侧零改动**（本补丁不碰它们） |
| 不动的东西 | 不碰计费/授权列、不碰 `normalizeRoutes`、不碰 gateway 鉴权表 |
| 需不需要重新出片 | **需要**（改的是 runner 代码，随镜像走） |
| 谁会被影响 | 只有「声明了 `mandateDomain` 的 agent entry」；当前生产上按实测**没有一个 entry 声明它**（否则早就会在日志里炸出 `-32013`） |

## 六、做完这个补丁之后还剩什么

| 序 | 步骤 | 状态 |
| --- | --- | --- |
| 1 | 注入 client（本补丁） | **待批** |
| 2 | 定它打哪个地址（A: gateway 豁免 / B: cell 直连） | 排在 1 之后；判据是 §四第 3 条 |
| 3 | 注入 `MANDATE_VERDICT_TOKEN`（两侧同值） | 排在 2 之后 |
| 4 | 授 `external-comms` + 开 `supplier-thread` | 排在 3 之后 |
| 5 | 观察首条 `mandate_domain` 非空 | 终验 |

**在 1 之前，2/3/4 都不会改变任何可观察行为**——这是本轮实测推翻旧结论的核心。

---

## 七、完整 diff（**已用 `git apply --check` 验证可应用**，待批准后一次套用）

### 7.1 插入位置（行号以当前 HEAD 为准）

| 文件 | 位置 | 动作 |
| --- | --- | --- |
| `agent-runner/config.js` | **第 273 行之后**（`fleetToken: env.AGENT_RUNNER_FLEET_TOKEN || "",` 的下一行） | 插入 **5 行**（3 行注释 + 2 行 env 读取） |
| `agent-runner/index.js` | **第 112 行之前**（`const manager = new ChildManager({` 的上方） | 插入 **35 行**（client 工厂） |
| `agent-runner/index.js` | **第 115 行之后**（`clientFactory: wrappedFactory,` 的下一行） | 插入 **1 行**（`mandateVerdictClient,`） |

合计 **41 行新增、0 行删除**——纯插入，不改任何既有语句。

### 7.2 `config.js` 的 diff（hunk 头 `@@ -270,8 +270,13 @@`）

```diff
diff --git a/agent-runner/config.js b/agent-runner/config.js
--- a/agent-runner/config.js
+++ b/agent-runner/config.js
@@ -270,8 +270,13 @@ export function loadConfig(env = process.env) {
     // the Wanxing observer. Empty URL = fully inert (no spool, no timer);
     // the token is the observer's ingest credential.
     fleetUrl: (env.AGENT_RUNNER_FLEET_URL || "").replace(/\/+$/, ""),
     fleetToken: env.AGENT_RUNNER_FLEET_TOKEN || "",
+    // 对外披露闸的裁决通道（add-principal-disclosure-gate D8）。
+    // 两个都配齐才注入客户端；任一为空 ⇒ 不注入 ⇒ 闸门维持
+    // no_verdict_client 的失败关闭，行为与打补丁前逐字节相同。
+    mandateVerdictUrl: (env.MANDATE_VERDICT_URL || "").replace(/\/+$/, ""),
+    mandateVerdictToken: env.MANDATE_VERDICT_TOKEN || "",
     fleetRunnerId: env.AGENT_RUNNER_FLEET_ID || "runner-1",
     fleetSampleSecs: num(env.AGENT_RUNNER_FLEET_SAMPLE_SECS, 30),
     // Seat mailbox cadence (add-desktop-fleet-runner ④).
     mailboxPollSecs: num(env.AGENT_RUNNER_MAILBOX_POLL_SECS, 30),
```

### 7.3 `index.js` 的 diff（hunk 头 `@@ -109,11 +109,46 @@`）

```diff
diff --git a/agent-runner/index.js b/agent-runner/index.js
--- a/agent-runner/index.js
+++ b/agent-runner/index.js
@@ -108,12 +108,49 @@ const registryClient = createRegistryClient({
     // fleet's default (AGENT_RUNNER_DEFAULT_ID, itself by default).
     runnerId: config.fleetRunnerId,
     defaultRunnerId: config.defaultRunnerId,
   });
+// 披露闸客户端（design D8）：两个 env 都齐才注入。缺一个就保持 null ——
+// 闸门会以 no_verdict_client 失败关闭，与打补丁前完全一致。
+const mandateVerdictClient =
+  config.mandateVerdictUrl && config.mandateVerdictToken
+    ? async ({ domain, text, declaredSources, channelRevocable }) => {
+        // 超时即失败关闭：宁可不发，也不要在网上挂着等。
+        const ctl = new AbortController();
+        const timer = setTimeout(() => ctl.abort(), 5000);
+        try {
+          const r = await fetch(`${config.mandateVerdictUrl}/api/actions/mandate-verdict`, {
+            method: "POST",
+            headers: {
+              "content-type": "application/json",
+              authorization: `Bearer ${config.mandateVerdictToken}`,
+            },
+            body: JSON.stringify({ domain, text, declaredSources, channelRevocable }),
+            signal: ctl.signal,
+          });
+          // 非 2xx 一律不成「放行」：503（未配置）/401（错 token）/5xx 都算拒绝。
+          if (!r.ok) return { ok: false, reason: `verdict_http_${r.status}` };
+          const j = await r.json();
+          if (!j || typeof j !== "object") return { ok: false, reason: "bad_verdict" };
+          return {
+            ok: j.ok === true,
+            decision: j.decision,
+            reason: j.reason ?? null,
+            violations: Array.isArray(j.violations) ? j.violations : [],
+          };
+        } catch (e) {
+          return { ok: false, reason: `verdict_error: ${e?.message || e}` };
+        } finally {
+          clearTimeout(timer);
+        }
+      }
+    : null;
+
 const manager = new ChildManager({
   config,
   registryClient,
   clientFactory: wrappedFactory,
+  mandateVerdictClient,
 });
 
 // Fleet observability (add-fleet-event-backbone 3.1): direct-post reporter +
 // state sampler, fully inert without AGENT_RUNNER_FLEET_URL.
```

### 7.4 这套 diff 已经验过三件事

| 验证 | 命令 | 结果 |
| --- | --- | --- |
| 能干净应用 | `git apply --check -v /tmp/two-diffs3.patch`（在只含两文件的沙箱 git 仓里） | **rc=0**，两个文件都 `Checking patch ... ` 通过 |
| `config.js` 打完后语法正确 | `node --check agent-runner/config.js` | **OK** |
| `index.js` 打完后语法正确 | 复制为 `.mjs` 后 `node --check`（`.js` 后缀会被按 CJS 解析，ESM 语法检查不可靠） | **rc=0** |

**没在生产/工作树上应用**：diff 是在 `/tmp/dryrun` 的沙箱仓里试打的，`agent-runner/` 两文件在工作树里**一字未改**。

### 7.5 一次套用的命令（批准后执行）

```bash
cd /Users/chengsishi/finddata/paas
git apply /tmp/two-diffs3.patch          # 或已入库的 docs/draft-… 里的 diff
node --check agent-runner/config.js
cp agent-runner/index.js /tmp/ic.mjs && node --check /tmp/ic.mjs
npx biome check agent-runner/config.js agent-runner/index.js
timeout 300 node --test agent-runner/test/mandate-verdict.test.mjs
```

判据：`git apply` 0 输出；两个 `--check` 退出码 0；biome 无 error；
`mandate-verdict` 测试**全过**（它覆盖缺 client / 放行 / 拒绝三态）。
