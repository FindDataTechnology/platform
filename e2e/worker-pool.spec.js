import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { prepareTempStoreDirs } from "./helpers.js";

// Worker pool on a self-booted server (spec: worker-pool). The fast
// webServer runs cap 0 (serial default), so this spec boots its OWN server
// with TASK_WORKER_MAX=2 against the dead gateway: two personas' delegated
// tasks must be RUNNING simultaneously (parallelism is the capability), both
// fail on the dead LLM, the summary injects exactly once, and the primary
// runtime's persona never moves.

const REQS = (base) => ({
  async cron() {
    return (await (await fetch(`${base}/api/cron`)).json()).jobs;
  },
  async presets() {
    return fetch(`${base}/api/presets`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  },
});

test.describe("worker pool (self-booted server, TASK_WORKER_MAX=2, dead LLM)", () => {
  const port = 3310;
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let log = "";

  test.beforeAll(() => {
    const stores = prepareTempStoreDirs({ subdir: "worker-pool" });
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AGENTS_CONFIG_URL: "",
      PLATFORM_DATA_DIR: stores.root,
      DB_PATH: stores.db,
      DSH_HOME: stores.dshHome,
      MCP_CONFIG_PATH: path.join(stores.root, "mcp.json"),
      // Hermetic dead LLM (the fast webServer's own defaults).
      LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
      LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:9/v1",
      TASK_WORKER_MAX: "2",
    };
    fs.writeFileSync(env.MCP_CONFIG_PATH, JSON.stringify({
      mcpServers: { memory: { command: "node", args: ["-e", "process.exit(0)"] } },
    }));
    child = spawn(process.execPath, ["server.js"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
  });

  test.afterAll(() => {
    child?.kill("SIGKILL");
  });

  test("two personas execute in parallel; primary stays interactive; one summary", async () => {
    test.setTimeout(300_000);

    // Readiness gates on the agent (cold composition can take a while).
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await fetch(`${base}/api/ready`).then((r) => r.ok).catch(() => false);
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready, `server never became ready. Log:\n${log.slice(-2000)}`).toBe(true);

  // Roster over WS (the WS page-less client — REST has no presets endpoint).
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const roster = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`presets timeout. Log:\n${log.slice(-1500)}`)), 90_000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "presets") {
        clearTimeout(timer);
        resolve(m);
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "list_presets" }));
  });
  const current = roster.current;
  const ids = roster.presets.filter((p) => !p.broken).map((p) => p.id);
  expect(ids.length).toBeGreaterThanOrEqual(3);
  const [pA, pB] = ids.filter((id) => id !== current);

  // Collect worker_pool broadcasts while the fan-out runs.
  const poolEvents = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "worker_pool") poolEvents.push(m);
  };

  // Delegate one task to each of two personas.
  const mk = async (persona, prompt) => {
    const res = await fetch(`${base}/api/delegation/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persona, prompt, name: `worker probe ${persona}` }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).task;
  };
  const tA = await mk(pA, "worker probe A: reply with one word");
  const tB = await mk(pB, "worker probe B: reply with one word");
  const initiator = tA.initiator;

  try {
    // Parallelism: at some poll, BOTH executions are running at once (the
    // dead gateway holds each turn ~16s, so the overlap window is generous).
    // A cold first boot composes the dsh profile for a while — 180s window.
    let sawOverlap = false;
    let lastStates = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      const jobs = await REQS(base).cron();
      const a = jobs.find((j) => j.id === tA.id)?.state;
      const b = jobs.find((j) => j.id === tB.id)?.state;
      lastStates = `${a},${b}`;
      if (a === "running" && b === "running") { sawOverlap = true; break; }
      // Early exit only when both are terminal AND the overlap was provably
      // missed — otherwise a slow spawn keeps polling.
      if (["failed", "done", "interrupted"].includes(a) && ["failed", "done", "interrupted"].includes(b)) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    expect(sawOverlap, `no running-overlap observed (last: ${lastStates}). Log:\n${log.slice(-2000)}`).toBe(true);

    // Both settle failed on the dead gateway; exactly one summary lands.
    await expect
      .poll(async () => {
        const jobs = await REQS(base).cron();
        return [jobs.find((j) => j.id === tA.id)?.state, jobs.find((j) => j.id === tB.id)?.state].join(",");
      }, { timeout: 120_000 })
      .toBe("failed,failed");

    await expect
      .poll(async () => {
        const sess = await (await fetch(`${base}/api/chat-history/sessions/${initiator}`)).json();
        return (sess.messages || []).filter((m) => m.blocks?.[0]?.kind === "task_summary").length;
      }, { timeout: 120_000 })
      .toBe(1);

    // The primary never switched persona (workers are their own personas).
    const settled = await new Promise((resolve) => {
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/`);
      ws2.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "presets") { ws2.close(); resolve(m.current); }
      };
      ws2.onopen = () => ws2.send(JSON.stringify({ type: "list_presets" }));
    });
    expect(settled).toBe(current);

    // Pool-state broadcasts arrived (spawn/busy at minimum).
    expect(poolEvents.length).toBeGreaterThan(0);
  } finally {
    ws.close();
  }
});
});
