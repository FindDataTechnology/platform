// The app's one runtime: owns the single WsClient, funnels protocol events
// into the shared stores, drives AppState-driven reconnect+resync, and
// refreshes the pairing token with a single-flight silent exchange (spec:
// an auth failure mid-session runs ONE re-exchange before surfacing an
// error; only a revoked binding routes back to the pairing screen).
//
// Lifecycle invariants mirror the mini program's runtime: the server
// broadcasts every event to every connected socket, so boot() is
// single-flight and foreground can only reconnect the one client.

import { AppState } from "react-native";
import {
  setChatErrorSink,
  WsClient,
  useChatStore,
  useCronStore,
  type ClientMessage,
  type ServerMessage,
} from "@platform/core";
import { rnSocketFactory } from "./rn-ws";
import { wireCore } from "./platform";
import { loadOrCreateIdentity } from "./device-identity";
import { createPairingClient } from "./pairing";
import { secureKeyStore, expoRandom } from "./rn-secure";
import { createTokenRefresher } from "./token-refresh";
import { useAppStore } from "@/store/app-store";

const INITIAL_QUERIES = [
  "list_models",
  "list_agents",
  "list_skills",
  "list_presets",
  "list_sessions",
  "cron_list",
] as const;

// ── The runtime ─────────────────────────────────────────────────────────────

let client: WsClient | null = null;
let starting: Promise<void> | null = null;
let appStateSub: { remove(): void } | null = null;
let routerRef: { replace: (href: string) => void } | null = null;

const refresher = createTokenRefresher({
  silentLogin: async () => {
    const { baseUrl, token } = useAppStore.getState();
    const identity = await loadOrCreateIdentity(secureKeyStore, expoRandom);
    const pairing = createPairingClient((p, init) =>
      fetch((baseUrl ?? "").replace(/\/+$/, "") + p, init),
    );
    const r = await pairing.silentLogin(identity);
    if (r.ok) return { ok: true as const, token: r.token };
    if (r.rebind && token) return { ok: false as const, rebind: true };
    return { ok: false as const, rebind: false };
  },
  setToken: (token) => useAppStore.getState().setToken(token),
  onRebind: () => {
    useAppStore.getState().disconnect();
    routerRef?.replace("/pair");
  },
});

function wsUrl(): string {
  const base = (useAppStore.getState().baseUrl ?? "").replace(/^http/, "ws").replace(/\/+$/, "");
  return `${base}/`;
}

function rawSend(msg: ClientMessage) {
  client?.send(JSON.stringify(msg));
}

function send(msg: ClientMessage): boolean {
  const status = useChatStore.getState().status;
  if (!client || status !== "connected") {
    if (!client || status === "disconnected") runtime.reconnectNow();
    return false; // the UI keeps its draft/form; the banner explains why
  }
  client.send(JSON.stringify(msg));
  return true;
}

async function start(): Promise<void> {
  const { baseUrl, token } = useAppStore.getState();
  if (!baseUrl || !token) return;
  wireCore({
    baseUrl,
    authProvider: () => {
      const t = useAppStore.getState().token;
      return t ? `Bearer ${t}` : null;
    },
  });

  // Boot with a fresh token when the stored one can be re-minted silently —
  // a failed non-rebind refresh (network blip) proceeds with the stored
  // token rather than blocking the app.
  await refresher.refreshOnce();

  if (client) return; // a concurrent start() won the race
  client = new WsClient({
    url: wsUrl,
    factory: (url) =>
      rnSocketFactory(url, () => {
        const t = useAppStore.getState().token;
        return t ? `Bearer ${t}` : "";
      }),
    onStatus: (s) => useChatStore.getState().setStatus(s),
    onMessage: (m) => {
      useChatStore.getState().apply(m as ServerMessage);
      useCronStore.getState().apply(m as ServerMessage);
    },
    onOpen: () => {
      for (const type of INITIAL_QUERIES) rawSend({ type } as ClientMessage);
      // Reconnect resync: the viewed session re-syncs so an in-flight turn's
      // events reach this client again (mirrors web/MP onOpen).
      const current = useChatStore.getState().currentSessionId;
      if (current) rawSend({ type: "switch_session", id: current, resync: true } as ClientMessage);
    },
  });
  client.connect();
}

export const runtime = {
  // Called once by the tab shell. Idempotent + single-flight.
  boot(): Promise<void> {
    if (!appStateSub) {
      appStateSub = AppState.addEventListener("change", (state) => {
        if (state === "active") this.onForeground();
      });
    }
    if (!starting) {
      starting = start()
        .catch(() => {
          useChatStore.getState().setStatus("disconnected");
        })
        .finally(() => {
          starting = null;
        });
    }
    return starting;
  },

  send,
  refresher,

  reconnectNow() {
    if (client) {
      client.reconnectNow();
      return;
    }
    void this.boot();
  },

  // Foreground return: only the DOWN socket reconnects; a live one is never
  // touched and a second client can never appear.
  onForeground() {
    if (client) {
      if (useChatStore.getState().status === "disconnected") client.reconnectNow();
      return;
    }
    void this.boot();
  },

  // Settings → unbind: revoke server-side, wipe local state, land on pairing.
  async unbind(): Promise<void> {
    const { baseUrl, token } = useAppStore.getState();
    const identity = await loadOrCreateIdentity(secureKeyStore, expoRandom);
    if (baseUrl && token) {
      const pairing = createPairingClient((p, init) => fetch(baseUrl.replace(/\/+$/, "") + p, init));
      await pairing.revokeSelf(token, identity.deviceId);
    }
    client?.close();
    client = null;
    useChatStore.getState().setStatus("disconnected");
    useAppStore.getState().disconnect();
    routerRef?.replace("/pair");
  },
};

// Route access without importing hooks into this module's call paths.
export function bindRouter(router: { replace: (href: string) => void }): void {
  routerRef = router;
}

// Error visibility: core routes no-run errors here (the MP toasts; we set a
// store field the chat page renders inline).
setChatErrorSink((message) => {
  useAppStore.setState({ lastChatError: message });
});
