// zhiyu-api — the room endpoints the app calls (openspec:
// add-zhiyu-mobile-clients, tasks 4.1 / 5.1).
//
// The same endpoints as web and the mini-program, through the shared core `http`
// (wired to RN's fetch by lib/platform.wireCore). Nothing here is app-shaped.
//
// Absent on purpose: invites, private windows, subscription management, room
// settings. Those are handed to the web as one-time links (5.1).

import { http } from "@platform/core";

export interface ZhiyuRoomSummary {
  id: string;
  title: string;
  ownerEmail: string;
  status: "active" | "ended";
  lastActivityAt: number;
  createdAt: number;
}

export interface ZhiyuMemberRow {
  id: string;
  kind: string;
  ref: string;
  display: string;
  presence: string;
  onBehalfOf?: string | null;
  state?: string;
}

async function json<T>(path: string, init?: { method?: string; body?: string }): Promise<T> {
  const res = await http(path, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `HTTP ${res.status}`);
  return body as T;
}

export async function listRooms(): Promise<ZhiyuRoomSummary[]> {
  const body = await json<{ rooms?: ZhiyuRoomSummary[] }>("/api/zhiyu/rooms");
  return Array.isArray(body?.rooms) ? body.rooms : [];
}

export async function getRoom(roomId: string): Promise<{ room: ZhiyuRoomSummary; members: ZhiyuMemberRow[]; myMemberId: string | null }> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}`);
}

export async function sendMessage(roomId: string, content: string): Promise<void> {
  await json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/messages`, {
    method: "POST",
    body: JSON.stringify({ content }),
  });
}

export interface HandoffLink {
  url: string;
  path: string;
  purpose: string;
  expiresAt: number;
}

/** Mint the one-time link to a web-only surface (5.1/5.2). */
export async function mintHandoff(roomId: string, purpose: string): Promise<HandoffLink> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/deeplink`, {
    method: "POST",
    body: JSON.stringify({ purpose }),
  });
}
