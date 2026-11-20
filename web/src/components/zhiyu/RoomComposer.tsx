// RoomComposer — the room input row, extracted so the member room and the
// guest embed share ONE implementation of "attach, speak, send".
//
// Why a component and not two copies: the interesting behaviour is the state
// machine, and the four clients are only supposed to differ in a picker and a
// byte transport (packages/core/src/zhiyu-attachments.ts). Web and the guest
// surface are both React, so they differ only in the transport's auth (cookie
// vs. guest pass) — that is what `uploadOne` injects.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/Markdown";
// The SAME recorder machine the 1:1 composer uses (voice-lane): cancel,
// container gate, honest error states and the 去连接 CTA all come for free.
// A hand-rolled MediaRecorder here would be a second voice implementation that
// drifts on the first container quirk.
import { VoiceRecorder } from "@platform/core";
import { browserRecordingSupported, createBrowserRecorderAdapter, type BlobLike } from "@/lib/voice-adapter";
import { transcribeAudio, VoiceError } from "@/lib/voice";
import {
  applyAttachmentEvent,
  attachmentCardModel,
  attachmentContentPath,
  canSendWithAttachments,
  formatBytes,
  uploadAttachment,
  type AttachmentDraft,
  type ZhiyuAttachment,
} from "@platform/core";

export interface RoomComposerProps {
  placeholder: string;
  sendLabel: string;
  /** Sends the text. Attachments have already been uploaded by this point. */
  onSend: (text: string) => void | Promise<void>;
  /** Uploads one file for this room and resolves with the server's attachment. */
  uploadOne: (file: File, signal: AbortSignal) => Promise<{ attachment: ZhiyuAttachment }>;
  /** Live room id, for the content URL used by the preview drawer. */
  roomId: string;
  /** Guest surfaces hide the voice entries entirely (no mic permission story). */
  allowVoice?: boolean;
  disabled?: boolean;
  testId?: string;
  // Optional controlled mode. The guest surface keeps its own draft state
  // because its @mention completion is derived from the text; a self-owned
  // draft would put that logic inside this component instead.
  value?: string;
  onChange?: (v: string) => void;
}

interface PendingRow {
  draft: AttachmentDraft;
  file: File;
}

