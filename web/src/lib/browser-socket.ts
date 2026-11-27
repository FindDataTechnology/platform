// Browser adapter for the shared core's injectable WS transport: presents the
// DOM WebSocket behind the transport-agnostic SocketHandle.

import type { SocketFactory } from "@platform/core";

export const browserSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    setHandlers: (h) => {
      ws.onopen = () => h.onOpen();
      ws.onmessage = (ev) => h.onMessage(String(ev.data));
      ws.onclose = () => h.onClose();
      ws.onerror = () => h.onError();
    },
  };
};
