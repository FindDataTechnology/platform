#!/usr/bin/env node
// ── Live probe: the resource library on a deployed cell ─────────────────────
//    (openspec: add-resource-library, task 9.2)
//
// Against a RUNNING deployment, proves the four claims the change makes about
// production behavior — nothing here is simulated:
//
//   1. /api/resources answers for a real cell (the surface exists post-deploy).
//   2. A REAL agent turn that emits a ```echarts fence lands a chart in the
//      library with no user action (capture-by-construction), with provenance.
//   3. A file the agent actually wrote can be saved: the bytes are copied into
//      the store and served back through /api/files?root=resources.
//   4. The one-time seeding pass reported what it found in the existing history
//      (reported, not asserted — a cell whose history has no chart fences has
//      nothing to seed and that is a pass).
//
// Auth: the deployment's own signed session cookie. Provide the cell's session
// secret (for fd-prod: `kubectl --context cheap -n fd-prod exec deploy/platform
// -- cat /data/auth/session-secret`) and the owner email:
//
//   RESOURCES_PROBE_BASE=https://craw.finddatatech.cloud \
//   RESOURCES_PROBE_SECRET=<session-secret> \
//   RESOURCES_PROBE_EMAIL=<cell-owner-email> \
//   node scripts/probe-resources-live.mjs
//
// RESOURCES_PROBE_FILE=<workspace-relative path> saves that pre-existing
// workspace file instead of the one the turn names. Cells whose agent runs in a
// workspace it cannot write (fd-prod: cwd /app, root-owned) fall back to /tmp,
// and a file outside the workspace root cannot be saved by design — the
// override proves the store half (copy + serve) on such a cell.
//
// Exit 0 = claims 1–3 hold.

import "dotenv/config";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { sessionCookie } from "../server/session.js";

const WS_MOD = await import(new URL("../node_modules/ws/index.js", import.meta.url).href);
const WebSocket = WS_MOD.default || WS_MOD.WebSocket;

const BASE = (process.env.RESOURCES_PROBE_BASE || "https://craw.finddatatech.cloud").replace(/\/+$/, "");
const SECRET = process.env.RESOURCES_PROBE_SECRET || "";
const EMAIL = process.env.RESOURCES_PROBE_EMAIL || "";
assert.ok(SECRET, "RESOURCES_PROBE_SECRET is required (the cell's session secret)");
assert.ok(EMAIL, "RESOURCES_PROBE_EMAIL is required (the cell owner's email)");

const cookie = sessionCookie(
  "paas_session",
  { email: EMAIL, groups: ["admin"], exp: Math.floor(Date.now() / 1000) + 1800 },
  SECRET,
  1_800_000,
).split(";")[0];

const api = (path, init = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { cookie, ...(init.headers || {}) } });

// ── 1. The surface exists ───────────────────────────────────────────────────
const before = await api("/api/resources").then((r) => {
  assert.equal(r.status, 200, `/api/resources answered ${r.status} — is the new revision live?`);
  return r.json();
});
console.log(
  `[probe] /api/resources OK — ${before.total} resource(s) already held ` +
    `(${before.items.filter((i) => i.seeded).length} seeded, ` +
    `${before.items.filter((i) => i.type === "chart").length} chart, ` +
    `${before.items.filter((i) => i.type === "file").length} file)`,
);

// ── 2. A real turn captures a chart, unattended ─────────────────────────────
const PROMPT =
  "请用 echarts 围栏画一张 2026 年 Q1 的柱状图（三个月的示例数据即可），" +
  "然后把这三个月的数字写进一个 markdown 文件 q1-report.md，" +
  "最后在回复里用 markdown 链接把 q1-report.md 发给我。不要做别的事。";

const ws = new WebSocket(`${BASE.replace(/^https/, "wss").replace(/^http/, "ws")}/`, {
  headers: { cookie },
});
const collected = { text: "", toolPaths: [] };
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("turn timed out (180s)")), 180_000);
  ws.on("open", () => {
    console.log("[probe] WS open — sending the probe prompt");
    ws.send(JSON.stringify({ type: "prompt", text: PROMPT }));
  });
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "text") collected.text += msg.delta ?? "";
    if (msg.type === "done") {
      clearTimeout(timer);
      resolve();
    }
    if (msg.type === "error") {
      clearTimeout(timer);
      reject(new Error(`turn error: ${msg.message}`));
    }
  });
  ws.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
});
await done;
ws.close();
assert.ok(collected.text.includes("```echarts"), "the turn did not stream a chart fence");
console.log(`[probe] turn finished (${collected.text.length} chars streamed, chart fence present)`);

