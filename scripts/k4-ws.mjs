// K4 leg 1 driver: as aloadtree — switch the cell preset to company-ceo
// (the CEO member's persona), then dispatch to the cross-user a2a member.
import { WebSocket } from "ws";
import { readFileSync } from "node:fs";
const COOKIE = readFileSync("/tmp/.paas-cookie", "utf8").trim();
const MEMBER = "m_1792954316736_w934cx"; // 外联部 → p2's tenant deployment
const ws = new WebSocket("wss://platform.finddatatech.cloud/", { headers: { Cookie: COOKIE } });
let done = false;
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(1); }, 90_000);
ws.on("open", () => console.log("ws open"));
ws.on("message", (raw) => {
  let m; try { m = JSON.parse(raw.toString()); } catch { return; }
  const t = m.type ?? m.event ?? "";
  if (t && !/pong|delta|token/i.test(t)) console.log("<<", t, JSON.stringify(m).slice(0, 120));
  if (t === "session_state" || t === "ready" || m.type === "hello") {
    ws.send(JSON.stringify({ type: "set_preset", id: "company-ceo" }));
  }
});
ws.on("error", (e) => console.log("WS-ERR", e.message.slice(0, 100)));
ws.on("close", (c) => { console.log("closed", c); if (!done) process.exit(1); });
// wait for open then run the sequence
await new Promise((r) => ws.on("open", r));
await new Promise((r) => setTimeout(r, 3000));
ws.send(JSON.stringify({ type: "set_preset", id: "company-ceo" }));
await new Promise((r) => setTimeout(r, 6000));
const res = await fetch("https://platform.finddatatech.cloud/api/fleets/dispatch", {
  method: "POST",
  headers: { Cookie: COOKIE, "Content-Type": "application/json" },
  body: JSON.stringify({
    to: MEMBER,
    brief: "K4 构造：请外联部向 p2walk1025 的分身报到，并用它的语料回答——这个分身是什么来历？部署者是谁？",
  }),
});
console.log("dispatch:", res.status, (await res.text()).slice(0, 200));
done = true;
clearTimeout(timer);
ws.close();
process.exit(0);
