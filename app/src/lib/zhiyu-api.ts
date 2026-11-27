// zhiyu-api — the room endpoints the app calls (openspec:
// add-zhiyu-mobile-clients, tasks 4.1 / 5.1).
//
// The same endpoints as web and the mini-program, through the shared core `http`
// (wired to RN's fetch by lib/platform.wireCore). Nothing here is app-shaped.
//
// Absent on purpose: invites, private windows, subscription management, room
// settings. Those are handed to the web as one-time links (5.1).

import { http } from "@platform/core";
import type { ZhiyuAttachment } from "@platform/core";
import { attachmentFormEntry, readUploadResult, roomAttachmentPath, type RoomAttachmentFile } from "./room-attachment-transport";

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

// ── Meeting capture (openspec: add-meeting-capture, 5.3) ────────────────────
// Identical shape to web and the mini-program on purpose: a client-specific
// variant of a meeting field is how the three of them start to disagree about
// who attended.

export interface ZhiyuMeeting {
  id: string;
  roomId: string;
  title: string;
  status: "open" | "ended";
  createdAt: number;
  endedAt: number | null;
}

export interface ZhiyuMeetingParticipant {
  memberRef: string;
  captureId: string | null;
  state: "joined" | "finished" | "abandoned";
}

export interface ZhiyuMeetingView {
  meeting: ZhiyuMeeting;
  participants: ZhiyuMeetingParticipant[];
  delivered: number;
  awaitingConfirmation: number;
  orderBasis: "arrival";
}

export async function openMeeting(roomId: string, title: string): Promise<ZhiyuMeeting> {
  const body = await json<{ meeting: ZhiyuMeeting }>(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  return body.meeting;
}

/**
 * What is running in this room right now (add-meeting-discovery).
 *
 * Returns the ONE open meeting plus my stream in it (or null for both). Before
 * this existed, a meeting was only joinable by the person who opened it in the
 * page where they opened it — the second person in a room could not see that a
 * meeting was on, so the whole "everyone claims their own stream" model was
 * unreachable. Read-only; a failure must not block opening a new meeting.
 */
export async function getOpenMeeting(
  roomId: string,
): Promise<{ meeting: ZhiyuMeeting | null; participant: ZhiyuMeetingParticipant | null }> {
  return json(`/api/zhiyu/rooms/${encodeURIComponent(roomId)}/meetings/open`);
}

export async function joinMeeting(meetingId: string): Promise<void> {
  await json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/join`, { method: "POST", body: JSON.stringify({}) });
}

export async function endMeeting(meetingId: string): Promise<void> {
  await json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/end`, { method: "POST", body: JSON.stringify({}) });
}

export async function getMeeting(meetingId: string): Promise<ZhiyuMeetingView> {
  return json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}`);
}

/**
 * POST /api/zhiyu/meetings/:id/capture — bind this stream to MY seat
 * (openspec: meeting-capture-client-wiring, 1.3).
 *
 * The idempotent bind the meeting read face uses to say which participant owns
 * which capture. `409 not_joined` means this caller never joined — the server
 * will not attribute a stream to a seat without that evidence.
 */
export async function bindMeetingCapture(meetingId: string, captureId: string): Promise<void> {
  await json(`/api/zhiyu/meetings/${encodeURIComponent(meetingId)}/capture`, {
    method: "POST",
    body: JSON.stringify({ captureId }),
  });
}

/**
 * POST /api/voice/captures/:id/zhiyu-room — publish a finished capture into a
 * Zhiyu room (the same confirmation the web makes: `confirm: true`).
 *
 * Needed on the phone because the meeting flow only completes when the bound
 * stream reaches the room: binding says WHO owns it, this says where it goes.
 */
export async function sendCaptureToVoiceRoom(
  captureId: string,
  roomId: string,
): Promise<{ ok: true; roomId: string; messages?: number }> {
  return json(`/api/voice/captures/${encodeURIComponent(captureId)}/zhiyu-room`, {
    method: "POST",
    body: JSON.stringify({ roomId, confirm: true }),
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

/**
 * Attach one file to a room (zhiyu-room-attachments).
 *
 * RN has fetch + FormData, so the byte transport is plain — but it still goes
 * through THIS one function rather than each screen rolling its own, and the
 * state machine/card model come from @platform/core. Only the picker differs.
 */
export async function uploadRoomAttachment(opts: { roomId: string; file: RoomAttachmentFile }): Promise<{ attachment: ZhiyuAttachment }> {
  const fd = new FormData();
  // RN's FormData takes the descriptor triple, never a Blob — see
  // room-attachment-transport.ts, which is where that rule is TESTED.
  // Inlining it here meant no test could reach it.
  fd.append("file", attachmentFormEntry(opts.file) as unknown as Blob);
  const res = await http(roomAttachmentPath(opts.roomId), { method: "POST", body: fd });
  const body = (await res.json().catch(() => null)) as unknown;
  return { attachment: readUploadResult({ ok: res.ok, status: res.status, body }) as ZhiyuAttachment };
}
