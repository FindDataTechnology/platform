// The mini program's one runtime: boots auth, installs the HTTP transport,
// owns the single WsClient, and funnels protocol events into the shared
// chat store (the same state machine the web app runs).
//
// The lifecycle invariants are the whole point: the server broadcasts every
// event to EVERY connected socket, so two live connections would double every
// user echo and stream delta. boot() is therefore single-flight (concurrent
// callers await the same promise, and start() re-checks `client` after its
// async auth probe), and onShow can only ever reconnect the one client —
// never spawn a second.

import Taro, { eventCenter } from "@tarojs/taro";
import {
  setChatErrorSink,
  WsClient,
  useChatStore,
  useCronStore,
  type ClientMessage,
  type ServerMessage,
} from "@platform/core";
import { ensureAuth, LOGIN_REQUIRED_EVENT, recordEmail } from "./auth";
import { baseUrl, clearToken, DEMO_BASE, enterDemoBase, exitDemoBase } from "./config";
import { installHttp } from "./taro-http";
import { taroSocketFactory } from "./taro-socket";

// Baseline error visibility (add-mp-demo-quota-end D6): core routes no-run
// errors here; unwired, they were console.error — invisible. The coded demo
// quota shapes bypass this sink (their own terminal state), so nothing toasts
// twice.
setChatErrorSink((message) => {
  Taro.showToast({ title: message, icon: "none" });
});

function wsUrl(): string {
  return `${baseUrl().replace(/^http/, "ws")}/`;
}

// The protocol's initial state queries — replayed on every (re)connect so a
// resumed socket re-syncs rosters and the session list.
const INITIAL_QUERIES = [
  "list_models",
  "list_agents",
  "list_skills",
  "list_presets",
  "list_sessions",
  "cron_list",
] as const;

// Extra subscribers beyond the two shared stores — for page-local surfaces
// (the resource library's live refresh) that should not become global stores
// just to hear one event.
const serverListeners = new Set<(m: ServerMessage) => void>();

let client: WsClient | null = null;
let starting: Promise<void> | null = null;
let authFailed = false;
// Bumped by switchBase(): an in-flight start() from before the switch must
// not install its (stale-auth, old-base) client after the reset.
let bootGen = 0;
// Whether the current boot stopped at "no bound account" (binding_required).
// The chat page renders a user-initiated sign-in affordance for this state —
// NEVER an automatic jump to the login page (openspec: mp-demo-mode;
// WeChat rejects forced login before the user has browsed).
let loginRequired = false;

// Whether this app run has already taken the automatic trip into the sandbox
// (openspec: add-mp-scan-bind, D4). ONE-SHOT per run on purpose: the entry must
// never fight a deliberate 退出演示 (or a hand-edited server address) by hauling
// the user back on the next boot. A fresh launch re-evaluates from scratch.
let autoDemoTaken = false;

export function loginRequiredNow(): boolean {
  return loginRequired;
}

// Internal fire-and-forget — for the protocol's own replays (onOpen queries),
// where silence is correct because the connection is known-live.
function rawSend(msg: ClientMessage) {
  client?.send(JSON.stringify(msg));
}

// UI-action send. A dropped switch_session / cron_add / prompt reads as a
// broken button, so a down socket must never be silent: say why in a toast,
// nudge the reconnect, and let the caller keep its local state (draft stays,
// form stays open) by returning false.
function send(msg: ClientMessage): boolean {
  const status = useChatStore.getState().status;
  if (!client || status !== "connected") {
    Taro.showToast({
      title: status === "connecting" ? "连接中，稍候再试" : "未连接，正在重连…",
      icon: "none",
    });
    if (!client || status === "disconnected") runtime.reconnectNow();
    return false;
  }
  client.send(JSON.stringify(msg));
  return true;
}

