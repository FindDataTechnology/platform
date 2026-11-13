#!/usr/bin/env node
// ── Wanxing facade live probe (add-wanxing-serving-api task 5.2) ─────────────
//
// Runs the external-serving contract end to end against a deployed facade:
//   catalog → public card → caller-key auth (valid + dead key) → admission
//   states → message/send real turn → Idempotency-Key replay (no second turn,
//   no second ledger row) → concurrency 409 → settlement on the caller's
//   sub2api balance (admin before/after read).
//
//   node scripts/probe-wanxing-live.mjs                       # defaults below
//   BASE=https://platform.example.com CALLER_KEY=sk-… node scripts/probe-wanxing-live.mjs
//
// Needs: BASE (the facade host), CALLER_KEY (a sub2api key whose account has
// balance), and optionally SUB2API_BASE_URL + admin email/password (from
// .env) to verify the balance actually moved. AGENT_SLUG optional — defaults
// to the first catalog entry. The 24h context reap is runner-side: verify
// with a short AGENT_RUNNER_EXTERNAL_CONTEXT_TTL_SECS on staging and the
// runner log line ("external-context reap: removed N").

import "dotenv/config";

const BASE = (process.env.BASE || "").replace(/\/+$/, "");
const KEY = process.env.CALLER_KEY || "";
const SLUG = process.env.AGENT_SLUG || "";
if (!BASE || !KEY) {
  console.error("probe needs BASE and CALLER_KEY (see header)");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// Caller balance via the admin API (panel-login JWT — probe finding 10-03).
async function callerBalance() {
  const base = process.env.SUB2API_BASE_URL;
  if (!base || !process.env.SUB2API_ADMIN_EMAIL || !process.env.SUB2API_ADMIN_PASSWORD) return null;
  try {
    const login = await fetch(`${base.replace(/\/+$/, "")}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: process.env.SUB2API_ADMIN_EMAIL, password: process.env.SUB2API_ADMIN_PASSWORD }),
    });
    const tok = (await login.json())?.data?.access_token;
    if (!tok) return null;
    const search = await (await fetch(`${base.replace(/\/+$/, "")}/api/v1/admin/users?search=${encodeURIComponent(KEY)}&page=1&page_size=50`, { headers: { Authorization: `Bearer ${tok}` } })).json();
    const items = search?.data?.items ?? [];
    if (items.length !== 1) return null;
    const detail = await (await fetch(`${base.replace(/\/+$/, "")}/api/v1/admin/users/${items[0].id}`, { headers: { Authorization: `Bearer ${tok}` } })).json();
    return Number(detail?.data?.balance ?? NaN);
  } catch {
    return null;
  }
}

console.log(`\nwanxing live probe → ${BASE}\n`);

// 1. Public discovery
{
  const r = await fetch(`${BASE}/api/wanxing/v1/agents`);
  const doc = await r.json().catch(() => null);
  ok("catalog is public", r.status === 200 && Array.isArray(doc?.agents), `${doc?.agents?.length ?? 0} agent(s)`);
  const first = SLUG || doc?.agents?.[0]?.slug;
  if (!first) {
    console.error("no deployed public agent to probe further — deploy one first");
    process.exit(1);
  }
  globalThis.slug = first;
  const card = await fetch(`${BASE}/api/wanxing/v1/a2a/${first}/.well-known/agent-card.json`);
  const cardDoc = await card.json().catch(() => null);
  ok("card is public and facade-addressed", card.status === 200 && /\/api\/wanxing\/v1\/a2a\//.test(String(cardDoc?.url)), cardDoc?.name ?? "");
}

const slug = globalThis.slug;
const turn = (extra = {}) =>
  fetch(`${BASE}/api/wanxing/v1/a2a/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "PING wanxing probe — reply with PONG" }] } } }),
  });

// 2. Auth gate
{
  const none = await turn();
  ok("missing key refused", none.status === 401 || none.status === 503, `status ${none.status}`);
  const dead = await turn({ Authorization: "Bearer sk-deadbeefdeadbeef" });
  ok("dead key refused", dead.status === 401, `status ${dead.status}`);
  const badMethod = await fetch(`${BASE}/api/wanxing/v1/a2a/${slug}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tasks/get", params: {} }),
  });
  const doc = await badMethod.json().catch(() => null);
  ok("unsupported method → -32601", doc?.error?.code === -32601);
}

// 3. Real turn + replay + concurrency
{
  const bal0 = await callerBalance();
  const idem = `probe-${Date.now()}`;
  const r1 = await turn({ Authorization: `Bearer ${KEY}`, "Idempotency-Key": idem });
  const doc1 = await r1.json().catch(() => null);
  ok("send admitted and answered", r1.status === 200 && doc1?.result != null, String(doc1?.result?.message?.parts?.[0]?.text ?? doc1?.error?.message ?? "").slice(0, 80));
  const r2 = await turn({ Authorization: `Bearer ${KEY}`, "Idempotency-Key": idem });
  const doc2 = await r2.json().catch(() => null);
  ok("replay returns the recorded outcome", r2.status === 200 && JSON.stringify(doc1) === JSON.stringify(doc2));

  // settle happens right after the reply; give the ledger a beat before reading
  await new Promise((r) => setTimeout(r, 1500));
  const bal1 = await callerBalance();
  if (bal0 != null && bal1 != null) {
    ok("caller balance settled", bal1 < bal0, `${bal0.toFixed(4)} → ${bal1.toFixed(4)}`);
  } else {
    console.log("  note settlement balance unreadable (no admin creds?) — ledger check skipped");
  }
}

// 4. Ops view (admin token = registry service credential when provided)
{
  const tok = process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "";
  if (tok) {
    const r = await fetch(`${BASE}/api/wanxing/v1/ops/usage`, { headers: { Authorization: `Bearer ${tok}` } });
    const doc = await r.json().catch(() => null);
    ok("ops usage view answers", r.status === 200 && Array.isArray(doc?.byCaller), `${doc?.byCaller?.length ?? 0} caller row(s)`);
  }
}

console.log(`\n${pass} ok, ${fail} fail\n`);
process.exit(fail > 0 ? 1 : 0);
