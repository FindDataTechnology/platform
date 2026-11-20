import { http, type HttpInit } from "./http";

// Personal runtime-binding API (optional SSO identity only). Identity is
// derived server-side from trusted proxy headers; the client never sends email.

export interface BindingResponse {
  ok: boolean;
  pending?: boolean;
  error?: string;
}

async function request(path: string, init: HttpInit): Promise<BindingResponse> {
  const res = await http(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  let body: BindingResponse = { ok: res.ok };
  try {
    body = { ...body, ...(await res.json()) };
  } catch {
    // Empty/non-JSON error body: the status is the message.
  }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export function savePersonalModel(providerId: string, modelId: string) {
  return request("/api/users/me/model", { method: "PUT", body: JSON.stringify({ providerId, modelId }) });
}

export function setPersonalMcp(name: string, enabled: boolean) {
  return request(`/api/users/me/mcp/${encodeURIComponent(name)}/enable`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function applyPersonalBindings() {
  return request("/api/users/me/bindings/apply", { method: "POST" });
}
