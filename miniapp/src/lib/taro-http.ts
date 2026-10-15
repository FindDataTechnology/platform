// Taro.request-backed transport for the shared core's REST clients.
//
// Satisfies the core's HttpResponse slice (ok/status/statusText/json) so the
// exact client code the web app runs — chat history, documents, extensions —
// works unchanged. A 401 is retried ONCE after a silent re-login, which is
// how an expired 12h token recovers without the user noticing.

import Taro from "@tarojs/taro";
import { configureHttp, type HttpInit, type HttpResponse } from "@platform/core";
import { authHeaders, refreshToken } from "./auth";
import { baseUrl } from "./config";

async function requestOnce(path: string, init: HttpInit | undefined, retried: boolean): Promise<HttpResponse> {
  const res = await Taro.request({
    url: path, // configureHttp() already prefixed the base URL
    method: (init?.method ?? "GET") as keyof Taro.request.Method,
    header: init?.headers,
    data: init?.body,
    dataType: "json",
  });
  if (res.statusCode === 401 && !retried) {
    // One silent re-login, then retry the original request exactly once.
    if (await refreshToken()) return requestOnce(path, init, true);
  }
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    statusText: String(res.errMsg ?? ""),
    json: async () => res.data,
  };
}

// Install once at app boot. Call again after changing the base URL.
export function installHttp() {
  configureHttp({
    baseUrl: baseUrl(),
    headers: authHeaders,
    transport: (path, init) => requestOnce(path, init, false),
  });
}
