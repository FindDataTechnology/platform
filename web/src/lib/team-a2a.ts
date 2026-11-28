// web/src/lib/team-a2a.ts — the browser side of a team call
// (openspec: add-team-as-a2a-agent, 7.1).
//
// The wire is JSON-RPC over SSE, and the refusal is a NORMAL HTTP response
// (not an event): the server decides every refusal before the stream opens, so
// a caller can rely on the status code. That is why this helper reads the JSON
// body when `!res.ok` and only then starts parsing events — a refusal must
// never look like an empty stream.
//
// Error codes stay machine-discriminating all the way to the UI: the caller
// maps `code` to localized guidance instead of printing an English server
// message at a Chinese user.

export interface TeamCallEvent {
  event: string;
  data: Record<string, unknown> | null;
}

export type TeamCallOutcome =
  | { ok: true; text: string }
  | { ok: false; code: string; detail?: Record<string, unknown> };

export interface TeamCallSurface {
  v: number;
  handle: string;
  visibility: "listed" | "open";
  quota: { callsPerDay: number; tokensPerDay: number; usdPerDay: number };
  usage: { calls: number; tokens: number; usd: number };
  resetsAt: number;
}

export async function fetchTeamCallSurface(cellId: string, handle: string): Promise<TeamCallSurface> {
  const r = await fetch(`/api/teams/${encodeURIComponent(cellId)}/${encodeURIComponent(handle)}/a2a`);
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body as { error?: { code?: string } } | null)?.error?.code ?? `HTTP ${r.status}`);
  return body as TeamCallSurface;
}

export async function fetchApprovalState(cellId: string, handle: string): Promise<string> {
  const r = await fetch(`/api/teams/${encodeURIComponent(cellId)}/${encodeURIComponent(handle)}/request`);
  const body = await r.json().catch(() => null);
  if (!r.ok) return "unknown";
  return String((body as { state?: string } | null)?.state ?? "unknown");
}

export async function requestTeamApproval(cellId: string, handle: string): Promise<string> {
  const r = await fetch(`/api/teams/${encodeURIComponent(cellId)}/${encodeURIComponent(handle)}/request`, { method: "POST" });
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return String((body as { state?: string } | null)?.state ?? "pending");
}

/** Parse one SSE frame into an event, tolerating comment/keepalive frames. */
function parseFrame(frame: string): TeamCallEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  try {
    return { event, data: JSON.parse(raw) as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Stream one call. `onDelta` receives the accumulated text (the server sends
 * cumulative deltas, same as the agent a2a adapter).
 */
export async function streamTeamCall({
  cellId,
  handle,
  text,
  onDelta,
  signal,
}: {
  cellId: string;
  handle: string;
  text: string;
  onDelta?: (acc: string) => void;
  signal?: AbortSignal;
}): Promise<TeamCallOutcome> {
  const res = await fetch(`/api/teams/${encodeURIComponent(cellId)}/${encodeURIComponent(handle)}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `ui-${Date.now().toString(36)}`,
      method: "message/stream",
      params: { message: { role: "user", kind: "message", parts: [{ kind: "text", text }] } },
    }),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | { error?: { data?: { code?: string; detail?: Record<string, unknown> } } }
      | null;
    return {
      ok: false,
      code: body?.error?.data?.code ?? `http_${res.status}`,
      ...(body?.error?.data?.detail ? { detail: body.error.data.detail } : {}),
    };
  }

  // A stream that never produces a terminal event (network cut) is not a
  // success: `finalText` only exists once `message`/`done` arrives.
  let finalText: string | null = null;
  let streamError: { code: string; detail?: Record<string, unknown> } | null = null;

  const reader = res.body?.getReader();
  if (!reader) return { ok: false, code: "internal_error" };
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx = buffer.indexOf("\n\n");
    while (idx !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseFrame(frame);
      if (parsed) {
        if (parsed.event === "delta") {
          const parts = (parsed.data?.parts ?? []) as { text?: string }[];
          onDelta?.(parts[0]?.text ?? "");
        } else if (parsed.event === "message") {
          const parts = (parsed.data?.parts ?? []) as { text?: string }[];
          finalText = parts[0]?.text ?? "";
        } else if (parsed.event === "error") {
          streamError = {
            code: String(parsed.data?.code ?? "internal_error"),
            ...(parsed.data?.detail ? { detail: parsed.data.detail as Record<string, unknown> } : {}),
          };
        }
      }
      idx = buffer.indexOf("\n\n");
    }
  }

  if (streamError) return { ok: false, code: streamError.code, ...(streamError.detail ? { detail: streamError.detail } : {}) };
  if (finalText === null) return { ok: false, code: "incomplete" };
  return { ok: true, text: finalText };
}
