// Taro.connectSocket-backed transport for the shared core's WsClient.
//
// The factory reads the CURRENT token on every (re)connect, so a silent
// re-login before a reconnect rides along on the upgrade request's
// Authorization header.
//
// Taro's typing for connectSocket is promisified (`Promise<SocketTask>`),
// while the runtime in some versions hands back the task synchronously —
// handlers and queued sends are attached either way, and a failed connect is
// reported through the handle's close callback so the shared client schedules
// its normal reconnect.

import Taro from "@tarojs/taro";
import type { SocketFactory, SocketHandle } from "@platform/core";
import { authHeaders, clearConnError, noteConnError } from "./auth";

type Handlers = Parameters<SocketHandle["setHandlers"]>[0];

// wx's own wording for the transport failure (`connectSocket:fail …`), kept so
// the chat page can show WHY the socket is down on a real device — the one
// signal we get when the request-domain list is fine but the socket-domain
// list is not.
function errText(err: unknown): string {
  if (!err) return "";
  const e = err as { errMsg?: string; message?: string };
  return e.errMsg || e.message || String(err);
}

export const taroSocketFactory: SocketFactory = (url) => {
  let task: Taro.SocketTask | null = null;
  let handlers: Handlers | null = null;
  const pendingSends: string[] = [];
  let closed = false;

  const attach = (t: Taro.SocketTask) => {
    task = t;
    if (closed) {
      void t.close({});
      return;
    }
    if (handlers) {
      t.onOpen(() => {
        clearConnError();
        handlers?.onOpen();
      });
      t.onMessage((m: { data?: unknown }) => {
        handlers?.onMessage(typeof m.data === "string" ? m.data : "");
      });
      t.onClose((res: { code?: number; reason?: string }) => {
        if (res?.reason) noteConnError(`socket closed (${res.code}): ${res.reason}`);
        handlers?.onClose();
      });
      t.onError((err: unknown) => {
        noteConnError(errText(err) || "socket error");
        handlers?.onError();
      });
    }
    for (const data of pendingSends) void t.send({ data });
    pendingSends.length = 0;
  };

  const failConnect = (err?: unknown) => {
    // Surface the failure as a close so the WsClient's backoff takes over.
    noteConnError(errText(err) || "connectSocket failed");
    handlers?.onError();
    handlers?.onClose();
  };

  const result = Taro.connectSocket({ url, header: authHeaders() }) as unknown;
  const thenable = result as { then?: (ok: (t: Taro.SocketTask) => void, err?: (e: unknown) => void) => void };
  if (typeof thenable?.then === "function") {
    thenable.then(attach, failConnect);
  } else {
    attach(result as Taro.SocketTask);
  }

  return {
    send: (data) => {
      if (task) void task.send({ data });
      else pendingSends.push(data);
    },
    close: () => {
      closed = true;
      if (task) void task.close({});
    },
    setHandlers: (h) => {
      handlers = h;
    },
  };
};
