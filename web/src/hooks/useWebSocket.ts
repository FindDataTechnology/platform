// WebSocket lifecycle hook. One connection for the whole app.
//
// The transport (connect/backoff/reconnect) lives in the shared core's
// WsClient; this hook binds it to React lifecycle and dispatches decoded
// messages into the Zustand stores. On open, the client asks the server for
// models, skills, and sessions.

import { useEffect, useRef } from "react";
import { WsClient, useChatStore, useCronStore, type ClientMessage, type ServerMessage } from "@platform/core";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { useOverlayStore } from "@/hooks/useOverlayStore";
import { useResourcesStore } from "@/hooks/useResourcesStore";
import { useFleetStore } from "@/store/fleet-store";
import { browserSocketFactory } from "@/lib/browser-socket";
import i18n from "@/i18n";
import { showToast } from "@/components/Toast";

// In dev (Vite on :5173), Vite doesn't proxy the root WS path — connect
// directly to the backend. In prod, use same-origin.
function wsUrl(): string {
  const dev = import.meta.env.DEV;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const host = dev ? "localhost:3000" : location.host;
  return `${proto}//${host}/`;
}

// One connection for the whole app, so a module-scope handle lets deep
// components send without threading `send` through every intermediate prop.
let currentSend: (msg: ClientMessage) => void = () => {};
export function wsSend(msg: ClientMessage) {
  currentSend(msg);
}

export function useWebSocket(enabled: boolean, identityKey = "") {
  const clientRef = useRef<WsClient | null>(null);
  const sendRef = useRef<(msg: ClientMessage) => void>(() => {});
  const setStatus = useChatStore((s) => s.setStatus);
  const apply = useChatStore((s) => s.apply);
  const applyExtensions = useExtensionsStore((s) => s.applyEvent);
  const applyOverlay = useOverlayStore((s) => s.applyEvent);
  const applyCron = useCronStore((s) => s.apply);
  const applyResources = useResourcesStore((s) => s.applyEvent);
  const applyFleet = useFleetStore((s) => s.apply);

  // biome-ignore lint/correctness/useExhaustiveDependencies: identityKey is a deliberate reconnect trigger — an identity change must tear down and rebuild the socket even though the effect body reads it only via this dep; wsUrl is a stable module function.
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setStatus("disconnected");
      return () => {
        cancelled = true;
      };
    }

    const client = new WsClient({
      url: wsUrl,
      factory: browserSocketFactory,
      onStatus: setStatus,
      onMessage: (msg) => {
        // Default-lane guard (add-editable-llm-route): surface a dark-default
        // substitution wherever the user is — the Models page shows the new
        // pointer, everyone else gets the toast.
        if ((msg as { type?: string }).type === "model_fallback") {
          const fb = msg as { from: string; to: string };
          showToast(i18n.t("modelsPage.modelFallbackToast", { from: fb.from, to: fb.to }));
        }
        // Board refresh signal (add-line-boards-and-action-gate): re-dispatch
        // as a window event so any mounted board can refetch its blocks.
        if ((msg as { type?: string }).type === "board_changed") {
          const bc = msg as { line: string; resources?: string[] };
          window.dispatchEvent(new CustomEvent("board_changed", { detail: bc }));
        }
        // A line credential the gate/board just saw rejected upstream
        // (add-wire-line-board D9): boards refetch and flip to "re-authorize".
        if ((msg as { type?: string }).type === "line_credential_stale") {
          const lc = msg as { line?: string };
          window.dispatchEvent(new CustomEvent("line_credential_stale", { detail: lc }));
        }
        // Fresh-session arrival (chat-input-focus): the server marks the load
        // of a session THIS client just created (New chat button, /new). The
        // chat page listens and focuses the composer — one signal for every
        // creation entry, after the creation actually completed.
        if ((msg as { type?: string }).type === "session_loaded" && (msg as { created?: boolean }).created) {
          window.dispatchEvent(new CustomEvent("session_created"));
        }
        // Opener memory echo (add-memory-visible-ux): the server re-sends the
        // owner-root digest when a session opens. Re-dispatch as a window
        // event (same seam as board_changed) so ChatPage can hold the opener
        // card page-locally instead of widening the chat store's state shape.
        if ((msg as { type?: string }).type === "memory_recall") {
          window.dispatchEvent(new CustomEvent("memory_recall", { detail: msg }));
        }
        apply(msg as ServerMessage);
        applyExtensions(msg as ServerMessage);
        applyOverlay(msg as ServerMessage);
        applyCron(msg as ServerMessage);
        applyResources(msg as ServerMessage);
        applyFleet(msg as ServerMessage);
      },
      // The protocol's initial state queries, replayed on every reconnect so
      // a resumed socket re-syncs rosters and the session list.
      onOpen: () => {
        for (const type of [
          "list_models",
          "list_agents",
          "list_skills",
          "list_presets",
          "list_permissions",
          "list_sessions",
          "list_workspaces",
          "cron_list",
        ] as const) {
          client.send(JSON.stringify({ type } satisfies ClientMessage));
        }
        // Reconnect resync (add-reconnect-resync): a resumed socket must also
        // re-sync the session the client is viewing — the in-flight turn's
        // events (and its replay log) flow only to connections the server
        // has viewing that session, and the drop left the local view stale.
        // Sent via client.send, NOT the store-aware choke point below: this
        // is a machine re-sync, and the optimistic-switch skeleton would
        // flash on every reconnect. The server treats resync:true as
        // never-navigate — an unrelated session's live run is untouched.
        const current = useChatStore.getState().currentSessionId;
        if (current) {
          client.send(JSON.stringify({ type: "switch_session", id: current, resync: true } satisfies ClientMessage));
        }
      },
    });
    clientRef.current = client;

    sendRef.current = (msg) => {
      // Optimistic session open (perf-session-open): the store flips the view
      // the moment the request leaves, from the one choke point every send
      // path shares (prop-threaded `send` and module `wsSend` alike). The
      // store no-ops on a dead socket; the send itself proceeds regardless.
      const chat = useChatStore.getState();
      if (msg.type === "switch_session") chat.activateSession(msg.id);
      else if (msg.type === "new_session") chat.beginNewSession();
      client.send(JSON.stringify(msg));
    };
    currentSend = sendRef.current;

    // Reconnect immediately when the network comes back (e.g. laptop wake),
    // bypassing the backoff timer and resetting the retry budget. The same
    // path serves the banner's manual 重试 button.
    const reconnectNow = () => {
      if (cancelled || !enabled) return;
      client.reconnectNow();
    };
    const onOnline = () => reconnectNow();
    const onManualReconnect = () => reconnectNow();
    window.addEventListener("online", onOnline);
    window.addEventListener("platform:reconnect", onManualReconnect);

    client.connect();

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("platform:reconnect", onManualReconnect);
      client.close();
    };
  }, [apply, applyCron, applyExtensions, applyFleet, applyOverlay, applyResources, enabled, identityKey, setStatus]);

  return { send: (msg: ClientMessage) => sendRef.current(msg) };
}