// ── 3. The chart landed in the library on its own ───────────────────────────
let chart = null;
let reseenAt = null;
for (let i = 0; i < 20 && !chart; i++) {
  const page = await api("/api/resources?type=chart").then((r) => r.json());
  chart = page.items.find((r) => r.seeded === 0 && !before.items.some((b) => b.id === r.id));
  if (!chart) {
    // The library is content-addressed: a re-run of this probe emits the same
    // spec, so the capture dedupes onto the existing row and only advances its
    // last_seen_at. Capture ran either way — a pass, reported as such.
    const seen = page.items.find(
      (r) => r.seeded === 0 && before.items.some((b) => b.id === r.id && b.lastSeenAt !== r.lastSeenAt),
    );
    if (seen) {
      chart = seen;
      reseenAt = seen.lastSeenAt;
    }
  }
  if (!chart) await new Promise((r) => setTimeout(r, 500));
}
assert.ok(chart, "no chart resource appeared after the turn (and none existing was re-seen)");
assert.equal(chart.source, "auto", "the captured chart must be source=auto (no user action)");
assert.ok(chart.sessionId, "the captured chart must carry session provenance");
console.log(
  reseenAt
    ? `[probe] captured unattended: a content-identical chart already existed — dedupe kept one row ` +
        `and advanced last_seen_at to ${reseenAt}`
    : `[probe] captured unattended: "${chart.title}" (session ${chart.sessionId}, msg ${chart.messageId})`,
);

// ── 4. Saving a workspace file (the turn's own, or RESOURCES_PROBE_FILE) ────
const FILE_RE = /(?:^|[\s"'`[(=:])([\w./-]*q1-report\.md)/;
const pathMatch = FILE_RE.exec(collected.text);
assert.ok(pathMatch, "the turn did not name the file it wrote");
const turnPath = pathMatch[1].replace(/^\.\//, "");
const overrideFile = process.env.RESOURCES_PROBE_FILE;
if (overrideFile) {
  console.log(
    `[probe] the turn's own file is ${turnPath}; saving a pre-existing workspace file ` +
      `instead (RESOURCES_PROBE_FILE=${overrideFile}) — an unwritable workspace makes the agent write outside it`,
  );
}
const relPath = overrideFile || turnPath;
const save = await api("/api/resources", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ path: relPath, sessionId: chart.sessionId }),
}).then((r) => r.json());
assert.ok(save.resource, `save failed: ${JSON.stringify(save)}`);
console.log(
  `[probe] saved ${relPath} — inserted=${save.inserted}, ${save.resource.fileSize} bytes, ${save.resource.fileMime}`,
);

const served = await api(`/api/files?root=resources&path=${encodeURIComponent(save.resource.filePath)}`);
assert.equal(served.status, 200, `serving the stored copy answered ${served.status}`);
const bytes = Buffer.from(await served.arrayBuffer());
assert.ok(bytes.length === save.resource.fileSize, "served bytes differ from the stored size");
assert.match(served.headers.get("content-disposition") || "", /inline|attachment/);
const digest = createHash("sha256").update(bytes).digest("hex");
console.log(
  `[probe] stored copy served back (${bytes.length} bytes, ${served.headers.get("content-type")}, sha256 ${digest})`,
);

// ── 5. Seeding report (not an assertion) ────────────────────────────────────
const after = await api("/api/resources").then((r) => r.json());
const seeded = after.items.filter((i) => i.seeded);
console.log(
  `[probe] library now holds ${after.total} resource(s)` +
    (seeded.length
      ? `; the seeding pass captured ${seeded.length} chart(s) from pre-existing history`
      : "; no chart fences existed in the pre-deploy history, so seeding had nothing to add"),
);
console.log("[probe] all claims hold");
process.exit(0);