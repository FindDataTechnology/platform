// scripts/browser-lane-smoke.mjs — image smoke for the browser lane
// (add-browser-use-lane, task 2.2). Proves the lane for real inside the built
// image: spawns server/browser-mcp.js the way the MCP client does, completes
// the MCP initialize handshake, and asserts the tool surface is non-empty.
//
// Launching chromium itself is NOT part of this gate — it is the operation
// proof's business. What this catches is the image-layer failure class (a
// missing runtime, a broken launcher, a wrong BROWSER_MCP_CLI): the lane's
// process must at least speak MCP.
//
// Run inside the image:  node /app/scripts/browser-lane-smoke.mjs
// Exit 0 = the lane speaks MCP; anything else prints the reason and exits 1.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAUNCHER = join(REPO_ROOT, "server", "browser-mcp.js");
const TIMEOUT_MS = Number(process.env.BROWSER_SMOKE_TIMEOUT_MS) || 60_000;

// The smoke OWNS an output dir and passes it as the production wiring does
// (BROWSER_OUTPUT_DIR): a deployment that routes lane artifacts somewhere
// unwritable (the first version fell back to a read-only cwd: "EACCES: open
// '/app/page-….yml'") fails here, and an unconfigured default is exercised by
// whatever the CLI picks — never a path this script cannot assert on.
const SMOKE_OUT = mkdtempSync(join(tmpdir(), "browser-lane-smoke-out-"));
const child = spawn(process.execPath, [LAUNCHER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, BROWSER_OUTPUT_DIR: SMOKE_OUT },
});
let stderr = "";
child.stderr.on("data", (c) => (stderr += String(c)));

const answer = new Promise((resolve, reject) => {
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += String(chunk);
    let idx = buf.indexOf("\n");
    while (idx !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.on("exit", (code) => reject(new Error(`launcher exited (code=${code}): ${stderr.trim().slice(-300)}`)));
  child.on("error", (err) => reject(new Error(`launcher spawn failed: ${err?.message || err}: ${stderr.trim().slice(-300)}`)));

  let nextId = 0;
  const call = (method, params) => {
    const id = ++nextId;
    return new Promise((res, rej) => {
      pending.set(id, (msg) => (msg.error ? rej(new Error(`${method} error: ${JSON.stringify(msg.error).slice(0, 200)}`)) : res(msg.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  (async () => {
    try {
      await call("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "browser-lane-smoke", version: "0" },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      const tools = await call("tools/list", {});
      const count = Array.isArray(tools?.tools) ? tools.tools.length : -1;
      if (count <= 0) {
        resolve({ tools: count, navigation: "skipped" });
        return;
      }
      // Launch the browser for real: about:blank needs no outbound network and
      // is exactly the step that catches an image whose browser binaries exist
      // but whose SYSTEM libraries do not (apt state does not cross Docker
      // stages — the 2026-10-28 first roll shipped the lane's files in the
      // builder stage only). A tool that answers without launching would not
      // have caught it, so the gate navigates.
      const nav = await call("tools/call", { name: "browser_navigate", arguments: { url: "about:blank" } });
      const text = JSON.stringify(nav ?? {}).slice(0, 300);
      if (!nav || nav.isError === true || /error/i.test(nav?.content?.[0]?.text ?? "") && !/about:blank/.test(text)) {
        throw new Error(`browser_navigate(about:blank) did not launch a browser: ${text}`);
      }
      // The report path must never be the OS temp dir: @playwright/mcp's own
      // default is a query against its config wiring (2026-10-28: a wrong
      // `browser.outputDir` nesting put screenshots at /tmp/.playwright-mcp,
      // where the cell's capture hook rejected them with invalid_path). A file
      // written under tmpdir reproduces under every CI worker too.
      const shot = await call("tools/call", { name: "browser_take_screenshot", arguments: { filename: "browser-lane-smoke.png" } });
      const shotText = JSON.stringify(shot ?? {}).slice(0, 400);
      if (!shot || shot.isError === true) {
        throw new Error(`browser_take_screenshot failed: ${shotText}`);
      }
      const written = existsSync(SMOKE_OUT) ? readdirSync(SMOKE_OUT) : [];
      if (!written.length) {
        throw new Error(`no artifact landed in the configured BROWSER_OUTPUT_DIR (${SMOKE_OUT}); response: ${shotText}`);
      }
      resolve({ tools: count, navigation: `about:blank ok; ${written.length} artifact(s) in outputDir` });
    } catch (err) {
      reject(err);
    }
  })();
});

// An image built WITHOUT the browser lane says so on stderr
// ("@playwright/mcp is not installed in this deployment"). Absence is fine —
// but only when the image does not CLAIM the lane: the Dockerfile that bakes
// it also exports BROWSER_MCP_CLI, so a claimed-but-missing runtime is a broken
// bake and must fail. (2026-10-27: a build that predated the Dockerfile layer
// hit the 60s timeout; distinguishing "declared absent" from "claimed but
// broken" keeps the release unblocked AND keeps the gate's teeth.)
const LANE_ABSENT = /@playwright\/mcp is not installed in this deployment/;
const LANE_CLAIMED = Boolean((process.env.BROWSER_MCP_CLI || "").trim());
const skipIfLaneAbsent = () => {
  if (!LANE_ABSENT.test(stderr)) return false;
  if (LANE_CLAIMED) {
    console.error(
      "browser-lane-smoke: FAIL — this image claims the browser lane (BROWSER_MCP_CLI is set) " +
        `but the runtime is missing: ${process.env.BROWSER_MCP_CLI}`,
    );
    process.exit(1);
  }
  console.log("browser-lane-smoke: SKIP — this image declares no browser lane (BROWSER_MCP_CLI unset)");
  process.exit(0);
};

const timeout = setTimeout(() => {
  try { child.kill("SIGKILL"); } catch {}
  if (skipIfLaneAbsent()) process.exit(0);
  console.error(`browser-lane-smoke: TIMEOUT after ${TIMEOUT_MS}ms — no MCP answer. stderr tail:\n${stderr.trim().slice(-500)}`);
  process.exit(1);
}, TIMEOUT_MS);

try {
  const out = await answer;
  clearTimeout(timeout);
  child.kill("SIGTERM");
  if (!out || out.tools <= 0) {
    console.error(`browser-lane-smoke: tools/list returned ${out?.tools} tools — expected a non-empty browser tool surface`);
    process.exit(1);
  }
  console.log(`browser-lane-smoke: MCP handshake + tools/list ok (${out.tools} tools); browser_navigate → ${out.navigation}`);
  rmSync(SMOKE_OUT, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  clearTimeout(timeout);
  if (skipIfLaneAbsent()) process.exit(0);
  console.error(`browser-lane-smoke: FAIL — ${err?.message || err}`);
  process.exit(1);
}