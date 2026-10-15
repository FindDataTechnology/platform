// What did the agent runtime actually run? Reads the newest dsh session logs in
// this deployment's DSH_HOME and prints, per session: the preset it mounted, the
// model, how many tools the request carried (and how many of them are
// marketplace MCP tools, by server), and the persona line the model was given.
//
// Run it inside the platform pod (the image ships this file):
//
//   kubectl -n fd-prod exec deploy/platform -- node /app/scripts/inspect-live-session.mjs
//   # older image without it:
//   kubectl -n fd-prod cp scripts/inspect-live-session.mjs deploy/platform:/tmp/check.mjs
//   kubectl -n fd-prod exec deploy/platform -- node /tmp/check.mjs
//
// That is the pod-side half of the post-deploy chat check — the browser half is
// scripts/verify-live-chat-fixes.mjs. Together they answer "is this chat really
// running the local agent, with the pack persona and the store's MCP servers?"
// rather than "did the page render".
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const SESSIONS = Number(process.env.SESSIONS || 3);
const root = process.env.DSH_HOME ? join(process.env.DSH_HOME, "sessions") : "/opt/dsh-home/sessions";

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name === "session.jsonl.zstd") files.push({ p, m: statSync(p).mtimeMs });
  }
})(root);
files.sort((a, b) => b.m - a.m);
console.log("sessions:", files.length);

// A session log is a sequence of concatenated zstd frames, and
// zstdDecompressSync decodes only the first one — split on the frame magic or
// everything after the header reads as empty.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function events(path) {
  const buf = readFileSync(path);
  const starts = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(MAGIC, at + 4);
  }
  let text = "";
  for (let k = 0; k < starts.length; k++) {
    const slice = buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length);
    try {
      text += zstdDecompressSync(slice).toString("utf8");
    } catch {
      // A frame still being written: keep the ones that decode.
    }
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

for (const file of files.slice(0, SESSIONS)) {
  const evs = events(file.p);
  const header = evs.find((e) => e.type === "session");
  const request = evs.find((e) => e.type === "request/header");
  const when = new Date(file.m).toISOString().slice(11, 19);
  if (!request) {
    console.log(`\n[${when}] preset=${header?.agentPreset ?? "?"} — no model request yet`);
    continue;
  }
  const h = request.data.header;
  const tools = (h.tools || []).map((t) => t.name);
  const mcp = tools.filter((n) => n.startsWith("mcp__"));
  const servers = [...new Set(mcp.map((n) => n.split("__")[1]))];
  console.log(`\n[${when}] preset=${header?.agentPreset ?? "?"} model=${h.config?.model} tools=${tools.length} mcp=${mcp.length}`);
  console.log("  servers:", servers.join(", ") || "(none)");
  // The pack persona is one line of the system prompt; print the first line that
  // is not the runtime's own boilerplate.
  const persona = (h.system || "")
    .split("\n")
    .find((l) => l.trim() && !/^You are an AI agent powered by/.test(l));
  if (persona) console.log("  persona:", persona.trim().slice(0, 160));
}
