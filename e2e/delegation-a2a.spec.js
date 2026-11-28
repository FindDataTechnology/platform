// ── Cross-agent delegation e2e (add-agent-delegation-a2a 5.1) ────────────────
//
// The delegated a2a task's full cell-side chain against the hermetic server:
// seeding an a2a catalog entry (agents.json + refresh, the agent-serving
// pattern) and standing a wire-shape A2A stub for the market agent, a
// delegation to it (REST create, the MCP tool's own loopback) must:
//   • execute as a REMOTE turn — the stub sees message/stream with BOTH
//     credentials and X-Delegation-Depth: 1 (human-originated baseline);
//   • land the stub's reply in the task's dedicated session and finish the
//     task (result endpoint serves it);
//   • surface in discovery (search endpoint lists the seeded entry);
//   • refuse an unknown ref at creation;
//   • badge the task card as remote (market agent).
// The runner-side depth-≥3 refusal is covered at the runner test level
// (scripts/test-agent-runner.mjs) — this stub is not the runner.

import { test, expect } from "@playwright/test";
import http from "node:http";
import fs from "node:fs";
import { pinLocaleEn } from "./helpers.js";

const A2A_PORT = Number(process.env.E2E_A2A_PORT) || 3219;
const ENTRY = {
  id: "a2a-deleg-probe",
  type: "agent-remote",
  mode: "a2a",
  name: "Delegation Probe Agent",
  description: "市场委派探针（e2e 桩）",
  category: "分析",
  url: `http://127.0.0.1:${A2A_PORT}/`,
};
const REPLY = "远端执行完毕：三只个股均跑赢基准。";

const seen = [];
let stub;
test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let doc = null;
      try { doc = JSON.parse(body); } catch { /* fall through */ }
      const msg = doc?.params?.message ?? {};
      seen.push({
        depth: req.headers["x-delegation-depth"] ?? null,
        xAuth: req.headers["x-authorization"] || "",
        auth: req.headers.authorization || "",
        contextId: msg.context_id ?? null,
      });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const frame = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      frame("delta", { parts: [{ kind: "text", text: REPLY.slice(0, 6) }] });
      frame("message", { role: "assistant", parts: [{ kind: "text", text: REPLY }] });
      res.write("event: done\ndata: {}\n\n");
      res.end();
    });
  });
  await new Promise((r) => stub.listen(A2A_PORT, "127.0.0.1", r));
});
test.afterAll(async () => {
  await new Promise((r) => stub?.close(r));
});

const AGENTS_FILE = new URL("../agents.json", import.meta.url).pathname;
let agentsSnapshot;
test.beforeAll(async () => {
  agentsSnapshot = fs.existsSync(AGENTS_FILE) ? fs.readFileSync(AGENTS_FILE) : null;
});
test.afterAll(async () => {
  if (agentsSnapshot === null) fs.rmSync(AGENTS_FILE, { force: true });
  else fs.writeFileSync(AGENTS_FILE, agentsSnapshot);
});

test.beforeEach(async ({ page, request }) => {
  await pinLocaleEn(page);
  seen.length = 0;
  let doc = { agents: [], apps: [] };
  try { doc = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8")); } catch { /* start clean */ }
  doc.agents = [...(doc.agents ?? []).filter((a) => a?.id !== ENTRY.id), ENTRY];
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(doc, null, 2));
  const r = await request.post("/api/catalog/refresh");
  expect(r.ok()).toBeTruthy();
});

test("delegating to a market agent runs a depth-1 remote turn that lands as the task output", async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.goto("/chat/");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });

  // Discovery: the seeded entry is searchable.
  const search = await request.get("/api/delegation/agents?search=deleg");
  expect(search.ok()).toBeTruthy();
  const found = (await search.json()).agents;
  expect(found.some((a) => a.id === ENTRY.id)).toBeTruthy();

  // Unknown ref is refused at creation.
  const unknown = await request.post("/api/delegation/tasks", { data: { agent: "ghost-agent", prompt: "x" } });
  expect(unknown.status()).toBe(400);

  // The delegation itself.
  const created = await request.post("/api/delegation/tasks", {
    data: { agent: ENTRY.id, prompt: "分析三只个股", name: "远端探针" },
  });
  expect(created.status()).toBe(201);
  const task = (await created.json()).task;
  expect(task.target).toEqual({ type: "a2a", ref: ENTRY.id });

  try {
    // The remote turn: the stub sees the delegation contract exactly — dual
    // credentials and depth 1 (spec: agent-delegation-a2a).
    await expect
      .poll(async () => seen.length, { timeout: 120_000 })
      .toBeGreaterThanOrEqual(1);
    expect(seen[0].depth).toBe("1");
    expect(seen[0].xAuth.length).toBeGreaterThan(0);
    expect(seen[0].auth.length).toBeGreaterThan(0);

    // The reply is the task's output (result endpoint + finished state).
    await expect
      .poll(async () => {
        const r = await request.get(`/api/delegation/tasks/${task.id}/result`);
        const doc = await r.json();
        return doc.state;
      }, { timeout: 120_000 })
      .toBe("done");
    const result = await (await request.get(`/api/delegation/tasks/${task.id}/result`)).json();
    expect(result.output).toContain("跑赢基准");
  } finally {
    await request.delete(`/api/chat-history/sessions/${task.sessionId}`).catch(() => {});
  }
});

test("a market-agent tool invocation badges the task card as remote", async ({ page, request }) => {
  await page.goto("/chat/");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15_000 });

  const created = await request.post("/api/delegation/tasks", {
    data: { agent: ENTRY.id, prompt: "badge probe", name: "徽标探针" },
  });
  const task = (await created.json()).task;
  try {
    // Inject the tool turn the way dsh would have streamed it (the
    // delegation spec's seam) — the card binds the live record by id.
    await page.evaluate(
      (id) => {
        const s = window.__chatStore;
        s.getState().apply({ type: "agent_start" });
        s.getState().apply({
          type: "tool_start",
          toolCallId: "delegation-a2a-1",
          name: "mcp__delegation__delegate_task",
          args: { agent: "a2a-deleg-probe", prompt: "badge probe" },
        });
        s.getState().apply({
          type: "tool_end",
          toolCallId: "delegation-a2a-1",
          name: "mcp__delegation__delegate_task",
          result: `Task delegated.\n- id: ${id}\n- market agent: a2a-deleg-probe (remote)\n- state: queued\n`,
        });
        s.getState().apply({ type: "done" });
      },
      task.id,
    );
    await page.evaluate(() => window.__chatStore.getState().toggleAllGroups());
    const card = page.getByTestId("task-card");
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByTestId("task-card-remote")).toBeVisible();
  } finally {
    await request.delete(`/api/chat-history/sessions/${task.sessionId}`).catch(() => {});
    await request.post("/api/chat-history/sessions").catch(() => {});
  }
});
