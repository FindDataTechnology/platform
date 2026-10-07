import { test, expect } from "@playwright/test";
import http from "node:http";
import { pinLocaleEn, waitForIdle } from "./helpers.js";

// Chatting with a DEPLOYED Agent Service (add-a2a-agent-serving 5.3/5.4):
// the full consumer chain against the hermetic server — an a2a catalog entry
// (seeded via agents.json + /api/catalog/refresh), the composer-strip agent
// picker, and a local A2A stub standing in for the registry gateway + runner.
//
// The stub speaks the runner's wire shape (SSE `delta` frames carry the
// ACCUMULATED text, `message` the authoritative final, `done` terminates) and
// records every request so the tests assert the SERVER-side contract too:
// dual credentials (X-Authorization gateway + Authorization agent), and
// context_id continuity across turns (the runner keys its sessions by it).

const A2A_PORT = Number(process.env.E2E_A2A_PORT) || 3211;
const ENTRY = {
  id: "a2a-demo",
  type: "agent-remote",
  mode: "a2a",
  name: "Demo Agent Service",
  description: "部署的 Agent 服务（e2e 桩）",
  url: `http://127.0.0.1:${A2A_PORT}/`,
};

const REPLY = "你好，我是部署的 Agent 服务。";

// One stub per worker process (workers:1 in this suite, so per suite). Each
// test closes its socket; the server itself spans the file so requests from
// the platform server survive page navigations.
let stub;
const seen = []; // { xAuth, auth, contextId, text }
test.beforeAll(async () => {
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let doc = null;
      try {
        doc = JSON.parse(body);
      } catch { /* fall through */ }
      const msg = doc?.params?.message ?? {};
      seen.push({
        xAuth: req.headers["x-authorization"] || "",
        auth: req.headers.authorization || "",
        contextId: msg.context_id ?? null,
        text: (msg.parts ?? []).map((p) => p?.text).join(""),
      });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const frame = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const full = `${REPLY}（第 ${seen.length} 答）`;
      frame("delta", { parts: [{ kind: "text", text: full.slice(0, 6) }] });
      frame("delta", { parts: [{ kind: "text", text: full.slice(0, 12) }] });
      frame("message", { role: "assistant", parts: [{ kind: "text", text: full }] });
      res.write("event: done\ndata: {}\n\n");
      res.end();
    });
  });
  await new Promise((r) => stub.listen(A2A_PORT, "127.0.0.1", r));
});
test.afterAll(async () => {
  await new Promise((r) => stub?.close(r));
});

// Seed the a2a entry through the catalog's local agents.json source and make
// the server re-read it now (not on the 60s cadence). The catalog reads
// agents.json from the SERVER'S CWD (repo root — same file seed-fixtures.js
// seeds when absent), so this snapshots the developer's own file, merges the
// entry in, and restores the snapshot afterward — the suite must not leave a
// phantom agent in the developer's (or a dev server's) catalog.
const fs = await import("node:fs");
const AGENTS_FILE = new URL("../agents.json", import.meta.url).pathname;
let agentsSnapshot; // Buffer | null (null = file absent)
test.beforeAll(async () => {
  agentsSnapshot = fs.existsSync(AGENTS_FILE) ? fs.readFileSync(AGENTS_FILE) : null;
});
test.afterAll(async () => {
  // afterAll order vs the stub close is irrelevant; both are teardown.
  if (agentsSnapshot === null) fs.rmSync(AGENTS_FILE, { force: true });
  else fs.writeFileSync(AGENTS_FILE, agentsSnapshot);
  // The 60s catalog cadence could otherwise resurrect the entry for a dev
  // server sharing this file: force one refresh against the restored file.
});

