# 萬星 Agent 服务 · A2A 对外调用示例

外部程序按 A2A 协议调用谦面市场里部署的 Agent 服务。计费维持 ADR-0014 双轨：外部被叫回合按**时长**（分钟向上取整 × 费率）经萬星门面结算到调用者的 sub2api 调用键——与生态 MCP 的按次免费额度（wire 线）是两条车道，互不并轨。

## 0. 概念速览

- **Agent 服务**：功能集里带服务契约的角色部署成的常驻对话服务（有端点、有凭证）。
- **调用键**：你的 sub2api API key（`sk-…`）——身份 + 钱包 + 套餐，止步门面。
- **agent slug**：目录页的标识（如 `packs-xxxx-agent`）。

## 1. 最小 curl 走通

```bash
BASE="https://wanxing.finddatatech.cloud"
KEY="sk-你的调用键"
SLUG="目录页 agent 标识"

# ① 浏览目录（公开）
curl -s "$BASE/api/wanxing/v1/agents" -H "Authorization: Bearer $KEY" | jq '.[0]'

# ② 看 agent 卡（公开，A2A 发现）
curl -s "$BASE/api/wanxing/v1/a2a/$SLUG/.well-known/agent-card.json" | jq '.name, .url, .capabilities'

# ③ 发一个回合（JSON-RPC message/send）
curl -s -X POST "$BASE/api/wanxing/v1/a2a/$SLUG" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "jsonrpc": "2.0", "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "kind": "text", "text": "用最新数据给我一段 A 股银行板块周报" }]
      }
    }
  }'
```

回合是同步等待完成的长调用（真回合可达分钟级）——响应体即对话结果。

## 2. 语义要点

- **幂等**：带 `Idempotency-Key: <任意唯一串>` 头，网络重试不会重复结算（同一 key 落账恰一次）。
- **错误面**：
  - 无效/欠费键 → 401/402 语义（鉴权/余额），不会打到 agent；
  - 未实现方法（如 `tasks/get`）→ JSON-RPC `-32601`；
  - agent 已暂停 → 明确「已暂停」响应，非超时。
- **账单**：回合完成即按分钟结算；门面侧可查用量。SDK 侧无需关心模型——计费只看时长与费率（模型成本是平台侧的部署者车道）。

## 3. Node 最小客户端

```js
const turn = async (slug, text, idemKey) =>
  (await fetch(`https://wanxing.finddatatech.cloud/api/wanxing/v1/a2a/${slug}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.WANXING_KEY}`,
      ...(idemKey ? { "Idempotency-Key": idemKey } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text }] } },
    }),
  })).json();

console.log(await turn("packs-xxxx-agent", "PING — reply PONG", crypto.randomUUID()));
```

## 4. 与生态 MCP 车道怎么选

| 你要调的 | 车道 | 键 | 计费 |
|---|---|---|---|
| 数据/工具 MCP（fd-open-data 等） | wire 线（`mcp.finddatatech.cloud/<server>/mcp`） | `wgk-` | 按次，月度免费额度 |
| 完整 Agent 服务（对话回合） | A2A 门面（本文） | `sk-`（sub2api） | 按时长结算 |

两条键不通用：`wgk-` 只过 MCP 网关，`sk-` 只进门面。一键式体验走 [facet CLI](https://www.npmjs.com/package/@finddatatechnology/facet)（`connect` 管 wgk 侧；`prefs` 子命令还能为某个 agent 设回合完成回调与上下文收割窗）。
