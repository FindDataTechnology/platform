#!/usr/bin/env node
// ── Wanxing settlement direction probe (add-wanxing-serving-api task 1.1) ────
//
// Determines how the live sub2api fork DEDUCTS balance, without leaving any
// net change: on the operator's OWN admin account, credit +0.01 then try each
// deduction form until one lands, ending back at the starting balance.
//
//   node scripts/probe-wanxing-settle.mjs
//
// Findings feed design D8 (settlement = idempotent deduction). Requires
// SUB2API_BASE_URL / SUB2API_ADMIN_EMAIL / SUB2API_ADMIN_PASSWORD /
// SUB2API_ADMIN_USER_ID in .env (panel login mints a Bearer JWT that the
// admin routes also accept — live finding 2026-10-03).

import "dotenv/config";

const BASE = (process.env.SUB2API_BASE_URL || "").replace(/\/+$/, "");
const USER_ID = process.env.SUB2API_ADMIN_USER_ID || "";

if (!BASE || !process.env.SUB2API_ADMIN_EMAIL || !USER_ID) {
  console.error("probe needs SUB2API_BASE_URL, SUB2API_ADMIN_EMAIL/PASSWORD and SUB2API_ADMIN_USER_ID");
  process.exit(1);
}

const login = await fetch(BASE + "/api/v1/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: process.env.SUB2API_ADMIN_EMAIL, password: process.env.SUB2API_ADMIN_PASSWORD }),
});
const loginDoc = await login.json().catch(() => null);
const ADMIN = loginDoc?.data?.access_token || loginDoc?.access_token || "";
if (!ADMIN) {
  console.error("panel login failed:", login.status, loginDoc?.message);
  process.exit(1);
}

const call = async (path, { method = "GET", body, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${ADMIN}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const doc = await res.json().catch(() => null);
  if (!res.ok || (doc && typeof doc.code === "number" && doc.code !== 0)) {
    throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(doc).slice(0, 200)}`);
  }
  return doc?.data ?? doc;
};

const readBalance = async () => {
  const u = await call(`/api/v1/admin/users/${USER_ID}`);
  return Number(u?.balance ?? NaN);
};

const attempt = (operation, amount, key) =>
  call(`/api/v1/admin/users/${USER_ID}/balance`, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: { balance: amount, operation },
  });

const start = await readBalance();
console.log(`start balance: ${start.toFixed(4)}`);

// 1) credit a cent (known-good form, probed 2026-10-02)
await attempt("add", 0.01, `wanxing-probe-add-${Date.now()}`);
const afterAdd = await readBalance();
console.log(`after add +0.01:   ${afterAdd.toFixed(4)}  (delta ${(afterAdd - start).toFixed(4)})`);

// 2) try deduction forms until one returns us to the start balance
const forms = [
  { operation: "add", amount: -0.01, label: 'add -0.01 (negative add)' },
  { operation: "subtract", amount: 0.01, label: 'subtract 0.01' },
  { operation: "deduct", amount: 0.01, label: 'deduct 0.01' },
  { operation: "minus", amount: 0.01, label: 'minus 0.01' },
];
let winner = null;
for (const f of forms) {
  try {
    await attempt(f.operation, f.amount, `wanxing-probe-sub-${f.operation}-${Date.now()}`);
    const bal = await readBalance();
    const ok = Math.abs(bal - start) < 1e-6;
    console.log(`${f.label}: accepted, balance ${bal.toFixed(4)} — ${ok ? "NET ZERO ✓" : `still off by ${(bal - start).toFixed(4)}`}`);
    if (ok) { winner = f; break; }
  } catch (e) {
    console.log(`${f.label}: rejected — ${e.message.slice(0, 120)}`);
  }
}

// 3) safety net: whatever happened, restore the start balance if we're off
const end = await readBalance();
if (Math.abs(end - start) >= 1e-6) {
  const drift = start - end;
  await attempt("add", Number(drift.toFixed(4)), `wanxing-probe-restore-${Date.now()}`);
  console.log(`restored drift ${drift.toFixed(4)} -> balance ${(await readBalance()).toFixed(4)}`);
}

console.log(winner ? `\nDEDUCTION FORM: { balance: ${winner.amount}, operation: "${winner.operation}" }` : "\nNO deduction form worked — sub2api needs a deduct operation added");
