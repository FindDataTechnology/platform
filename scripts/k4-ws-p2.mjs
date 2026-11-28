// K4 leg 2 driver (final): preset user-p2 → dispatch to the a2a member.
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
const COOKIE = readFileSync("/tmp/.p2-cookie", "utf8").trim();
const MEMBER = "m_1792956109095_zj6l27";
const ws = new WebSocket("wss://platform.finddatatech.cloud/", { headers: { Cookie: COOKIE } });
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  if (m.type === "current_preset") console.log("preset now:", m.id);
});
await new Promise((r) => ws.on("open", r));
await new Promise((r) => setTimeout(r, 4000));
ws.send(JSON.stringify({ type: "set_preset", id: "user-p2" }));
await new Promise((r) => setTimeout(r, 5000));
const res = await fetch("https://platform.finddatatech.cloud/api/fleets/dispatch", {
  method: "POST",
  headers: { Cookie: COOKIE, "Content-Type": "application/json" },
  body: JSON.stringify({
    to: MEMBER,
    brief: "K4 leg2：请通过寻数官方分身回答——寻数（FindData）是做什么的？双星是哪两颗？",
  }),
});
console.log("leg2 dispatch:", res.status, (await res.text()).slice(0, 200));
ws.close();
process.exit(0);