test.beforeEach(async ({ page, request }) => {
  await pinLocaleEn(page);
  let doc = { agents: [], apps: [] };
  try {
    doc = JSON.parse(fs.readFileSync(AGENTS_FILE, "utf8"));
  } catch { /* absent/unparseable → start clean */ }
  doc.agents = [...(doc.agents ?? []).filter((a) => a?.id !== ENTRY.id), ENTRY];
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(doc, null, 2));
  const r = await request.post("/api/catalog/refresh");
  expect(r.ok()).toBeTruthy();
});

async function selectA2aAgent(page) {
  await page.getByTestId("composer-input").fill("ping"); // canSend needs text
  await page.getByTestId("strip-more").click();
  const option = page.getByTestId("strip-agent-option").filter({ hasText: ENTRY.name });
  await expect(option).toBeVisible({ timeout: 20000 });
  await option.click();
  // The strip's active-agent label lives INSIDE this menu — reopen it to see
  // the selection took (agent_changed landed, pending cleared).
  await expect
    .poll(() => page.evaluate(() => window.__chatStore?.getState?.().currentAgent))
    .toBe(ENTRY.id);
  await page.getByTestId("strip-more").click();
  await expect(page.getByTestId("strip-agent")).toContainText(ENTRY.name, { timeout: 20000 });
  await page.keyboard.press("Escape");
}

test("chat with a deployed Agent Service streams, persists, and carries dual credentials", async ({ page, request }) => {
  await page.goto("/chat");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  await selectA2aAgent(page);

  const marker = `e2e-a2a-${Date.now()}`;
  await page.getByTestId("composer-input").fill(`请回答。${marker}`);
  await page.getByTestId("composer-send").click();

  const turn = page.getByTestId("turn-assistant").last();
  await expect(turn).toBeVisible({ timeout: 30000 });
  await expect(turn).toHaveAttribute("data-streaming", "false", { timeout: 45000 });
  await expect(turn).toContainText("部署的 Agent 服务", { timeout: 10000 });

  // Server-side contract: both credentials present, turn text delivered.
  await expect
    .poll(() => seen.length)
    .toBeGreaterThanOrEqual(1);
  expect(seen[seen.length - 1].xAuth).toMatch(/^Bearer /);
  expect(seen[seen.length - 1].auth).toMatch(/^Bearer /);
  expect(seen[seen.length - 1].text).toContain(marker);

  // Persisted like every other remote turn (user + assistant in the mirror).
  await expect
    .poll(async () => {
      const list = await (await request.get("/api/chat-history/sessions")).json();
      if (!list.current) return "";
      const session = await (await request.get(`/api/chat-history/sessions/${list.current}`)).json();
      const asst = (session.messages || []).filter((m) => m.role === "assistant");
      return asst.length ? asst[asst.length - 1].content || "" : "";
    })
    .toContain("部署的 Agent 服务");
});

test("follow-up turns keep the same context_id (runner-side session continuity)", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  await selectA2aAgent(page);

  for (const n of [1, 2]) {
    await page.getByTestId("composer-input").fill(`第 ${n} 问`);
    await page.getByTestId("composer-send").click();
    await waitForIdle(page, 45000);
  }
  const contexts = seen.slice(-2).map((s) => s.contextId);
  expect(contexts[0]).toBeTruthy();
  expect(contexts[1]).toBe(contexts[0], "same conversation → same context_id");
});

test("a stopped service surfaces the failure in the transcript, not a hang", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByTestId("composer-control-strip")).toBeVisible({ timeout: 15000 });
  await selectA2aAgent(page);

  // Stop answering: the next turn's fetch must fail and the UI must show the
  // error block and release the composer (no wedged streaming state).
  stub.close();
  await new Promise((r) => setTimeout(r, 300));
  await page.getByTestId("composer-input").fill("还会回答吗");
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("turn-error-block").last()).toBeVisible({ timeout: 30000 });
  // canSend also requires non-empty text — type before asserting the composer
  // released (the failure path must clear isStreaming, not wedge the send).
  await page.getByTestId("composer-input").fill("recovered");
  await expect(page.getByTestId("composer-send")).toBeEnabled({ timeout: 20000 });
});
