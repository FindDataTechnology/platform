// Diagnostic pass 2: log every response, WS activity, and navigations while
// loading prod /chat with a minted session cookie.
// Usage: node scripts/probe-mixed-content.mjs <paas_session-cookie-value>
import { chromium } from "playwright";

const cookieValue = process.argv[2];
if (!cookieValue) {
  console.error("missing cookie value");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext();
await ctx.addCookies([
  {
    name: "paas_session",
    value: cookieValue,
    domain: "platform.finddatatech.cloud",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
]);
const page = await ctx.newPage();

page.on("request", (r) => {
  const u = r.url();
  if (!u.startsWith("https://") && !u.startsWith("data:")) {
    console.log("[INSECURE-REQ]", r.resourceType(), r.method(), u.slice(0, 160));
  }
});
page.on("response", async (r) => {
  const s = r.status();
  if (s >= 300 && s < 400) {
    console.log("[REDIRECT]", s, r.url().slice(0, 110), "->", (r.headers()["location"] || "").slice(0, 110));
  } else if (s >= 400) {
    console.log("[HTTP-ERR]", s, r.url().slice(0, 140));
  }
});
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) console.log("[NAV]", f.url().slice(0, 140));
});
page.on("websocket", (ws) => {
  console.log("[WS]", ws.url().slice(0, 120));
  ws.on("close", () => console.log("[WS-CLOSED]"));
});
page.on("console", (m) => {
  const t = m.text();
  if (/error|fail|mixed|denied|401|403/i.test(t)) console.log("[CONSOLE]", t.slice(0, 180));
});

const cdp = await ctx.newCDPSession(page);
await cdp.send("Security.enable");
cdp.on("Security.securityStateChanged", (s) =>
  console.log("[SECURITY]", s.securityState, (s.explanations || []).map((e) => e.summary).join("|")),
);

await page.goto("https://platform.finddatatech.cloud/chat", { waitUntil: "load", timeout: 45000 }).catch((e) =>
  console.log("goto:", e.message.slice(0, 140)),
);
await page.waitForTimeout(10000);
console.log("final:", page.url());
console.log("title:", await page.title());
await page.screenshot({ path: "/tmp/probe-chat2.png" });
await browser.close();
