import { chromium } from "playwright";
import { readFileSync } from "node:fs";
const env = readFileSync("/Users/chengsishi/finddata/paas/.env", "utf8");
const g = (k) => { const m = env.match(new RegExp("^" + k + "=(.*)$", "m")); return m ? m[1].trim() : null; };
const PLATFORM = "https://platform.finddatatech.cloud";
const b = await chromium.launch();
const p = await b.newPage();
const ws = [];
p.on("websocket", (s) => {
  s.on("framereceived", (f) => {
    const t = typeof f.payload === "string" ? f.payload : "";
    if (t.includes("input_request")) ws.push(t.slice(0, 400));
  });
});
await p.goto(`${PLATFORM}/login`, { waitUntil: "networkidle", timeout: 90000 });
await p.locator('[data-testid="sso-login"]').first().click();
await p.locator('input[name="identifier"]').waitFor({ state: "visible", timeout: 60000 });
await p.locator('input[name="identifier"]').fill(g("PAAS_TEST_IDENTIFIER"));
await p.locator('input[name="identifier"]').press("Enter");
await p.locator('input[name="password"]').waitFor({ state: "visible", timeout: 60000 });
await p.locator('input[name="password"]').fill(g("PAAS_TEST_PASSWORD"));
await p.locator('input[name="password"]').press("Enter");
await p.waitForURL(/\/chat|\/settings/, { timeout: 90000 });
await p.getByTestId("composer-input").waitFor({ state: "visible", timeout: 60000 });
await p.getByTestId("new-session").click().catch(() => {});
await p.waitForTimeout(2000);
await p.getByTestId("composer-input").fill(
  "调用 request_input 工具，用一张 form 卡问我：标题「诊断」，只有一个必填文本字段 key=nickname、label=昵称。除此之外什么都不要做。",
);
await p.getByTestId("composer-send").click();
const card = p.getByTestId("input-request-card");
await card.first().waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
await p.waitForTimeout(3000);
const n = await card.count();
console.log("cards:", n);
for (let i = 0; i < n; i++) {
  console.log(`--- card ${i} state=${await card.nth(i).getAttribute("data-state")}`);
  console.log((await card.nth(i).textContent())?.slice(0, 400));
}
console.log("ws frames with input_request:", ws.length);
ws.slice(0, 3).forEach((f) => {
  console.log("WS:", f);
});
const body = (await p.locator("body").textContent()) || "";
console.log("has NO_PROVIDER:", /no user-questions provider/i.test(body));
console.log("tail:", body.slice(-500).replace(/\s+/g, " "));
await p.screenshot({ path: "/tmp/diag-ir.png", fullPage: true });
await b.close();
