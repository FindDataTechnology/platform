// presets-api.ts — typed client for the custom preset API (add-custom-presets).
// The roster is deployment-global state; every mutation rides the serialized
// runtime-mutation path server-side (409 while a turn streams — surfaced here
// as a normal error the page shows inline).

export interface CustomPreset {
  id: string;
  name: string;
  persona: string;
  skills: string[];
  mcpServers: string[];
  tags: string[];
  icon: string | null;
  createdAt: string;
  updatedAt: string;
  // Composition-time markers (server-computed): references that resolve to
  // nothing right now (a pack skill whose pack left, an uninstalled server),
  // and whether an operator/cloud source overrides this id in the merged
  // catalog (the preset then composes full under the overriding persona).
  unavailableSkills: string[];
  unavailableMcpServers: string[];
  shadowed: boolean;
}

export interface CustomPresetInput {
  name: string;
  persona: string;
  skills?: string[];
  mcpServers?: string[];
  tags?: string[];
  icon?: string | null;
}

async function json(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error || `${res.status}`;
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

export function fetchCustomPresets(): Promise<{ presets: CustomPreset[] }> {
  return fetch("/api/agent/presets").then(json);
}

export function createCustomPreset(input: CustomPresetInput): Promise<{ preset: CustomPreset }> {
  return fetch("/api/agent/presets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  }).then(json);
}

export function updateCustomPreset(id: string, patch: Partial<CustomPresetInput>): Promise<{ preset: CustomPreset }> {
  return fetch(`/api/agent/presets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json);
}

export function deleteCustomPreset(id: string): Promise<{ ok: boolean }> {
  return fetch(`/api/agent/presets/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json);
}
