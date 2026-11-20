#!/usr/bin/env node
// Sample one room from three transports at the same moment and diff the views
// (openspec: add-zhiyu-mobile-clients, task 7.1).
//
// The test suite proves the three adapters agree in-process. This runs the same
// comparison against a REAL deployment, which is where a proxy, an edge cache or
// a patched route can make them disagree even though the code is the same.
//
// Read-only: it opens windows and prints a table. Nothing is written, nothing is
// retried beyond what a client would do, and no credential is echoed.
//
//   node scripts/parity-zhiyu-clients.mjs --base=https://host --room=zy_… \
//        --cookie="session=…"                 # browser-shaped session
//   node scripts/parity-zhiyu-clients.mjs --base=http://127.0.0.1:3100 --room=zy_… \
//        --user=a@x                            # dev/gateway header lane
//
// Exit code: 0 when the three views are equal, 1 when they differ (so it can be
// wired into a smoke job).

import { TRANSPORT_KINDS, transportFor, diffViews } from "./zhiyu-transports.mjs";

function arg(name, dflt = null) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

const base = (arg("base") ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
const roomId = arg("room");
const cookie = arg("cookie");
const user = arg("user");
const after = Number(arg("after") ?? 0) || 0;
const tail = Number(arg("tail") ?? 50) || 50;

if (!roomId) {
  console.error("usage: node scripts/parity-zhiyu-clients.mjs --base=URL --room=ROOM_ID (--cookie=… | --user=EMAIL) [--after=N] [--tail=N]");
  process.exit(2);
}
if (!cookie && !user) {
  console.error("a credential is required: --cookie (browser session) or --user (gateway header lane)");
  process.exit(2);
}

const headers = cookie ? { cookie } : { "x-user": user };

const sampled = await Promise.all(
  TRANSPORT_KINDS.map(async (kind) => {
    const transport = transportFor(kind, { base, roomId, headers });
    try {
      // From the same cursor, at the same moment, in parallel.
      const page = after > 0
        ? await transport.increment(after, 1_500)
        : { messages: (await transport.page({ tail })).messages };
      return { kind, messages: page.messages, error: null };
    } catch (err) {
      return { kind, messages: [], error: err?.message ?? String(err) };
    }
  }),
);

for (const s of sampled) {
  console.log(`${s.kind.padEnd(8)} ${String(s.messages.length).padStart(4)} rows${s.error ? `  ERROR ${s.error}` : ""}`);
  for (const m of s.messages.slice(-5)) console.log(`         #${m.seq} ${m.kind} ${String(m.content ?? "").slice(0, 60)}`);
}

const failures = sampled.filter((s) => s.error);
if (failures.length) {
  console.error(`\n✖ ${failures.length} transport(s) failed: ${failures.map((f) => `${f.kind} (${f.error})`).join(", ")}`);
  process.exit(1);
}

const views = Object.fromEntries(
  sampled.map((s) => [s.kind, s.messages.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, visibility: m.visibility }))]),
);
const diffs = diffViews(views);
if (diffs.length) {
  console.error(`\n✖ views differ (${diffs.length}):`);
  for (const d of diffs.slice(0, 40)) console.error(`  ${d}`);
  if (diffs.length > 40) console.error(`  … ${diffs.length - 40} more`);
  process.exit(1);
}
console.log(`\n✔ ${TRANSPORT_KINDS.join(" = ")} — ${sampled[0].messages.length} rows, field-identical`);
