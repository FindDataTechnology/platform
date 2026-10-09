// ── sub2api admin/billing client (add-agent-platform-ops D1; revised by
// revise-billing-key-acquisition) ────────────────────────────────────────────
//
// The platform's single door into the sub2api billing plane (ADR-0011). Live
// facts baked into the shapes (probed 2026-10-02/03 against the production
// fork; upstream Wei-Shaw/sub2api v0.2.x):
//   • envelope {code:0, message, data} — nonzero code is a failure;
//   • x-api-key: admin-… authenticates /api/v1/admin/*;
//   • NO admin-side key creation exists (whole v0.2.x) — keys are minted by
//     the deployer in their own panel session (Logto SSO) and pasted into the
//     deploy request; the platform holds no sub2api passwords;
//   • GET /api/v1/admin/users?search=X matches email/username/notes AND the
//     user's API key VALUES (substring) — one endpoint serves both the
//     by-email account resolution and the pasted-key ownership check;
//   • GET /v1/models with the pasted key is auth-only-ish: model list is
//     built locally, but the full billing gate (balance/group/quota) runs —
//     zero-cost liveness probe;
//   • manual recharge = POST /api/v1/admin/users/:id/balance with an
//     Idempotency-Key header (no redeem-code endpoint).
// Every call takes an injectable fetchImpl; without SUB2API_ADMIN_KEY the
// client reports degraded() and callers fall back to the pre-③ behavior.

const DEFAULT_BASE = process.env.SUB2API_BASE_URL || "http://127.0.0.1:32080";

export function createSub2apiClient({ baseUrl = DEFAULT_BASE, adminKey = process.env.SUB2API_ADMIN_KEY || "", fetchImpl = null } = {}) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const doFetch = fetchImpl ?? ((path, init = {}) => fetch(base + path, init));
  const degraded = () => !adminKey;

  async function call(path, { method = "GET", body, headers = {} } = {}) {
    const res = await doFetch(path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(adminKey ? { "x-api-key": adminKey } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let doc = null;
    try {
      doc = await res.json();
    } catch { /* non-JSON error body */ }
    if (!res.ok || (doc && typeof doc.code === "number" && doc.code !== 0)) {
      const message = doc?.message || `sub2api ${method} ${path} failed (${res.status})`;
      throw Object.assign(new Error(message), { status: res.ok ? 502 : res.status, body: doc });
    }
    return doc?.data ?? doc;
  }

  return {
    degraded,

    // Startup/ops self-check: the admin key must list users.
    async selfCheck() {
      if (degraded()) return { ok: false, reason: "SUB2API_ADMIN_KEY not configured" };
      try {
        await call("/api/v1/admin/users?page=1&page_size=1");
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    },

    // The deployer's REAL sub2api account, resolved by email via the admin
    // API (their panel/OIDC login auto-provisions on first sign-in). The
    // platform never creates accounts and never holds a sub2api password —
    // keys arrive from the deploy flow (pasted, minted under the user's own
    // panel session; upstream admin-side minting is a future proposal).
    async findUserByEmail(email) {
      const listed = await call(`/api/v1/admin/users?search=${encodeURIComponent(email)}&page=1&page_size=50`);
      const hit = (listed?.items ?? []).find((u) => u.email === email);
      return hit ? { userId: hit.id, email: hit.email } : null;
    },

    // Ownership check for a pasted key: the admin search matches key VALUES,
    // so the hit set is the key's holder. Exactly one hit = resolvable;
    // zero (stale/foreign gateway) or several (ambiguous) = not provable.
    async findUserByKey(key) {
      const listed = await call(`/api/v1/admin/users?search=${encodeURIComponent(key)}&page=1&page_size=50`);
      const items = listed?.items ?? [];
      if (items.length !== 1) return null;
      return { userId: items[0].id, email: items[0].email ?? null };
    },

    // Liveness probe for a pasted key: GET /v1/models builds its list
    // locally (no upstream spend) but runs the full billing gate, so a 2xx
    // proves the key exists, is active, and its account/group are usable.
    // Non-2xx returns the gateway's own code/message (INSUFFICIENT_BALANCE,
    // INVALID_KEY, …) — no key material ever comes back.
    async probeKeyLiveness(key) {
      let res;
      try {
        res = await doFetch("/v1/models", {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        return { ok: false, status: 0, code: null, message: `probe unreachable: ${e.message}` };
      }
      const doc = await res.json().catch(() => null);
      if (res.ok) return { ok: true, status: res.status, code: null, message: null };
      return {
        ok: false,
        status: res.status,
        code: doc?.code ?? null,
        message: doc?.message || `liveness probe failed (${res.status})`,
      };
    },

    // Lane list for a deployment key (agent-service-config D2): GET /v1/models
    // builds its list locally from the key's group binding — no upstream
    // spend, full billing gate — so a 2xx body IS the model set this key is
    // authorized to run. Non-2xx raises with the gateway's code/message.
    async listKeyModels(key) {
      const res = await doFetch("/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      });
      const doc = await res.json().catch(() => null);
      if (!res.ok) {
        throw Object.assign(new Error(doc?.message || `models probe failed (${res.status})`), {
          status: res.status,
          code: doc?.code ?? null,
        });
      }
      const ids = Array.isArray(doc?.data) ? doc.data.map((m) => m?.id).filter((id) => typeof id === "string") : [];
      return [...new Set(ids)];
    },

    async readUser(userId) {
      const u = await call(`/api/v1/admin/users/${userId}`);
      return { balance: Number(u?.balance ?? 0), status: u?.status ?? null, email: u?.email ?? null };
    },

    // Day-one recharge (operator manual): Idempotency-Key guarded. The live
    // body is UpdateBalanceRequest {balance, operation} (probed 2026-10-02:
    // both fields required; operation "add" credits the amount).
    async adjustBalance({ userId, amountUsd, operation = "add", idempotencyKey }) {
      return call(`/api/v1/admin/users/${userId}/balance`, {
        method: "POST",
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {},
        body: { balance: Number(amountUsd), operation },
      });
    },
  };
}
