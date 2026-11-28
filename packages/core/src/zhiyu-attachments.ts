// ── Room attachment contract (openspec: zhiyu-room-attachments-and-voice) ────
//
// One state machine and one card model for four clients. The whole point of
// this file: web, the guest embed, the mini program and the app must not each
// invent their own idea of when an upload is "done" or what a card says. They
// differ only in two adapters — a picker and a byte transport — and both are
// injected.
//
// Pure by construction: no DOM, no fetch, no Taro, no React Native. Every
// client supplies `upload()` and gets back a `ZhiyuAttachment`.

export type AttachmentStatus = "uploading" | "ready" | "extracting" | "opaque" | "failed";

/** What the server returns for one attachment (attachmentPublic, wire-shaped). */
export interface ZhiyuAttachment {
  id: string;
  roomId: string;
  rowSeq: number;
  name: string;
  mime: string;
  bytes: number;
  status: AttachmentStatus;
  extractChars: number;
  hasText: boolean;
  error: string | null;
  purged: boolean;
  createdAt: number;
}

/** One pending row in the composer, before it is sent. */
export interface AttachmentDraft {
  key: string;
  name: string;
  bytes: number;
  state: AttachmentStatus;
  /** Present once the server accepted the bytes; absent while uploading. */
  id?: string;
  attachment?: ZhiyuAttachment;
  error?: string;
}

/**
 * The card model. Rendering reads THIS, never the raw status: the four clients
 * would otherwise each decide for themselves that `opaque` means failure (it
 * does not — it means "this space cannot read that type", which is honest and
 * not an incident).
 */
export type CardTone = "neutral" | "ok" | "warn" | "error";

export interface AttachmentCardModel {
  tone: CardTone;
  /** i18n key suffix under zhiyu.room.attachment — never a literal string. */
  labelKey: "uploading" | "readable" | "processing" | "unreadable" | "failed" | "expired";
  /** Can the user open/download the original? False only after retention. */
  openable: boolean;
  /** Can a seat read its content this turn? */
  agentReadable: boolean;
  sizeLabel: string;
}

export function formatBytes(bytes: number): string {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function attachmentCardModel(a: {
  state?: AttachmentStatus;
  status?: AttachmentStatus;
  bytes?: number;
  purged?: boolean;
  hasText?: boolean;
}): AttachmentCardModel {
  const state = (a.state ?? a.status ?? "uploading") as AttachmentStatus;
  const sizeLabel = formatBytes(a.bytes ?? 0);
  if (a.purged) return { tone: "warn", labelKey: "expired", openable: false, agentReadable: false, sizeLabel };
  switch (state) {
    case "uploading":
      return { tone: "neutral", labelKey: "uploading", openable: false, agentReadable: false, sizeLabel };
    case "ready":
      return { tone: "ok", labelKey: "readable", openable: true, agentReadable: true, sizeLabel };
    case "extracting":
      return { tone: "neutral", labelKey: "processing", openable: true, agentReadable: false, sizeLabel };
    case "opaque":
      return { tone: "warn", labelKey: "unreadable", openable: true, agentReadable: false, sizeLabel };
    case "failed":
      return { tone: "error", labelKey: "failed", openable: true, agentReadable: false, sizeLabel };
  }
}

// ── The state machine ───────────────────────────────────────────────────────

export type AttachmentEvent =
  | { kind: "picked"; key: string; name: string; bytes: number }
  | { kind: "uploaded"; key: string; attachment: ZhiyuAttachment }
  | { kind: "settled"; attachment: ZhiyuAttachment }
  | { kind: "failed"; key: string; error: string }
  | { kind: "cancelled"; key: string }
  | { kind: "removed"; key: string };

/** Apply one event. Returns a NEW list (never mutates) so every client can hold it in its own state container. */
export function applyAttachmentEvent(drafts: AttachmentDraft[], event: AttachmentEvent): AttachmentDraft[] {
  switch (event.kind) {
    case "picked":
      return [...drafts, { key: event.key, name: event.name, bytes: event.bytes, state: "uploading" }];
    case "uploaded":
      return drafts.map((d) =>
        d.key === event.key
          ? { ...d, state: event.attachment.status, id: event.attachment.id, attachment: event.attachment, error: event.attachment.error ?? undefined }
          : d,
      );
    case "settled":
      // An audio attachment settles out of band; the row is matched by id.
      return drafts.map((d) =>
        d.id === event.attachment.id
          ? { ...d, state: event.attachment.status, attachment: event.attachment, error: event.attachment.error ?? undefined }
          : d,
      );
    case "failed":
      return drafts.map((d) => (d.key === event.key ? { ...d, state: "failed", error: event.error } : d));
    case "cancelled":
    case "removed":
      return drafts.filter((d) => d.key !== event.key);
  }
}

/** A message may not leave while any of its attachments is still uploading. */
export function canSendWithAttachments(drafts: AttachmentDraft[]): boolean {
  return !drafts.some((d) => d.state === "uploading");
}

/** Prompt reference the server expands — same `@doc:`-style pointer discipline, room-attachment flavour. */
export function attachmentPromptRef(drafts: AttachmentDraft[]): string {
  return drafts
    .filter((d) => d.id)
    .map((d) => `@att:${d.id}`)
    .join(" ");
}

/**
 * The single upload driver. Each client injects:
 *   upload(file, signal) → the server's { attachment, message } shape
 *   onDraft(next)        → its own state setter
 * Cancellation aborts the transport and drops the draft — a cancel is a
 * choice, not a failure, so it must never surface as an error chip.
 */
export async function uploadAttachment<FileLike>(opts: {
  file: FileLike;
  name: string;
  bytes: number;
  key: string;
  signal: AbortSignal;
  drafts: AttachmentDraft[];
  upload: (file: FileLike, signal: AbortSignal) => Promise<{ attachment: ZhiyuAttachment }>;
  onDraft: (next: AttachmentDraft[]) => void;
}): Promise<void> {
  const { file, name, bytes, key, signal, upload, onDraft } = opts;
  let drafts = applyAttachmentEvent(opts.drafts, { kind: "picked", key, name, bytes });
  onDraft(drafts);
  try {
    const out = await upload(file, signal);
    drafts = applyAttachmentEvent(drafts, { kind: "uploaded", key, attachment: out.attachment });
    onDraft(drafts);
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      onDraft(applyAttachmentEvent(drafts, { kind: "cancelled", key }));
      return;
    }
    onDraft(applyAttachmentEvent(drafts, { kind: "failed", key, error: String((err as Error)?.message ?? err).slice(0, 120) }));
  }
}

/** Room attachment content path — one rule, four clients. */
export function attachmentContentPath(roomId: string, attachmentId: string): string {
  return `/api/zhiyu/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}
