// Pairing + silent-login client against the device-pairing endpoints shipped
// by add-device-pairing-auth (ADR-0020). The network layer is injected so
// unit tests drive fake servers; the app passes a fetch-shaped transport with
// the instance baseUrl baked in.
//
// Semantics (mirrors the server's contracts):
//   - capability probe: 200 with capabilities.devicePairing → supported;
//     200 without the key → older server (needs upgrade); 401/unreachable →
//     "capabilities unknown" — pairing proceeds regardless (the forward-auth
//     shape answers anonymous /api/config with 401 by design).
//   - pair: 401 = wrong/expired/reused code; 503 = server without
//     MP_TOKEN_SECRET.
//   - silent login: challenge → sign `deviceId:nonce` → token. A 401 with
//     error binding_required (revoked or unknown) is the re-pair signal.

export type ProbeResult = "supported" | "older-server" | "unknown";

export interface PairingEndpoints {
  probeConfig(): Promise<ProbeResult>;
  pair(input: { code: string; deviceId: string; publicKey: string; label: string }): Promise<
    { ok: true; token: string; email: string } | { ok: false; status: number; error: string }
  >;
  silentLogin(identity: { deviceId: string; sign(message: string): string }): Promise<
    | { ok: true; token: string; email: string }
    | { ok: false; status: number; rebind: boolean; error: string }
  >;
  revokeSelf(token: string, deviceId: string): Promise<boolean>;
}

interface FetchLike {
  (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }>;
}

export function createPairingClient(fetchLike: FetchLike): PairingEndpoints {
  const post = async (path: string, body: unknown) =>
    fetchLike(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  return {
    async probeConfig() {
      try {
        const res = await fetchLike("/api/config");
        if (res.status === 401) return "unknown"; // forward-auth shape: probe anonymous is refused
        if (!res.ok) return "unknown";
        const cfg = (await res.json()) as { capabilities?: { devicePairing?: boolean } };
        return cfg.capabilities?.devicePairing === true ? "supported" : "older-server";
      } catch {
        return "unknown"; // unreachable now ≠ unsupported — pairing still tries
      }
    },

    async pair({ code, deviceId, publicKey, label }) {
      const res = await post("/api/app/pair", { code, deviceId, pubkey: publicKey, label });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: res.status, error: body.error ?? `HTTP ${res.status}` };
      }
      const body = (await res.json()) as { token: string; email: string };
      return { ok: true, token: body.token, email: body.email };
    },

    async silentLogin({ deviceId, sign }) {
      const ch = await post("/api/app/challenge", { deviceId });
      if (!ch.ok) {
        const body = (await ch.json().catch(() => ({}))) as { error?: string };
        return { ok: false, status: ch.status, rebind: body.error === "binding_required", error: body.error ?? `HTTP ${ch.status}` };
      }
      const { nonce } = (await ch.json()) as { nonce: string };
      const login = await post("/api/app/login", {
        deviceId,
        nonce,
        signature: sign(`${deviceId}:${nonce}`),
      });
      if (!login.ok) {
        const body = (await login.json().catch(() => ({}))) as { error?: string };
        return {
          ok: false,
          status: login.status,
          rebind: body.error === "binding_required",
          error: body.error ?? `HTTP ${login.status}`,
        };
      }
      const body = (await login.json()) as { token: string; email: string };
      return { ok: true, token: body.token, email: body.email };
    },

    async revokeSelf(token, deviceId) {
      const res = await fetchLike(`/api/app/bind/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      return res.ok;
    },
  };
}

// The QR payload contract: `<web-origin>/settings/devices?bindcode=<code>` —
// one capture carries the instance address AND the code (mirrors the
// mini-program login page's parser for its own QR shape).
export function parsePairingQr(payload: string): { baseUrl?: string; code?: string } {
  const text = payload.trim();
  if (/^\d{6}$/.test(text)) return { code: text };
  try {
    const url = new URL(text);
    const code = url.searchParams.get("bindcode") ?? "";
    if (/^\d{6}$/.test(code) && url.pathname.startsWith("/settings")) {
      return { baseUrl: url.origin, code };
    }
  } catch {
    /* not a URL */
  }
  return {};
}
