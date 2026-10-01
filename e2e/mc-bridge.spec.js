import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { prepareTempStoreDirs } from "./helpers.js";

// MC bridge e2e (spec: mission-control-bridge): a self-booted cell with the
// bridge enabled against an in-test STUB console implementing the three
// pinned endpoints (MC is alpha/external — live verification is a deployment
// checklist item, see the ops runbook). Dead LLM keeps the child task's failure
// deterministic: register → queue task (title=persona, description=prompt) →
// the cell claims and runs it → it appears in /tasks (manual category, own
// session) → the failure posts back to the console.

test.describe("mc bridge (self-booted cell + stub console)", () => {
  const port = 3320;
  const base = `http://127.0.0.1:${port}`;
  let child = null;
  let log = "";
  let consoleServer = null;
  const consoleState = { registrations: [], results: [], queue: [] };

  test.beforeAll(async () => {
    // The stub console: register / heartbeat / queue / result.
    consoleServer = http.createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch { /* empty */ }
        if (req.method === "POST" && req.url === "/api/agents/register") {
          consoleState.registrations.push(body);
          res.end(JSON.stringify({ registered: true, agent: { id: 1, name: body?.name } }));
          return;
        }
        if (req.method === "POST" && /^\/api\/agents\/\d+\/heartbeat$/.test(req.url)) {
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && req.url.startsWith("/api/tasks/queue")) {
          // Real semantics: one claim per GET, answered as {task}.
          const claimed = consoleState.queue.shift() ?? null;
          res.end(JSON.stringify(claimed ? { task: claimed } : { tasks: [] }));
          return;
        }
        const m = req.url.match(/^\/api\/tasks\/([^/]+)$/);
        if (req.method === "PUT" && m) {
          body.taskId = m[1];
          consoleState.results.push(body);
          res.end(JSON.stringify({ task: { id: m[1] } }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise((r) => consoleServer.listen(3321, "127.0.0.1", r));

    const stores = prepareTempStoreDirs({ subdir: "mc-bridge" });
    const env = {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      AGENTS_CONFIG_URL: "",
      PLATFORM_DATA_DIR: stores.root,
      DB_PATH: stores.db,
      DSH_HOME: stores.dshHome,
      MCP_CONFIG_PATH: path.join(stores.root, "mcp.json"),
      LLM_API_KEY: process.env.LLM_API_KEY || "sk-e2e-dummy-key",
      LLM_BASE_URL: process.env.LLM_BASE_URL || "http://127.0.0.1:9/v1",
      MC_BRIDGE: "1",
      MC_URL: "http://127.0.0.1:3321",
      MC_API_KEY: "stub-key",
      MC_AGENT_NAME: "e2e-cell",
      MC_POLL_MS: "300",
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
    consoleServer?.close();
  });

  test("console-dispatched task runs on the cell and reports back", async () => {
    test.setTimeout(240_000);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
      ready = await fetch(`${base}/api/ready`).then((r) => r.ok).catch(() => false);
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready, `cell never became ready. Log:\n${log.slice(-1500)}`).toBe(true);

    // Registration happened at boot.
    await expect
      .poll(() => consoleState.registrations.length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    expect(consoleState.registrations[0].name).toBe("e2e-cell");

    // Learn the roster, then dispatch a task for a non-current persona.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    const roster = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("presets timeout")), 90_000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "presets") { clearTimeout(timer); resolve(m); }
      };
      ws.onopen = () => ws.send(JSON.stringify({ type: "list_presets" }));
    });
    const persona = roster.presets.filter((p) => !p.broken).map((p) => p.id).find((id) => id !== roster.current);
    consoleState.queue.push({ id: "mc-e2e-1", title: persona, description: "console probe: reply with one word" });

    try {
      // The console task became a cell task: manual trigger, its persona, a
      // dedicated session — visible on /tasks.
      let task = null;
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline && !task) {
        const { jobs } = await (await fetch(`${base}/api/cron`)).json();
        task = jobs.find((j) => j.trigger === "manual" && j.target?.ref === persona);
        if (!task) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(task, `no console task appeared. Log:\n${log.slice(-1500)}`).toBeTruthy();
      expect(task.sessionId.startsWith("task-")).toBe(true);

      // Dead LLM → terminal state → result posted back to the console.
      await expect
        .poll(async () => consoleState.results.some((r) => r.taskId === "mc-e2e-1"), { timeout: 120_000 })
        .toBe(true);
      const result = consoleState.results.find((r) => r.taskId === "mc-e2e-1");
      expect(result.status).toBe("quality_review");
      expect(result.metadata?.paasBridge?.state).toBe("failed");
      expect((result.error || "").length).toBeGreaterThan(0);
    } finally {
      ws.close();
    }
  });
});
