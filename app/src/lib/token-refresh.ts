// Token refresh policy (task 3.1's testable core): ONE silent exchange per
// auth failure, deduped across concurrent callers; rebind routes to pairing;
// a non-rebind failure is a blip — neither a token write nor routing.
// Kept free of react-native imports so node tests load it directly.

export interface RefreshOutcome {
  ok: boolean;
  rebind: boolean;
}

export interface SilentLoginResult {
  ok: boolean;
  token?: string;
  rebind?: boolean;
}

export function createTokenRefresher(deps: {
  silentLogin: () => Promise<SilentLoginResult>;
  setToken: (token: string) => void;
  onRebind: () => void;
}) {
  let inFlight: Promise<RefreshOutcome> | null = null;
  return {
    refreshOnce(): Promise<RefreshOutcome> {
      if (!inFlight) {
        inFlight = deps
          .silentLogin()
          .then((r) => {
            if (r.ok && r.token) {
              deps.setToken(r.token);
              return { ok: true, rebind: false };
            }
            if (r.rebind) deps.onRebind();
            return { ok: false, rebind: Boolean(r.rebind) };
          })
          .catch(() => ({ ok: false, rebind: false }))
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}
