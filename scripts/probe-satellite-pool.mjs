#!/usr/bin/env node
// ── Satellite sharing A/B under REAL worker-pool dispatch ────────────────────
//
// `scripts/probe-satellite-sharing.mjs` measures a RUNNING deployment (cap=0:
// 13-14 satellites per cell). This one answers the other question — what the
// change is actually worth once the pool is on — by booting the image's own
// `server.js` twice inside a SCRATCH pod:
//
//   arm "alone": MCP_SATELLITE_HOST=0  → every dsh generation spawns its own set
//   arm "share": (default)             → one host per cell, dsh attach by url
//
// Each arm mints two worker personas, delegates one task to each, waits until
// BOTH executions are `running` (the dead LLM holds each turn open), then counts
// satellites from /proc. The comparison is the capacity decision's input:
// "开一个 worker 槽到底要背多少".
//
// Scope: this boots an EXTRA server against a scratch data root. Run it in a
// disposable pod, never in the production cell — it would double-boot the app.
//
//   # inside a scratch pod of the platform image (root, so /app/mcp.json can be
//   # dropped in), with the production mcp.json at /app/mcp.json:
//   node /app/scripts/probe-satellite-pool.mjs
//   node /app/scripts/probe-satellite-pool.mjs --json
//
// Exit 0 = both arms measured; 1 = an arm failed (the log tail says why).

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const JSON_ONLY = process.argv.includes("--json");
const APP = process.env.PROBE_APP_DIR || "/app";
const PORT = Number(process.env.PROBE_PORT || 3390);
const BASE = `http://127.0.0.1:${PORT}`;
// A dead port: every turn fails fast enough to keep the slot busy ~16s, which is
// all we need — the point is two CONCURRENT dsh, not a successful answer.
const DEAD_LLM = process.env.PROBE_DEAD_LLM || "http://127.0.0.1:9/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The measurement MUST live in a file, not in an inline `sh -c`: an inline
// command line contains the very patterns it greps for ("dsh/lib/bin.js",
// "mcp.js"), so the shell counts ITSELF as one dsh and one satellite. That cost
// the first two runs of this probe their numbers (2026-11-09).
const MEASURE_SH = "/tmp/_probe_pool_measure.sh";
writeFileSync(
  MEASURE_SH,
  `d=0;dr=0;s=0;sr=0
for p in /proc/[0-9]*; do
  c=$(tr "\\0" " " < $p/cmdline 2>/dev/null) || continue
  r=$(awk "/^VmRSS/{print \\$2}" $p/status 2>/dev/null); [ -z "$r" ] && r=0
  case "$c" in
    *dsh/lib/bin.js*) d=$((d+1)); dr=$((dr+r));;
    *-mcp.js*|*mcp-server*) s=$((s+1)); sr=$((sr+r));;
  esac
done
echo "$d $((dr/1024)) $s $((sr/1024))"
`,
);

function measure() {
  const out = execFileSync("sh", [MEASURE_SH], { encoding: "utf8" })
    .trim()
    .split(" ")
    .map(Number);
  return { dsh: out[0], dshMi: out[1], satellites: out[2], satMi: out[3] };
}

// Satellites come up one per entry per runtime, not instantly: sample until the
// count stops moving, otherwise the two arms are captured at different points in
// their own ramp-up and the comparison is meaningless (measured 2026-11-09: a
// naive 3s sample read 27 while 42 were up).
async function settledMeasure() {
  let prev = -1;
  let stable = 0;
  let last = measure();
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    last = measure();
    stable = last.satellites === prev ? stable + 1 : 0;
    prev = last.satellites;
    if (stable >= 2) break;
  }
  return last;
}

// Leftovers from a previous arm would be counted as this arm's satellites — the
// 2026-11-09 run was contaminated exactly this way (a stray dsh added 14).
// Two arms on one machine only compare if the second starts from zero. Killing
// the server is not enough: its dsh children (and worker slots that were mid
// spawn) outlive the SIGKILL by a few seconds, and satellites are grandchildren.
// Wait for the machine to actually go quiet, and fail loudly if it does not —
// a silently contaminated arm produced "saved: 2 satellites" on 2026-11-09.
async function waitQuiet(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const m = measure();
    if (m.dsh === 0 && m.satellites === 0) return m;
    resetProcesses();
    await sleep(3000);
  }
  const m = measure();
  throw new Error(`machine never went quiet between arms (dsh=${m.dsh} satellites=${m.satellites})`);
}

