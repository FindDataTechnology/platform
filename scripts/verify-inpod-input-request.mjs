// 在产实证：结构化输入卡在「已部署的镜像」里端到端跑通（task 6.2 的证据之一）。
//
// 它不依赖浏览器登录，也不依赖 LLM：直接驱动镜像里的 stdio shim，让它在真实
// cell 上提一张卡，再由部署里的 TTL 扫尾按 `default` 策略作答。于是这一条把
// 整条已部署链路串起来验证：
//
//   shim → loopback 桥(/api/input-requests) → input_requests 行
//        → 扫尾(无人应答策略) → 长轮询返回 → 工具结果 {state, values}
//
// 用法（在目标 pod 内跑，因为要 loopback 到某个 cell；PORT 是网关 3100，不是 cell）：
//
//   CELL=$(kubectl --context cheap-ts -n fd-prod exec deploy/platform -c platform -- \
//            sh -c 'for p in $(ls /proc | grep -E "^[0-9]+$"); do tr "\0" "\n" < /proc/$p/environ \
//            2>/dev/null | grep -qx "PORT=[0-9]*" && tr "\0" "\n" < /proc/$p/environ | grep -m1 "^PORT="; done')
//   kubectl --context cheap-ts -n fd-prod exec deploy/platform -c platform -- \
//     sh -c "mkdir -p /tmp/rt && ln -sfn /app/node_modules /tmp/rt/node_modules && \
//            cat > /tmp/rt/verify-inpod.mjs" < scripts/verify-inpod-input-request.mjs
//   kubectl --context cheap-ts -n fd-prod exec deploy/platform -c platform -- \
//     sh -c "cd /tmp/rt && INPUT_REQUEST_URL=http://127.0.0.1:<cellPort> \
//            INPUT_REQUEST_OWNER_EMAIL=<an owner in that cell> node verify-inpod.mjs"
//
// 退出码 0 = PASS。
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

const TARGET = process.env.INPUT_REQUEST_URL;
if (!TARGET) {
  console.error("INPUT_REQUEST_URL required (the CELL's loopback port, not the gateway's)");
  process.exit(2);
}
const OWNER = process.env.INPUT_REQUEST_OWNER_EMAIL;
if (!OWNER) {
  console.error("INPUT_REQUEST_OWNER_EMAIL required (any owner of that cell)");
  process.exit(2);
}

const expected = `缺省值-${Date.now()}`;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.INPUT_REQUEST_MCP_SCRIPT || "/app/server/input-request-mcp.js"],
  env: {
    ...process.env,
    INPUT_REQUEST_URL: TARGET,
    INPUT_REQUEST_OWNER_EMAIL: OWNER,
    INPUT_REQUEST_SESSION_ID: process.env.INPUT_REQUEST_SESSION_ID || "verify-inpod",
    INPUT_REQUEST_WAIT_MS: "3000",
  },
  stderr: "ignore",
});
const client = new Client({ name: "verify-inpod", version: "1" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(","));
if (tools.length !== 1 || tools[0].name !== "request_input") {
  console.error("FAIL: tool face is not exactly [request_input]");
  process.exit(1);
}

const t0 = Date.now();
const res = await client.callTool({
  name: "request_input",
  arguments: {
    card: {
      type: "form",
      title: "在产实证 · 结构化输入卡",
      fields: [{ key: "nick", kind: "text", label: "昵称", required: true, default: expected }],
    },
    // default 策略会在 TTL 到点后用卡上的默认值作答——不需要人在场，
    // 正好用来验证「部署里的扫尾真的在跑」。
    policy: { onUnattended: "default", ttlSec: 1 },
  },
});
const payload = JSON.parse(res.content[0].text);
console.log("elapsed_ms:", Date.now() - t0);
console.log("state:", payload.state, "| values:", JSON.stringify(payload.values), "| by:", payload.answeredBy);

const ok = payload.state === "answered" && payload.values?.nick === expected;
console.log(ok ? "PASS" : "FAIL");
await client.close();
process.exit(ok ? 0 : 1);
