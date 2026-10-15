// overlay-api.ts — typed client for the focus overlay API (add-focus-overlay).
// The GET is the panel's single source: the stored preference diff, the role's
// effective set (derived ± overlay), and the addable universes. PUT stores the
// diff; the effect lands on the next session (the serialized runtime-mutation
// path rewrites both patches and restarts the idle runtime when the role is
// live).

import type { FocusOverlay } from "@platform/core";

export interface OverlayDoc {
  preset: string;
  overlay: FocusOverlay | null;
  effective: {
    mcpServers: string[];
    skills: string[];
    baselineSkills: string[];
  };
  addableMcp: string[];
  addableSkills: string[];
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

export function fetchOverlay(preset: string): Promise<OverlayDoc> {
  return fetch(`/api/agent/overlay?preset=${encodeURIComponent(preset)}`).then(json);
}

export function saveOverlay(preset: string, overlay: FocusOverlay): Promise<{ ok: boolean; overlay: FocusOverlay | null }> {
  return fetch("/api/agent/overlay", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset, overlay }),
  }).then(json);
}
