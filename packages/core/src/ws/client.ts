// WebSocket client with the reconnect state machine, extracted from the web
// app's useWebSocket hook so the mini-program client runs the exact same
// backoff semantics.
//
// The transport is injected: `SocketFactory` returns a `SocketHandle` the
// client drives through callbacks. The web app adapts the browser WebSocket;
// the mini program adapts its socket task. Message payloads are parsed here —
// consumers receive decoded objects only.

export type WsStatus = "connecting" | "connected" | "disconnected";

export interface SocketHandle {
  send(data: string): void;
  close(): void;
  setHandlers(h: {
    onOpen(): void;
    onMessage(data: string): void;
    onClose(): void;
    onError(): void;
  }): void;
}

export type SocketFactory = (url: string) => SocketHandle;

export interface WsClientOptions {
  // Resolved on every (re)connect so a refreshed token can ride along.
  url: () => string;
  factory: SocketFactory;
  onStatus: (s: WsStatus) => void;
  onMessage: (msg: unknown) => void;
  // Fires after every successful open — the protocol's initial state queries
  // (list_models, list_agents, …) replay here.
  onOpen?: () => void;
  maxAttempts?: number;
}

const MAX_ATTEMPTS = 20;
const CAP_MS = 30_000;

// Handlers for a superseded socket: detaching (rather than just closing)
// means its late onClose — which fires asynchronously after reconnectNow()
// replaced it — can never schedule an extra reconnect. Without this, one
// manual/foreground reconnect could fan out into two live sockets.
const NOOP_HANDLERS = {
  onOpen() {},
  onMessage() {},
  onClose() {},
  onError() {},
};

export class WsClient {
  private opts: WsClientOptions;
  private socket: SocketHandle | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUser = false;

  constructor(opts: WsClientOptions) {
    this.opts = opts;
  }

  // Detach and close any socket this client no longer owns.
  private supersedeSocket() {
    const old = this.socket;
    this.socket = null;
    if (old) {
      old.setHandlers(NOOP_HANDLERS);
      old.close();
    }
  }

  connect() {
    if (this.closedByUser) return;
    this.supersedeSocket();
    this.opts.onStatus("connecting");
    const socket = this.opts.factory(this.opts.url());
    this.socket = socket;
    socket.setHandlers({
      onOpen: () => {
        this.attempt = 0;
        this.opts.onStatus("connected");
        this.opts.onOpen?.();
      },
      onMessage: (data) => {
        try {
          this.opts.onMessage(JSON.parse(data));
        } catch (err) {
          console.error("[ws] bad JSON", err);
        }
      },
      onClose: () => {
        this.opts.onStatus("disconnected");
        if (this.closedByUser) return;
        if (!this.reconnectTimer) this.scheduleReconnect();
      },
      onError: () => {
        // onClose fires after.
      },
    });
  }

  // Exponential backoff (capped at 30s) + ±25% jitter. Stops after
  // maxAttempts so a dead server isn't hammered forever; resets to 0 on a
  // successful open and on reconnectNow() (manual retry / network restored /
  // mini-program foreground).
  private scheduleReconnect() {
    if (this.closedByUser || this.attempt >= (this.opts.maxAttempts ?? MAX_ATTEMPTS)) return;
    const base = Math.min(CAP_MS, 1000 * 2 ** this.attempt);
    const delay = base * (0.75 + Math.random() * 0.5);
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // Immediate reconnect, bypassing the backoff timer and resetting the retry
  // budget. The seam for: the browser `online` event, the web app's manual
  // retry button, and the mini program's onShow. The replaced socket is
  // DETACHED first so its late onClose cannot arm a second reconnect.
  reconnectNow() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.attempt = 0;
    this.supersedeSocket();
    this.connect();
  }

  send(data: string) {
    this.socket?.send(data);
  }

  close() {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
  }
}
