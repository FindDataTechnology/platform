# 缺陷报告：owner provider 与平台 provider 的 id 撞车

**日期**：2026-11-24
**报告人**：完成 `fleet-run-concurrency` 的会话（复核 `finddata-4c` 的结论时发现）
**发现途径**：核实 4c 报的「写 A 读 B」时，实测推翻了原结论，但从同一段代码里测出这条
**归属 change**：`paas/openspec/changes/add-user-supplied-credentials`（在途，5 任务未完成）
**状态**：已实测复现，未修复（等作者定产品方向）

---

## 一句话

`createProviderForOwner` 的去重只对照 **owner 自己的** provider，不看平台层的。
于是用户能创建一个与平台 provider **同 id** 的个人 provider，而读路径会把平台那条
**过滤掉** —— 用户用自己的 key 静默覆盖了平台的同名服务。

---

## 证据（可复现）

```js
// 复现脚本（PLATFORM_DATA_DIR 指向临时目录，先 initDb）
import db from './db.js';            await db.initDb();
import * as m from './llm-providers.js';
const owner = "u@test";

// 1) 平台层建一个
m.createProvider({ name: "plat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-a" });
console.log("平台层:", (await m.listProvidersForOwner(owner)).map(p => p.name));
//   → [ 'plat' ]

// 2) owner 建一个【同名】的
const d = await m.createProviderForOwner(owner, { name: "plat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-c" });
console.log("返回的 id:", d.id);                       // → 'plat'  ← 与平台同 id
console.log("owner 视图:", (await m.listProvidersForOwner(owner)).map(p => p.name));
//   → [ 'mine', 'plat' ]  ← 注意：平台那条已不在列表里（被同 id 遮住）
```

实测输出（2026-11-24）：

```
A 写JSON→按owner读: [ 'plat' ]
B create返回 models 类型: string ["deepseek-v4-pro"]
C 字符串数组 PUT 被拒: invalid each model entry must be an object
D 对象数组 PUT → 读回: ["added-via-put","deepseek-v4.1-flash"]
E 与平台同名→复用id: plat | owner视图: [ 'mine', 'plat' ]
```

---

## 根因（两处，缺一不可）

### 1. 去重集合只取 owner 自己的

```js
// llm-providers.js:379
const existing = new Set((await getOwnerProviders(owner, { cryptoOpts })).map((p) => p.id));
// llm-providers.js:380-384 同名的检查也只遍历 getOwnerProviders(owner)
```

`getOwnerProviders` 只读 SQLite 里该 owner 的行（`:302-303`），**不含** `readProvidersDoc()`
里的平台 provider。所以 `uniqueId(name, existing)`（`:490`）认为 `plat` 可用。

### 2. `RESERVED_IDS` 不覆盖平台用户自建

```js
// llm-providers.js:98
export const RESERVED_IDS = new Set(["ciyuan", "volces"]);
```

只保护环境注入的那条保留路由。平台管理员经 `createProvider()` 建的普通 provider
不在保护集里，因此它们的 id 可被 owner 复用。

### 3. 读路径的过滤让后果从「重复」变成「覆盖」

```js
// llm-providers.js:333-337
export async function listProvidersForOwner(owner, { cryptoOpts } = {}) {
  const mine = await getOwnerProviders(owner, { cryptoOpts });
  const mineIds = new Set(mine.map((p) => p.id));
  const platform = readProvidersDoc().providers.filter((p) => !mineIds.has(p.id)); // ← 这里
  return [...mine, ...platform];
}
```

平台层里同 id 的那条被 `filter` 掉。而 `getProviderRecordForOwner`（`:341-348`）
优先返回 owner 的那条 ⇒ **运行时也真的用用户的 key**，不只是显示层面。

---

## 影响面

- **可达性**：`authEnabled=false`（本机 / 桌面 / e2e，均为受支持形态）时
  `ownerEmail(req)` 只要有 email 就非 null，而写路径 `isAdmin` 恒 true →
  **任何有身份的调用者都能触发**。
- **危害等级**：用户有机会把自己指向的「平台 provider」换成自己的 key/URL（URL 仍受
  `assertKnownUpstream` 白名单约束，所以不是 SSRF）。但**计费与配额的归属会被改**，
  且用户在 UI 上看不到自己覆盖了平台的东西（列表里只剩一条）。
- **不涉及**：密钥泄露（apiKey 仍是加密存储、仍是自己的）。

---

## 建议的修法（需产品先定方向）

方向必须先定，三条互斥：

| 方案 | 行为 | 代价 |
|---|---|---|
| **A 拒绝** | owner 建与平台同 id/同名的 provider → `duplicate` 错误 | 最简单；用户想用同名就得改个名 |
| **B 换 id** | owner 的 id 自动让位（`plat-2`），两条并存 | 需要 `existing` 纳平台 id，且 `RESERVED_IDS` 不该是静态集合 |
| **C 允许覆盖**（显式） | 用户主动「接替平台 provider」 | 需要 UI 显式声明 + 审计，语义最重 |

我倾向 **B**：它是当前代码意图的自然延伸（`uniqueId` 本来就是干这个的），只需把
`existing` 的来源扩大：

```js
const existing = new Set([
  ...(await getOwnerProviders(owner, { cryptoOpts })).map((p) => p.id),
  ...readProvidersDoc().providers.map((p) => p.id),   // ← 加这一行
]);
```

同名检查同理要扩（否则同名的仍是错误，而同 id 不同名的就能被换 id 放行——两者应一致）。

**注意**：`updateProviderForOwner`（`:403`）与未来的 DELETE 走的是「按 owner 找」，
所以换 id 之后这些路径不受影响。但 `listProvidersForOwner` 的过滤逻辑要复查一遍——
`mineIds` 与平台 id 不再可能相交，那个 filter 变成无害但冗余，可保留。

---

## 与 4c 原报告的差异（我实测推翻的部分）

4c 报的是「读写分叉键不同 ⇒ 保存静默不生效」（读看 `owner !== null`、写看 `isAdmin`）。
**实测不成立**：`listProvidersForOwner` 返回 `[...owner, ...platform]`，写 JSON 后
按 owner 读**能读到**（证据 A）。所以「写 A 读 B」这条不成立，不必按 P0 处理。

`llm-model-sync` 的 `[null,null]` 另有解释：`normalizeModelsInput` 只接受**对象数组**
`{id}`，接口返回的是**字符串数组**——调用方（UI 的 `ModelListEditor`）发的是对象数组，
所以正常；若某处传了字符串数组会被 `invalid` 拒掉（证据 C）。这是接口形状不一致的
隐患，不是当前的红因。

---

## 建议

1. **挂到 `add-user-supplied-credentials` 的 tasks**（不是 `fleet-run-*` 名下）。
2. 验收加一条判据：*owner 创建的 provider，其 id 不得与任何平台 provider 相同；
   创建后平台 provider 必须仍在 owner 的列表里*。
3. 我未改该文件——它在别人的在途 change 名下，且修法涉及产品方向（A/B/C 三选一）。
