// RN global WebSocket → core's SocketHandle, with the Authorization header
// riding the upgrade request. The token provider is read on every connect so
// a silent re-login before a reconnect rides along (same contract as the
// mini program's taro-socket factory).

import type { SocketFactory, SocketHandle } from "@platform/core";

export function rnSocketFactory(url: string, tokenProvider: () => string) {
  // RN's WebSocket third argument carries headers on the upgrade; the DOM
  // lib typing only knows two — cast to the RN constructor shape.
  const Ctor = WebSocket as unknown as new (
    url: string,
    protocols?: string,
    init?: WebSocketInit,
  ) => WebSocket;
  const ws = new Ctor(url, undefined, { headers: { authorization: tokenProvider() } });
  let handlers: {
    onOpen(): void;
    onMessage(data: string): void;
    onClose(): void;
    onError(): void;
  } | null = null;
  ws.onopen = () => handlers?.onOpen();
  ws.onmessage = (ev: WebSocketMessageEvent) => handlers?.onMessage(String(ev.data));
  ws.onclose = () => handlers?.onClose();
  ws.onerror = () => handlers?.onError();
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    setHandlers: (h: Parameters<SocketHandle['setHandlers']>[0]) => {
      handlers = h;
    },
  };
}

// The RN WebSocket constructor's init shape (headers only — the part we use).
interface WebSocketInit {
  headers?: Record<string, string>;
}