function useOnlineVoice(supported: boolean) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    fetch("/api/voice/status", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((v) => {
        if (alive) setAvailable(Boolean(v?.available));
      })
      .catch(() => {
        if (alive) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, [supported]);
  return available;
}

export function RoomComposer({
  placeholder,
  sendLabel,
  onSend,
  uploadOne,
  roomId,
  allowVoice = false,
  disabled = false,
  testId = "zhiyu-composer",
  value: controlled,
  onChange,
}: RoomComposerProps) {
  const { t } = useTranslation();
  const [ownText, setOwnText] = useState("");
  const text = controlled ?? ownText;
  const setText = (next: string | ((prev: string) => string)) => {
    const resolved = typeof next === "function" ? next(text) : next;
    if (controlled === undefined) setOwnText(resolved);
    onChange?.(resolved);
  };
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [drag, setDrag] = useState(false);
  const [voiceState, setVoiceState] = useState<"idle" | "recording" | "transcribing" | "error">("idle");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const abortRef = useRef(new Map<string, AbortController>());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const openPreview = usePreviewStore((s) => s.open);

  const micSupported = allowVoice && browserRecordingSupported();
  const voiceAvailable = useOnlineVoice(allowVoice);
  const textRef = useRef(text);
  textRef.current = text;

  const drafts = rows.map((r) => r.draft);
  const uploading = !canSendWithAttachments(drafts);
  const trimmed = text.trim();
  const canSend = !disabled && !uploading && (trimmed.length > 0 || drafts.length > 0);

  // Drafts are owned by this component; the shared machine only computes the
  // next list, which is why the two stay in step for all four clients.
  const patchDrafts = useCallback((next: AttachmentDraft[]) => {
    setRows((prev) => {
      const byKey = new Map(next.map((d) => [d.key, d]));
      return prev
        .map((r) => {
          const d = byKey.get(r.draft.key);
          return d ? { draft: d, file: r.file } : null;
        })
        .filter((x): x is PendingRow => x !== null);
    });
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const key = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const abort = new AbortController();
        abortRef.current.set(key, abort);
        const draft: AttachmentDraft = { key, name: file.name, bytes: file.size, state: "uploading" };
        setRows((prev) => [...prev, { draft, file }]);
        let current: AttachmentDraft[] = [...drafts, draft];
        try {
          await uploadAttachment({
            file,
            name: file.name,
            bytes: file.size,
            key,
            signal: abort.signal,
            drafts: current,
            upload: (f, signal) => uploadOne(f, signal),
            onDraft: (next) => {
              current = next;
              patchDrafts(next);
            },
          });
        } catch (err) {
          current = applyAttachmentEvent(current, { kind: "failed", key, error: String((err as Error)?.message ?? err) });
          patchDrafts(current);
        } finally {
          abortRef.current.delete(key);
        }
      }
    },
    [drafts, patchDrafts, uploadOne],
  );

  const removeRow = (key: string) => {
    abortRef.current.get(key)?.abort();
    abortRef.current.delete(key);
    patchDrafts(applyAttachmentEvent(drafts, { kind: "removed", key }));
  };

  const openAttachment = (d: AttachmentDraft) => {
    const att = d.attachment;
    if (!att) return;
    openPreview({ name: att.name, url: attachmentContentPath(roomId, att.id) });
  };

  const submit = async () => {
    if (!canSend) return;
    const body = trimmed;
    const attachedNames = drafts.map((d) => d.name);
    setText("");
    setRows([]);
    // Attachments already ride their own rows server-side; the sentence is the
    // human's message. Sending both keeps "files + what I said about them" in
    // the order the user meant.
    const composed = [attachedNames.length ? `（附件：${attachedNames.join("、")}）` : "", body].filter(Boolean).join(" ");
    await onSend(composed || body);
  };

  // ── voice (web only; the guest surface opts out) ──────────────────────────
  // The shared machine drives the phase; this component only supplies the
  // browser adapter and renders what the machine reports.
  const recorderRef = useRef<VoiceRecorder<BlobLike> | null>(null);
  if (recorderRef.current === null && allowVoice) {
    recorderRef.current = new VoiceRecorder<BlobLike>({
      adapter: createBrowserRecorderAdapter(),
      upload: (take) => transcribeAudio(take.artifact as unknown as Blob, take.fileName),
      insert: (got) => setText((prev) => (prev ? `${prev} ${got}` : got)),
      onPhase: (phase, failure) => {
        if (phase === "error") {
          setVoiceState("error");
          setVoiceError(failure?.message || t("composer.voice.failed"));
          return;
        }
        setVoiceState(phase === "recording" ? "recording" : phase === "transcribing" ? "transcribing" : "idle");
      },
    });
  }
  const rec = recorderRef.current;

  useEffect(() => {
    return () => {
      void recorderRef.current?.cancel();
    };
  }, []);

  const toggleRecord = () => {
    if (!rec) return;
    if (rec.phase() === "recording") void rec.stop();
    else if (rec.phase() !== "transcribing") void rec.start();
  };

  const pickAudio = (file: File | undefined) => {
    if (!file) return;
    setVoiceState("transcribing");
    setVoiceError(null);
    void transcribeAudio(file, file.name || "audio")
      .then(({ text: got }) => {
        if (got) setText((prev) => (prev ? `${prev} ${got}` : got));
        setVoiceState("idle");
      })
      .catch((err) => {
        setVoiceState("error");
        setVoiceError(err instanceof VoiceError ? err.message : t("composer.voice.failed"));
      });
  };

  return (
    <div
      className={cn("relative border-t p-3", drag && "bg-muted/40")}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const files = Array.from(e.dataTransfer.files ?? []);
        if (files.length) void addFiles(files);
      }}
    >
      {rows.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5" data-testid="zhiyu-attachment-chips">
          {rows.map(({ draft }) => {
            const card = attachmentCardModel(draft);
            return (
              <span
                key={draft.key}
                data-testid="zhiyu-attachment-chip"
                data-state={draft.state}
                data-tone={card.tone}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
                  card.tone === "error" && "border-destructive/40 text-destructive",
                  card.tone === "warn" && "border-warning/40 text-warning",
                  card.tone === "neutral" && "text-muted-foreground",
                )}
              >
                {card.openable ? (
                  <button type="button" className="max-w-[12rem] truncate underline-offset-2 hover:underline" onClick={() => openAttachment(draft)}>
                    {draft.name}
                  </button>
                ) : (
                  <span className="max-w-[12rem] truncate">{draft.name}</span>
                )}
                <span className="text-muted-foreground/70">{card.sizeLabel}</span>
                {card.labelKey !== "readable" && <span>{t(`zhiyu.room.attachment.${card.labelKey}`)}</span>}
                <button
                  type="button"
                  aria-label={draft.state === "uploading" ? t("composer.cancelUpload") : t("composer.removeAttachment")}
                  className="-my-1 rounded-md p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => removeRow(draft.key)}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      )}
      {voiceState !== "idle" && (
        <div className="mb-1 text-xs text-muted-foreground" data-testid="zhiyu-voice-state" data-state={voiceState}>
          {voiceState === "recording" ? t("composer.voice.recording") : voiceState === "transcribing" ? t("composer.voice.transcribing") : voiceError}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="zhiyu-file-input"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      {voiceAvailable && (
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          data-testid="zhiyu-audio-input"
          onChange={(e) => {
            pickAudio(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          aria-label={t("composer.attach")}
          data-testid="zhiyu-attach"
          className="mb-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => fileInputRef.current?.click()}
        >
          +
        </button>
        {voiceAvailable && micSupported && (
          <button
            type="button"
            aria-label={t("composer.voice.record")}
            data-testid="zhiyu-record"
            data-state={voiceState}
            className={cn("mb-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted", voiceState === "recording" && "text-destructive")}
            onClick={() => void toggleRecord()}
          >
            ●
          </button>
        )}
        {voiceAvailable && (
          <button
            type="button"
            aria-label={t("composer.voice.file")}
            data-testid="zhiyu-audio"
            className="mb-1.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted"
            onClick={() => audioInputRef.current?.click()}
          >
            ♪
          </button>
        )}
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={placeholder}
          className="min-h-[44px] flex-1"
          data-testid={testId}
        />
        <Button onClick={() => void submit()} disabled={!canSend} data-testid={`${testId}-send`}>
          {sendLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * A settled attachment as it appears ON a message row (not in the composer).
 * Same card model as the draft chips — one notion of tone/label for both.
 */
export function AttachmentRowCard({
  roomId,
  meta,
}: {
  roomId: string;
  meta: { id: string; name: string; mime?: string; bytes?: number; status?: ZhiyuAttachment["status"] };
}) {
  const { t } = useTranslation();
  const openPreview = usePreviewStore((s) => s.open);
  const card = attachmentCardModel({ status: meta.status ?? "ready", bytes: meta.bytes });
  return (
    <div
      data-testid="zy-attachment-card"
      data-tone={card.tone}
      className={cn(
        "mt-1.5 flex items-center gap-2 rounded-md border border-current/20 px-2 py-1 text-xs",
        card.tone === "warn" && "text-warning",
        card.tone === "error" && "text-destructive",
      )}
    >
      <button
        type="button"
        className="max-w-[16rem] truncate underline-offset-2 hover:underline"
        onClick={() => openPreview({ name: meta.name, url: attachmentContentPath(roomId, meta.id) })}
      >
        {meta.name}
      </button>
      <span className="text-muted-foreground/70">{formatBytes(meta.bytes ?? 0)}</span>
      {card.labelKey !== "readable" && <span>{t(`zhiyu.room.attachment.${card.labelKey}`)}</span>}
    </div>
  );
}

/**
 * Message body renderer for room rows: Markdown, because agents answer in it.
 * Exported beside the composer so both room surfaces render identically and a
 * future client has one place to look.
 */
export function RoomMessageBody({ text }: { text: string }) {
  return (
    <div className="break-words text-sm">
      <Markdown text={text} />
    </div>
  );
}
