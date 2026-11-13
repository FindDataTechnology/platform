// Verification for registry-sso-credentials task 1.2 — the real silent-SSO mint.
//
// Drives a real browser: registry login (Logto, two-step identifier→password),
// then reproduces the CONNECT POPUP's cross-origin leg from the platform origin
// (https://craw.finddatatech.cloud) — GET csrf-token with credentials, then POST
// tokens/generate with the CSRF header — and reports the response SHAPE and the
// token's exp delta. The token itself is never printed (only a redacted prefix).
//
// Credentials come from the environment; nothing is written to disk.
//
//   LOGTO_EMAIL=… LOGTO_PASSWORD=… node scripts/verify-registry-connect-live.mjs
//
// Also checks the CONNECT FLOW's two preconditions as the deployed registry
// actually behaves: the session cookie crosses sites (SameSite=None) and the
// CSRF GET succeeds from the platform origin. A 401 on the GET = the browser had
// no registry session; a TypeError = the origin is missing from CORS_ALLOWED_ORIGINS.
import { chromium } from "@playwright/test";

const REGISTRY = process.env.REGISTRY_URL_LIVE || "https://mcp.finddatatech.cloud";
const PLATFORM = process.env.PLATFORM_URL_LIVE || "https://craw.finddatatech.cloud";
const EMAIL = process.env.LOGTO_EMAIL;
const PASSWORD = process.env.LOGTO_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error("LOGTO_EMAIL/LOGTO_PASSWORD not set");

const b = await chromium.launch({ args: ["--proxy-server=direct://"] });
const ctx = await b.newContext();
const p = await ctx.newPage();
const steps = [];
p.on("framenavigated", (f) => { if (f === p.mainFrame()) steps.push(f.url()); });

// ── 1. registry login through Logto (the popup's login leg) ──────────────────
await p.goto(`${REGISTRY}/login`, { waitUntil: "domcontentloaded", timeout: 45000 });
await p.getByRole("button", { name: /continue with logto/i }).click();
await p.waitForTimeout(4000);

await p.waitForURL(/auth\.finddatatech\.cloud/, { timeout: 30000 });
await p.locator('input[name="identifier"]').fill(EMAIL);
// Logto's two-step form: submit the identifier, then the password. Submit with
// Enter — the button's accessible name changes while the step is loading.
await p.locator('input[name="identifier"]').press("Enter");
await p.waitForTimeout(3000);
try {
  await p.locator('input[name="password"]').waitFor({ state: "visible", timeout: 20000 });
} catch (e) {
  const dump = await p.evaluate(() => ({
    url: location.href,
    inputs: Array.from(document.querySelectorAll("input")).map((i) => `${i.type}:${i.name}`),
    buttons: Array.from(document.querySelectorAll("button")).map((b) => b.textContent.trim().slice(0, 30)),
    text: document.body.innerText.slice(0, 300),
  }));
  console.log("PASSWORD STEP NOT REACHED:", JSON.stringify(dump));
  throw e;
}
await p.locator('input[name="password"]').fill(PASSWORD);
await p.locator('input[name="password"]').press("Enter");

// Consent (first login) or an immediate redirect back to the registry.
await p.waitForTimeout(5000);
const consent = p.getByRole("button", { name: /^(authorize|allow|agree|confirm)/i });
if (await consent.count().catch(() => 0)) {
  await consent.first().click().catch(() => {});
  await p.waitForTimeout(3000);
}
await p.waitForURL(/mcp\.finddatatech\.cloud/, { timeout: 45000 }).catch(() => {});
console.log("login legs:", steps.map((u) => u.replace(/[?].*/, "")).join(" → "));
console.log("after login:", p.url().replace(/[?].*/, ""));

const session = (await ctx.cookies()).filter((c) => c.domain.includes("finddatatech"));
console.log("cookies:", session.map((c) => `${c.domain}${c.path}:${c.name}(SameSite=${c.sameSite},Secure=${c.secure})`).join(", "));

// ── 2. the popup's cross-origin mint, from the PLATFORM origin ───────────────
const pp = await ctx.newPage();
await pp.goto(PLATFORM, { waitUntil: "domcontentloaded", timeout: 45000 });
const mint = await pp.evaluate(async ([registry]) => {
  const out = { csrf: null, mint: null, error: null };
  try {
    const csrfRes = await fetch(`${registry}/api/auth/csrf-token`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    const csrfBody = await csrfRes.text();
    out.csrf = { status: csrfRes.status, acao: csrfRes.headers.get("access-control-allow-origin"), body: csrfBody.slice(0, 200) };
    let csrf = "";
    try { const j = JSON.parse(csrfBody); csrf = j.csrf_token || j.token || ""; } catch { /* not json */ }
    const mintRes = await fetch(`${registry}/api/tokens/generate`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ expires_in_hours: 168 }),
    });
    const text = await mintRes.text();
    out.mint = { status: mintRes.status, acao: mintRes.headers.get("access-control-allow-origin"), body: text };
  } catch (e) {
    out.error = String(e);
  }
  return out;
}, [REGISTRY]);

console.log("platform origin:", await pp.evaluate(() => location.origin));
console.log("csrf:", JSON.stringify(mint.csrf));
console.log("error:", mint.error);
if (mint.mint) {
  const body = mint.mint.body;
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* keep raw */ }
  const fields = parsed ? Object.keys(parsed) : [];
  // The deployed registry nests the token: {success, tokens:{access_token, …}}.
  const t = parsed && (parsed.tokens || parsed);
  const token = t && (t.access_token || t.token || t.jwt_token || (t.data && t.data.access_token));
  if (parsed && parsed.tokens) console.log("tokens fields:", JSON.stringify(Object.keys(parsed.tokens)), "| success:", parsed.success);
  console.log("mint status:", mint.mint.status, "acao:", mint.mint.acao, "fields:", JSON.stringify(fields));
  if (token) {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const hours = ((payload.exp - Math.floor(Date.now() / 1000)) / 3600).toFixed(2);
    console.log("token: redacted", token.slice(0, 12) + "…", "| exp in", hours, "h | claims:", JSON.stringify(Object.keys(payload)));
    console.log("token_type:", t.token_type, "expires_in:", t.expires_in, "expires_at:", t.expires_at, "token_id:", t.token_id);
  } else {
    console.log("no token in body:", body.slice(0, 200));
  }
}
await b.close();