// Same self-match trap as the measurement: an inline reset command line contains
// the patterns it greps for, so `kill -9 $p` eventually targets its own shell and
// the real leftovers survive ("machine never went quiet", dsh=1 satellites=14).
const RESET_SH = "/tmp/_probe_pool_reset.sh";
writeFileSync(
  RESET_SH,
  `for p in $(awk "/^Pid:/{print \\$2}" /proc/*/status 2>/dev/null); do
  c=$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null) || continue
  case "$c" in *dsh/lib/bin.js*|*-mcp.js*|*${APP}/server.js*) kill -9 $p 2>/dev/null || true;; esac
done
true
`,
);

function resetProcesses() {
  // Best-effort: killing a pid that is already gone is normal, and a non-zero
  // status here must not fail the probe (it did on the first run, 2026-11-09).
  try {
    execFileSync("sh", [RESET_SH]);
  } catch {
    /* nothing to clean, or nothing we may kill */
  }
}

function roster() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`);
    const t = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("roster timeout"));
    }, 20000);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "presets") {
        clearTimeout(t);
        try { ws.close(); } catch {}
        resolve(m);
      }
    };
    ws.onopen = () => ws.send(JSON.stringify({ type: "list_presets" }));
    ws.onerror = () => { clearTimeout(t); reject(new Error("ws error")); };
  });
}

async function toolCount(hostBase, name) {
  const h = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const init = await fetch(`${hostBase}/${name}/mcp`, {
    method: "POST",
    headers: h,
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } },
    }),
  });
  const sid = init.headers.get("mcp-session-id");
  const withSid = sid ? { ...h, "mcp-session-id": sid } : h;
  await fetch(`${hostBase}/${name}/mcp`, {
    method: "POST", headers: withSid,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});
  const res = await fetch(`${hostBase}/${name}/mcp`, {
    method: "POST", headers: withSid,
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  const text = await res.text();
  const names = [...text.matchAll(/"name":"([A-Za-z0-9_-]+)"/g)].map((x) => x[1]);
  return { status: res.status, count: new Set(names).size, names: [...new Set(names)] };
}

async function runArm(label, extraEnv) {
  resetProcesses();
  await waitQuiet();
  const root = `/tmp/probe-pool-${label}`;
  rmSync(root, { recursive: true, force: true });
  for (const dir of ["data", "dsh", "ws"]) mkdirSync(`${root}/${dir}`, { recursive: true });

  const log = [];
  const child = spawn(process.execPath, [`${APP}/server.js`], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      AGENTS_CONFIG_URL: "",
      PLATFORM_DATA_DIR: `${root}/data`,
      DB_PATH: `${root}/app.db`,
      DSH_HOME: `${root}/dsh`,
      AGENT_WORKSPACE: `${root}/ws`,
      MCP_CONFIG_PATH: `${APP}/mcp.json`,
      LLM_API_KEY: "sk-probe-dummy",
      LLM_BASE_URL: DEAD_LLM,
      TASK_WORKER_MAX: "2",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  const text = () => log.join("");

  try {
    let ready = false;
    for (let i = 0; i < 180 && !ready; i++) {
      ready = await fetch(`${BASE}/api/ready`).then((r) => r.ok).catch(() => false);
      if (!ready) await sleep(1000);
    }
    if (!ready) throw new Error(`never became ready:\n${text().slice(-1200)}`);

    const r0 = await roster();
    const current = r0.current;
    let pA = null;
    let pB = null;
    for (let i = 0; !(pA && pB) && i < 4; i++) {
      const res = await fetch(`${BASE}/api/agent/presets`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Probe worker ${i + 1}`, persona: `You are probe persona ${i + 1}.` }),
      });
      if (!res.ok) throw new Error(`preset mint failed: ${await res.text()}`);
      let fresh = null;
      for (let t = 0; t < 45 && !fresh; t++) {
        await sleep(2000);
        try {
          const m = await roster();
          const live = m.presets.filter((p) => !p.broken).map((p) => p.id);
          if (live.filter((id) => id !== current).length >= (pA ? 2 : 1)) fresh = live;
        } catch {
          /* retry */
        }
      }
      if (!fresh) throw new Error("minted preset never reached the roster");
      const targets = fresh.filter((id) => id !== current);
      pA = pA ?? targets[0];
      pB = pB ?? targets[1];
    }
    if (!pA || !pB) throw new Error("two worker personas could not be minted");

    const delegate = async (persona) => {
      const res = await fetch(`${BASE}/api/delegation/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ persona, prompt: "probe: reply with one word", name: `probe ${persona}` }),
      });
      if (res.status !== 201) throw new Error(`delegation failed ${res.status}: ${await res.text()}`);
      return (await res.json()).task;
    };
    const tA = await delegate(pA);
    const tB = await delegate(pB);

    let overlap = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 240_000) {
      const jobs = await fetch(`${BASE}/api/cron`)
        .then((r) => r.json())
        .then((j) => j.jobs ?? [])
        .catch(() => []);
      const a = jobs.find((j) => j.id === tA.id)?.state;
      const b = jobs.find((j) => j.id === tB.id)?.state;
      if (a === "running" && b === "running") { overlap = true; break; }
      if (["failed", "done", "interrupted"].includes(a) && ["failed", "done", "interrupted"].includes(b)) break;
      await sleep(2000);
    }
    if (!overlap) throw new Error(`no concurrent running overlap:\n${text().slice(-1200)}`);

    const measured = await settledMeasure();
    const hostMatch = /(http:\/\/127\.0\.0\.1:\d+)\/([a-z0-9-]+)\/mcp/.exec(text());
    const tools = hostMatch ? await toolCount(hostMatch[1], hostMatch[2]).catch((e) => ({ error: String(e) })) : null;
    const shared = /\[satellite-host\] sharing \d+ satellite\(s\)[^\n]*/.exec(text())?.[0] ?? null;
    const pool = /\[worker-pool\][^\n]*/.exec(text())?.[0] ?? null;
    return { arm: label, overlap, ...measured, shared, pool, tools };
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    // Wait for the child to actually exit before the next arm's reset, otherwise
    // it keeps spawning dsh while we are counting.
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      sleep(5000),
    ]);
    resetProcesses();
  }
}

try {
  const alone = await runArm("alone", { MCP_SATELLITE_HOST: "0" });
  const share = await runArm("share", {});
  const report = {
    alone,
    share,
    saved: {
      satellites: alone.satellites - share.satellites,
      satMi: alone.satMi - share.satMi,
    },
  };
  if (JSON_ONLY) {
    console.log(JSON.stringify(report));
  } else {
    const row = (r) =>
      `  ${r.arm.padEnd(5)} dsh=${r.dsh}  satellites=${String(r.satellites).padStart(3)}  sat=${String(r.satMi).padStart(5)}Mi` +
      (r.tools ? `  tools(${r.tools.count ?? "?"})=${r.tools.status ?? r.tools.error}` : "");
    console.log("");
    console.log("  worker-pool A/B (both arms: TASK_WORKER_MAX=2, two delegated turns running)");
    console.log(row(alone));
    console.log(row(share));
    console.log("");
    console.log(`  saved: ${report.saved.satellites} satellites / ${report.saved.satMi}Mi for ${alone.dsh} dsh`);
    console.log(`  satellites per dsh: ${(alone.satellites / alone.dsh).toFixed(2)} → ${(share.satellites / share.dsh).toFixed(2)}`);
    if (share.shared) console.log(`  ${share.shared}`);
    if (share.pool) console.log(`  ${share.pool}`);
  }
  process.exit(0);
} catch (err) {
  console.error(`probe-satellite-pool: FAIL — ${err?.message || err}`);
  process.exit(1);
}
