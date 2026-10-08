// Mini-program runtime configuration: where the platform lives and the
// platform token, both persisted in mini-program storage. Dev default points
// at a local server (devtools with "不校验合法域名" on); production sets the
// gateway's HTTPS origin.

import Taro from "@tarojs/taro";

const BASE_KEY = "platform.baseUrl";
const TOKEN_KEY = "platform.mpToken";

// `localhost`, not `127.0.0.1`: the dev server binds the IPv6 localhost
// (::1) by default, and an IPv4 literal then gets connection-refused. In the
// devtools simulator `localhost` resolves to the host machine. The default is
// build-shaped: `npm run build:weapp` (production, the 体验版/正式版 upload)
// points at the deployed platform so a fresh install works with zero setup;
// dev builds (`--watch`) keep the local server. Per-device overrides live in
// storage (the ⚙ server field) and win over both.
const DEFAULT_BASE =
  process.env.NODE_ENV === "production"
    ? "https://craw.finddatatech.cloud"
    : "http://localhost:3000";

export function baseUrl(): string {
  return Taro.getStorageSync(BASE_KEY) || DEFAULT_BASE;
}

export function setBaseUrl(url: string) {
  Taro.setStorageSync(BASE_KEY, String(url).replace(/\/+$/, ""));
}

// The accountless demo sandbox origin (openspec: mp-demo-sandbox): an
// auth-free deployment where unbound reviewers chat for real. Entered from
// the unbound banner's 先体验 affordance; the previous origin is remembered
// so 退出演示 restores it.
export const DEMO_BASE =
  process.env.NODE_ENV === "production"
    ? "https://demo.finddatatech.cloud"
    : "http://localhost:3000";

const PRE_DEMO_KEY = "platform.preDemoBase";

export function isDemoBase(): boolean {
  return baseUrl() === DEMO_BASE;
}

export function enterDemoBase(): void {
  const current = baseUrl();
  if (current !== DEMO_BASE) Taro.setStorageSync(PRE_DEMO_KEY, current);
  setBaseUrl(DEMO_BASE);
}

export function exitDemoBase(): void {
  const saved = String(Taro.getStorageSync(PRE_DEMO_KEY) || "");
  setBaseUrl(saved && saved !== DEMO_BASE ? saved : DEFAULT_BASE);
  Taro.removeStorageSync(PRE_DEMO_KEY);
}

// The origin that serves the ACCOUNT (openspec: add-mp-scan-bind): while the
// client sits in the accountless sandbox the current base IS the demo one, but
// the QR a user is told to look for lives on the account deployment — the
// origin 退出演示 restores, or the build's default when nothing was remembered.
// Surfaces that must never point at the sandbox (the guide's copy row) and the
// auto-demo switch's return trip both read this instead of baseUrl().
export function accountBaseUrl(): string {
  if (baseUrl() !== DEMO_BASE) return baseUrl();
  const saved = String(Taro.getStorageSync(PRE_DEMO_KEY) || "");
  return saved && saved !== DEMO_BASE ? saved : DEFAULT_BASE;
}

export function token(): string {
  return Taro.getStorageSync(TOKEN_KEY) || "";
}

export function setToken(value: string) {
  Taro.setStorageSync(TOKEN_KEY, value);
}

export function clearToken() {
  Taro.removeStorageSync(TOKEN_KEY);
}
