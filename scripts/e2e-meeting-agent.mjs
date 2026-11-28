// Meeting agent END-TO-END (openspec: add-ai-native-meeting 2.1/2.2).
//
// Exercises the two platform routes the worker calls, against the REAL 词元
// audio lane (not a stub): a real TTS wav in → real STT → room message; then
// text → real TTS → wav out. It exists so that when the lane is healthy this is
// one command, and when it is not, the failure names the lane rather than the
// code.
//
//   VOICE_API_KEY=… node scripts/e2e-meeting-agent.mjs
//
// Requires: LLM/VOICE key reachable. Prints PASS/FAIL per hop.
import express from "express";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

const KEY = process.env.VOICE_API_KEY || process.env.LLM_API_KEY;
if (!KEY) { console.error("VOICE_API_KEY/LLM_API_KEY required"); process.exit(2); }
const OWNER = process.env.E2E_OWNER || "owner@example.test";
const SECRET = "e2e-gw-secret";
const dir = mkdtempSync(path.join(os.tmpdir(), "e2e-mtg-"));

const app = express();
app.use(express.json());
const z = registerZhiyuRoutes(app, {
  dataRoot: dir,
  resolveUser: (req) => (req.headers["x-t-email"] ? { email: String(req.headers["x-t-email"]), groups: [] } : null),
  rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "unauth" }),
  env: { ...process.env, VOICE_API_KEY: KEY },
  secret: SECRET,
  startTimers: false,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const U = { "x-t-email": OWNER, "content-type": "application/json" };
const mk = async (p, b) => (await fetch(base + p, { method: "POST", headers: U, body: JSON.stringify(b || {}) })).json();

let failures = 0;
const check = (name, ok, detail) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); if (!ok) failures++; };

try {
  const { room } = await mk("/api/zhiyu/rooms", { title: "e2e会" });
  const mtg = await mk(`/api/zhiyu/rooms/${room.id}/meetings`, { title: "e2e会" });
  const mid = mtg.meeting?.id || mtg.id;
  const st = z.store;
  const seat = st.memberFor(room.id, "user", OWNER) || st.memberAdd({ roomId: room.id, kind: "user", ref: OWNER, display: OWNER });
  st.meetingJoin({ meetingId: mid, member: seat });

  // Hop 1: real TTS audio → real STT via the utterance route
  const tts = await fetch("https://token.finddatatech.cloud/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "tencent-tts", voice: "101001", input: "这是端到端测试里说的一句话。", response_format: "wav" }),
  });
  if (!tts.ok) {
    check("lane reachable for TTS", false, `HTTP ${tts.status} ${(await tts.text()).slice(0, 120)}`);
    console.log("\nThe audio lane is down — this is an upstream/infra blocker, not a code defect. See openspec .../E2E-BLOCKED.md");
    process.exit(1);
  }
  const wav = Buffer.from(await tts.arrayBuffer());
  const fd = new FormData();
  fd.append("audio", new Blob([wav], { type: "audio/wav" }), "s.wav");
  fd.append("seatRef", OWNER);
  const r1 = await fetch(`${base}/api/zhiyu/meetings/${mid}/utterance`, {
    method: "POST", headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": OWNER }, body: fd,
  });
  const j1 = await r1.json();
  check("utterance → room message", r1.status === 200 && j1.delivered?.length === 1, `HTTP ${r1.status} ${JSON.stringify(j1).slice(0, 100)}`);
  if (j1.delivered?.[0]) {
    const row = st.messageAt(room.id, j1.delivered[0].seq);
    check("message is per_stream", row.meta?.capture?.mode === "per_stream", row.meta?.capture?.mode);
    check("message has text", Boolean(row.content && row.content.trim()), row.content?.slice(0, 40));
  }

  // Hop 2: text → real TTS in the catalog voice
  const r2 = await fetch(`${base}/api/zhiyu/meetings/${mid}/speak`, {
    method: "POST",
    headers: { "x-cloud-gateway-secret": SECRET, "x-actor-email": OWNER, "content-type": "application/json" },
    body: JSON.stringify({ text: "这是智能体在会中说的话。", seatRef: OWNER }),
  });
  const buf2 = Buffer.from(await r2.arrayBuffer());
  check("speak → audio bytes", r2.status === 200 && buf2.length > 1000, `HTTP ${r2.status}, ${buf2.length} bytes`);
  check("speak uses catalog voice", r2.headers.get("x-voice-used") === "tencent-tts:101001", r2.headers.get("x-voice-used"));
} catch (e) {
  check("e2e ran", false, e?.message || String(e));
} finally {
  server.close(); z.close?.();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
