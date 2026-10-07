// Chat-history REST client (read-mostly persistence of chat sessions).
//
// The web app lists sessions over the WS protocol; these endpoints serve the
// per-session fetch plus rename/delete. The mini-program client — which has
// no long-lived sidebar — lists through here too, so both ends share one
// serialization of SessionMeta/ChatMessage.

import type { ChatMessage, SessionMeta } from "../types/ws";
import { http, type HttpResponse } from "./http";

async function jsonOrThrow<T>(res: HttpResponse): Promise<T> {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string } | null;
      if (j?.error) msg = j.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function listChatSessions(): Promise<SessionMeta[]> {
  const r = await http("/api/chat-history/sessions");
  const j = await jsonOrThrow<{ sessions: SessionMeta[] }>(r);
  return j.sessions ?? [];
}

export async function getChatSession(id: string): Promise<{ id: string; title?: string; messages: ChatMessage[] }> {
  const r = await http(`/api/chat-history/sessions/${encodeURIComponent(id)}`);
  const j = await jsonOrThrow<{ id: string; title?: string; messages: ChatMessage[] }>(r);
  return { id: j.id, title: j.title, messages: j.messages ?? [] };
}

export async function renameChatSession(id: string, title: string): Promise<void> {
  await jsonOrThrow(
    await http(`/api/chat-history/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  );
}

export async function deleteChatSession(id: string): Promise<void> {
  const r = await http(`/api/chat-history/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}