async function start(): Promise<void> {
  const gen = bootGen;
  if (client || authFailed) {
    if (authFailed) useChatStore.getState().setStatus("disconnected");
    return;
  }
  installHttp();
  let auth = await ensureAuth();
  if (gen !== bootGen) return;

  // Unbound, on a build whose paired sandbox is a DIFFERENT origin: land in the
  // sandbox instead of parking the user on an unbound banner they have to tap
  // through (openspec: mp-demo-sandbox, revised). Dev builds pair localhost for
  // both origins, so the guard is false and their behavior is unchanged.
  //
  // The sandbox is an entry route, not a trap: if it cannot hand out a session
  // the account origin comes back and the page shows its ordinary unbound
  // state, where 先体验 remains a deliberate tap.
  if (auth === "binding_required" && !autoDemoTaken && DEMO_BASE !== baseUrl()) {
    autoDemoTaken = true;
    enterDemoBase(); // remembers the account origin for 退出演示 / the bind CTA
    clearToken();
    recordEmail("");
    const demo = await ensureAuth();
    if (gen !== bootGen) return;
    if (demo === "token" || demo === "none") {
      auth = demo;
    } else {
      exitDemoBase();
      auth = "binding_required";
    }
  }

  if (auth === "failed") {
    authFailed = true;
    useChatStore.getState().setStatus("disconnected");
    return;
  }
  if (auth === "binding_required") {
    // Not an error: this WeChat user has no bound platform account yet, and
    // there is no sandbox to land in — none is paired on this build, the one
    // per-run trip is spent, or the sandbox itself just failed. The page shows
    // a "登录后开始使用" banner (user-initiated sign-in); after a successful
    // sign-in the page's foreground hook re-boots us with the fresh token.
    loginRequired = true;
    useChatStore.getState().setStatus("disconnected");
    eventCenter.trigger(LOGIN_REQUIRED_EVENT);
    return;
  }
  loginRequired = false;
  // A concurrent start() may have won the race while we probed auth.
  if (client) return;
  client = new WsClient({
    url: wsUrl,
    factory: taroSocketFactory,
    onStatus: (s) => useChatStore.getState().setStatus(s),
    onMessage: (m) => {
      useChatStore.getState().apply(m as ServerMessage);
      useCronStore.getState().apply(m as ServerMessage);
      for (const fn of serverListeners) fn(m as ServerMessage);
    },
    onOpen: () => {
      for (const type of INITIAL_QUERIES) rawSend({ type } as ClientMessage);
      // Reconnect resync (add-reconnect-resync): a resumed socket must also
      // re-sync the viewed session so an in-flight turn's events (and its
      // replay log) reach this client again; rawSend is the fire-and-forget
      // path, so no optimistic switch fires. Mirrors the web hook's onOpen.
      const current = useChatStore.getState().currentSessionId;
      if (current) {
        rawSend({ type: "switch_session", id: current, resync: true } as ClientMessage);
      }
    },
  });
  client.connect();
}

export const runtime = {
  // Whether the current boot stopped at "no bound account" — the chat page's
  // sign-in banner and send guard key off this.
  loginRequiredNow,

  // Base switch (openspec: mp-demo-sandbox): final-close the one client,
  // reset boot state, and boot fresh — the new persisted base drives both the
  // auth probe and the next WS url. Used by 先体验/退出演示.
  switchBase(): Promise<void> {
    bootGen += 1;
    client?.close();
    client = null;
    starting = null;
    authFailed = false;
    loginRequired = false;
    useChatStore.getState().setStatus("disconnected");
    return this.boot();
  },

  // Single-flight boot; concurrent callers await the same start. Once a
  // client exists, later boot() calls are a no-op (start re-checks).
  boot(): Promise<void> {
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

  // REST-only readiness (the sessions page browses history without a socket):
  // installs the HTTP transport and resolves the identity, without connecting.
  async ensureReady(): Promise<boolean> {
    installHttp();
    const auth = await ensureAuth();
    return auth !== "failed";
  },

  // Manual retry (connection banner) — resets the backoff budget of the ONE
  // client; only boots from scratch when there is nothing to reconnect.
  reconnectNow() {
    authFailed = false;
    if (client) {
      client.reconnectNow();
      return;
    }
    void this.boot();
  },

  // Subscribe to raw protocol events (page-local consumers). Returns an
  // unsubscribe function; listeners survive reconnects because the fan-out
  // lives on the client's onMessage, not on the socket itself.
  onServerMessage(fn: (m: ServerMessage) => void): () => void {
    serverListeners.add(fn);
    return () => serverListeners.delete(fn);
  },

  // Mini-program foreground: backgrounding kills sockets. Reconnect only when
  // the single client's socket is actually DOWN — a connecting or live socket
  // is left alone, and this path can never create a second client.
  onForeground() {
    if (client) {
      if (useChatStore.getState().status === "disconnected") client.reconnectNow();
      return;
    }
    void this.boot();
  },
};

export { send as wsSend };
export type { ClientMessage };
