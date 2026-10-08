import { http, type HttpResponse } from "./http";

// Client wrappers for the /api/bots endpoints (social-bot-channels capability).
//
// Credential VALUES never cross this boundary: the server returns only the list
// of credential keys that are configured. Sending a blank value on edit means
// "keep the stored one".

export interface BotCredentialField {
  key: string;
  label: string;
  required?: boolean;
  secret?: boolean;
}

// Browser-safe QR capability the server advertises per type: how the bot's
// user entry resolves and which i18n key carries the per-platform steps.
// strategy: "telegram-me" | "wechat-qrcode" | "manual".
export interface BotQrCapability {
  strategy: string;
  hintKey: string;
  field?: string;
}

export interface BotType {
  type: string;
  credentialFields: BotCredentialField[];
  qr: BotQrCapability | null;
}

export interface Bot {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  createdAt: string;
  configuredCredentials: string[];
  webhookUrl: string;
}

// GET /api/bots/:id/qr — exactly one of the panel states, derived in the UI:
//   resolved — url + qr (server-generated SVG) both present
//   prompt   — strategy "manual", url/qr null, no error: ask for the link
//   fallback — url/qr null with an error: show the reason + the link input
export interface BotQr {
  strategy: string;
  url: string | null;
  qr: string | null;
  hint: string;
  error?: string;
}

async function jsonOrThrow<T>(res: HttpResponse): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

const send = (url: string, method: string, body?: unknown) =>
  http(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export async function listBots(): Promise<{ bots: Bot[]; types: BotType[] }> {
  return jsonOrThrow(await http("/api/bots"));
}

export async function createBot(input: {
  type: string;
  name: string;
  credentials: Record<string, string>;
}): Promise<Bot> {
  return jsonOrThrow(await send("/api/bots", "POST", input));
}

export async function updateBot(
  id: string,
  patch: { name?: string; credentials?: Record<string, string>; enabled?: boolean },
): Promise<Bot> {
  return jsonOrThrow(await send(`/api/bots/${encodeURIComponent(id)}`, "PATCH", patch));
}

export async function deleteBot(id: string): Promise<void> {
  await jsonOrThrow(await send(`/api/bots/${encodeURIComponent(id)}`, "DELETE"));
}

// Resolve a saved bot's onboarding QR. Server-side only: credentials never
// cross, the response carries the resolved URL + the rendered SVG. Upstream
// failures arrive as a 200 fallback state (see BotQr), not an HTTP error.
export async function getBotQr(id: string): Promise<BotQr> {
  return jsonOrThrow(await http(`/api/bots/${encodeURIComponent(id)}/qr`));
}
