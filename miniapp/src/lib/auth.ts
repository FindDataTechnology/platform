// Mini-program identity — account-binding model (openspec: miniprogram-auth).
//
// Logto offers no password grant (deprecated in OAuth 2.1), so credentials
// never enter the mini program. First launch on a device: the user opens the
// platform in a browser (signed in) at /api/mp/bindcode and types the 6-digit
// code here once; the server BINDS this WeChat openid to that account. Every
// later launch is silent: a fresh wx.login code exchanges for a platform
// token carrying the account identity (same cell/data as the web app).
//
// Works against both deployment shapes (add-single-process-mp-auth): the
// multi-tenant gateway and a single-process AUTH_MODE=logto server expose the
// same /api/mp/* contracts. A deployment with no auth (AUTH_MODE=none) needs
// no token at all — `ensureAuth` probes for that. On 401 the client retries
// once after a silent re-login; a dropped binding surfaces as a
// login-required event.

import Taro, { eventCenter } from "@tarojs/taro";
import { baseUrl, clearToken, setToken, token } from "./config";

export const LOGIN_REQUIRED_EVENT = "platform:login-required";
// Raised whenever the recorded connection reason changes, so the chat page's
// disconnect line can re-render with it.
export const CONN_NOTE_EVENT = "platform:conn-note";

// The identity email of the last successful login (persisted so a relaunch
// knows demo-ness before the first silent exchange completes). Demo-enabled
// deployments mint demo-<hash>@demo.invalid for unbound openids (openspec:
// mp-demo-mode); the suffix is the client-side demo marker.
const EMAIL_KEY = "platform:login-email";
let lastEmail = "";
try {
  lastEmail = Taro.getStorageSync(EMAIL_KEY) || "";
} catch {
  /* storage unavailable — demo detection just waits for the next login */
}

export function recordEmail(email?: string) {
  lastEmail = typeof email === "string" ? email : "";
  try {
    if (lastEmail) Taro.setStorageSync(EMAIL_KEY, lastEmail);
    else Taro.removeStorageSync(EMAIL_KEY);
  } catch {
    /* best effort */
  }
}

export function isDemoAccount(): boolean {
  return lastEmail.endsWith("@demo.invalid");
}

export function authHeaders(): Record<string, string> {
  const t = token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

type LoginOutcome = "token" | "binding_required" | "failed";

// Why the last auth attempt failed, in the transport's own words — wx errors
// like `request:fail url not in domain list`, or the server's own
// `code2Session rejected: …`. The chat page shows this under the disconnect
// line: on a real device it is the only place the reason is visible, and it is
// what tells a domain-whitelist block apart from a rejected login.
let lastAuthError = "";

export function authError(): string {
  return lastAuthError;
}

export function noteConnError(message: unknown) {
  const text = String(message || "").trim().slice(0, 200);
  if (!text || text === lastAuthError) return;
  lastAuthError = text;
  eventCenter.trigger(CONN_NOTE_EVENT);
}

export function clearConnError() {
  if (!lastAuthError) return;
  lastAuthError = "";
  eventCenter.trigger(CONN_NOTE_EVENT);
}

async function postJson(path: string, data: Record<string, string>) {
  return Taro.request({
    url: `${baseUrl()}${path}`,
    method: "POST",
    header: { "content-type": "application/json" },
    data,
  });
}

// POST /api/mp/login with a fresh wx.login code. Bound openid → token;
// unbound → the client should show the account-login page.
async function silentLogin(): Promise<LoginOutcome> {
  let code = "";
  try {
    ({ code } = await Taro.login());
  } catch (err) {
    noteConnError((err as { errMsg?: string })?.errMsg || (err as Error)?.message || "wx.login failed");
    return "failed";
  }
  try {
    const res = await postJson("/api/mp/login", { code });
    const body = res.data as { token?: string; email?: string; error?: string } | undefined;
    if (res.statusCode === 200 && body?.token) {
      setToken(body.token);
      recordEmail(body.email);
      clearConnError();
      return "token";
    }
    if (res.statusCode === 404 && body?.error === "binding_required") return "binding_required";
    noteConnError(`${res.statusCode} ${body?.error || "login failed"}`);
    return "failed";
  } catch (err) {
    noteConnError((err as { errMsg?: string })?.errMsg || (err as Error)?.message || "login request failed");
    return "failed";
  }
}

// First sign-in: a 6-digit bind code (minted from the account's authenticated
// web session — open /api/mp/bindcode in a signed-in browser) + a fresh
// wx.login code. Throws with a server-provided reason on failure.
export async function loginWithBindCode(bindCode: string): Promise<void> {
  const { code } = await Taro.login();
  const res = await postJson("/api/mp/login-bindcode", { code, bindCode });
  const body = res.data as { token?: string; email?: string; error?: string } | undefined;
  if (res.statusCode === 200 && body?.token) {
    setToken(body.token);
    recordEmail(body.email);
    return;
  }
  throw new Error(body?.error || `登录失败 (${res.statusCode})`);
}

// Logout: drop the local token and remove the server-side binding, so the
// next launch asks for credentials again.
export async function logout(): Promise<void> {
  const t = token();
  clearToken();
  recordEmail("");
  if (!t) return;
  try {
    await Taro.request({
      url: `${baseUrl()}/api/mp/bind`,
      method: "DELETE",
      header: { Authorization: `Bearer ${t}` },
    });
  } catch {
    // Best effort — the local token is already gone, which is what matters.
  }
}

let refreshing: Promise<boolean> | null = null;

// One in-flight refresh at a time: concurrent 401s share a single exchange
// (WeChat login codes are single-use, so parallel attempts would race).
// A dropped binding raises LOGIN_REQUIRED_EVENT for the UI to answer.
export function refreshToken(): Promise<boolean> {
  if (!refreshing) {
    refreshing = silentLogin()
      .then((outcome) => {
        if (outcome === "binding_required") {
          eventCenter.trigger(LOGIN_REQUIRED_EVENT);
          return false;
        }
        return outcome === "token";
      })
      .finally(() => {
        refreshing = null;
      });
  }
  return refreshing;
}

// Boot probe: the identity endpoint tells the two deployment shapes apart —
// `mode: "none"` means no auth (local/self-host; connect tokenless), anything
// else means the account-binding door is the way in: `mode: "logto"` on a
// single-process deployment (add-single-process-mp-auth) or a 401 from the
// gateway, which rejects anonymous probes outright. /api/config cannot make
// this call: it is public pre-login on single-process deployments (the web
// SPA fetches it before signing in), so its 200 says nothing about auth.
export async function ensureAuth(): Promise<"none" | "token" | "binding_required" | "failed"> {
  try {
    const res = await Taro.request({ url: `${baseUrl()}/api/auth/me`, method: "GET" });
    if (res.statusCode === 200 && (res.data as { mode?: string } | undefined)?.mode === "none") {
      clearConnError();
      return "none";
    }
    return silentLogin();
  } catch (err) {
    // The classic one on a real device: `request:fail url not in domain list`
    // — the MP console's request-domain list is missing this origin.
    noteConnError((err as { errMsg?: string })?.errMsg || (err as Error)?.message || "auth probe failed");
    return "failed";
  }
}
