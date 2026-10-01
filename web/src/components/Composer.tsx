// Composer: textarea + send + slash-command autocomplete + file attachment.
//
// Slash commands:
//   /clear /help    - client-handled, never sent to server
//   /model /new     - server-handled
//   /skill:<name>   - server expands from loaded skills
//
// The paperclip uploads via POST /api/documents and injects an @doc:<id>
// reference the server expands into the agent's context. The slash-command
// autocomplete is delegated to <SlashCommandPicker> (sectioned popover with
// filter, keyboard nav, Esc dismiss, Enter insert).
//
// All user-visible strings resolve through the i18n bundle. Slash-command
// tokens (/model, /new, …) are identifiers and stay literal.

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, Paperclip, Square, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { SlashCommandPicker, type SlashCommand } from "@/components/SlashCommandPicker";
import { ControlStrip } from "@/components/ControlStrip";
import { PlanDock } from "@/components/PlanPanel";
import { HelpDialog } from "@/components/HelpDialog";
import { useBranding } from "@/hooks/useAppConfig";
import type { ClientMessage } from "@platform/core";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/Toast";
import { uploadFile } from "@platform/core";
import { usePreviewStore } from "@/hooks/usePreviewStore";
import { fileUrl, type FileRef } from "@/lib/file-preview";

// One attached document chip. `key` is the local chip identity — the server
// document id doesn't exist until the upload resolves.
interface Attachment {
  key: string;
  id: string;
  name: string;
  state: "uploading" | "attached" | "error";
  error?: string;
  // Where the server stored this file's original, so the chip can open it in
  // the preview drawer. Set on success and on extraction failure alike.
  preview?: FileRef;
}
let attachSeq = 0;

interface Props {
  send: (m: ClientMessage) => void;
  // Controlled draft, owned by ChatPage so it survives the welcome ↔
  // in-session branch swap and can be prefilled by suggested-prompt cards.
  value: string;
  onChange: (v: string) => void;
  // Bumped by ChatPage to focus the composer (e.g. after a card prefill).
  focusTick?: number;
}

// Command tokens (identifiers, not translated) paired with i18n keys for their
// descriptions. Built into a translated commands array inside the component.
const CMD_META = [
  { label: "/model", descKey: "composer.cmd.model" },
  { label: "/new", descKey: "composer.cmd.new" },
  { label: "/clear", descKey: "composer.cmd.clear" },
  { label: "/help", descKey: "composer.cmd.help" },
];

export function Composer({ send, value, onChange, focusTick = 0 }: Props) {
  const { t } = useTranslation();
  const { assistant } = useBranding();
  const status = useChatStore((s) => s.status);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const stopStreaming = useChatStore((s) => s.stopStreaming);
  const skills = useChatStore((s) => s.skills);
  const clearView = useChatStore((s) => s.clearView);
  // A model/effort/workspace change restarts the dsh child; sending into a
  // restarting runtime would just error.
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const hasPermissionRoster = useChatStore((s) => s.permissionOptions.length > 0);
  const openPreview = usePreviewStore((s) => s.open);

  const [acIdx, setAcIdx] = useState(0);
  // Esc "dismisses" the picker without clearing the composer (a separate
  // state from the text-derived open check so the user keeps what they
  // typed). The flag resets as soon as the text changes.
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [drag, setDrag] = useState(false);
  // The persistent help center — opened by the /help command (it replaces the
  // old behavior of flashing the command list in a 1.6-second toast).
  const [helpOpen, setHelpOpen] = useState(false);
  // Attached documents: each chip is an ingested @doc:<id> reference (design
  // D4) that the server expands into the agent's context on submit. BOTH
  // entry gestures — paperclip and drag-drop — share one path, and the chip
  // is visible through the whole lifecycle (上传中 → 已附加/失败) so the
  // upload is never silent.
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  // Live upload controllers, keyed by chip key — the X on an uploading chip
  // aborts the in-flight POST instead of waiting it out.
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const disabled = status !== "connected";
  const trimmed = value.trim();
  // Send is blocked while any upload is in flight — a prompt must never leave
  // with its document half-ingested (the exact "did my file reach the agent?"
  // failure this state makes visible).
  const isUploading = attachments.some((a) => a.state === "uploading");
  const canSend = !!trimmed && !disabled && !isUploading && pendingConfig === null;

  // Built-in commands (Commands section). Skills come from the store and are
  // rendered as the Skills section inside <SlashCommandPicker>. Memoized on
  // the locale: a per-render rebuild changed `commands` identity every render
  // and defeated the mergedItems memo below.
  const commands: SlashCommand[] = useMemo(
    () => CMD_META.map((c) => ({ label: c.label, description: t(c.descKey) })),
    [t],
  );

  // Autogrow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is the deliberate trigger — resize the textarea on every keystroke
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  // Focus on demand — ChatPage bumps `focusTick` when a suggested-prompt card
  // prefills the draft.
  useEffect(() => {
    if (focusTick > 0) textareaRef.current?.focus();
  }, [focusTick]);

  // After a restart-carrying switch completes (pendingConfig non-null → null),
  // re-read the permission roster: the fresh child's session reverts to the
  // deployment default, and only a fresh roster/current push shows that
  // honestly instead of the stale pre-restart value.
  const wasPending = useRef(false);
  useEffect(() => {
    if (pendingConfig) {
      wasPending.current = true;
    } else if (wasPending.current) {
      wasPending.current = false;
      if (hasPermissionRoster) send({ type: "list_permissions" });
    }
  }, [pendingConfig, hasPermissionRoster, send]);

  const submit = () => {
    if (!canSend) return;

    // Local commands never reach the server.
    if (/^\/clear\b/i.test(trimmed)) {
      clearView();
      onChange("");
      return;
    }
    if (/^\/help\b/i.test(trimmed)) {
      setHelpOpen(true);
      onChange("");
      return;
    }

    // Append @doc:<id> references for ATTACHED documents (uploading/error
    // chips are never referenced) so the server expands the ingested document
    // content into the agent's context (design D4).
    const refs = attachments
      .filter((a) => a.state === "attached")
      .map((a) => `@doc:${a.id}`)
      .join(" ");
    const text = refs ? `${trimmed} ${refs}` : trimmed;

    // The server echoes the user turn back as a `user` event - no optimistic
    // append here, or it renders twice.
    send({ type: "prompt", text });
    onChange("");
    setAttachments([]);
  };

  const acceptAc = (label?: string) => {
    const pick = label;
    if (!pick) return;
    onChange(pick + " ");
    setAcIdx(0);
    textareaRef.current?.focus();
  };

  // The commands button inserts a bare "/" — the picker already opens off a
  // trailing `/` token, so there is no click-mode to build and no second
  // command list to keep in sync. Appends to a non-empty draft rather than
  // replacing it, so it never eats what the user typed.
  const openCommands = () => {
    const base = value.length === 0 || /\s$/.test(value) ? value : `${value} `;
    onChange(`${base}/`);
    setAcIdx(0);
    setPickerDismissed(false);
    textareaRef.current?.focus();
  };

  // ONE attach path for both gestures (paperclip + drag-drop): the chip
  // mounts as 上传中 the moment a file enters, then flips to 已附加 or 失败.
  // The chip IS the feedback — no success toast to chase. Every upload is
  // cancellable (X on the uploading chip aborts the fetch) — a guard without
  // an escape is a trap.
  const attachFiles = async (files: File[]) => {
    for (const f of files) {
      const key = `att-${++attachSeq}`;
      const abort = new AbortController();
      abortRef.current.set(key, abort);
      setAttachments((a) => [...a, { key, id: "", name: f.name, state: "uploading" }]);
      try {
        const doc = await uploadFile(f, abort.signal);
        setAttachments((a) =>
          a.map((x) =>
            x.key === key
              ? {
                  ...x,
                  id: doc.id,
                  name: doc.name || f.name,
                  state: "attached" as const,
                  preview: doc.preview ?? undefined,
                }
              : x,
          ),
        );
      } catch (err) {
        // A cancel is a choice, not a failure: drop the chip silently.
        if ((err as Error).name === "AbortError") {
          setAttachments((a) => a.filter((x) => x.key !== key));
          continue;
        }
        const message = (err as Error).message.slice(0, 120);
        // Extraction failed, but the server still stored the original: keep the
        // reference so the failed chip can show the file.
        const preview = (err as Error & { preview?: FileRef }).preview;
        setAttachments((a) =>
          a.map((x) =>
            x.key === key ? { ...x, state: "error" as const, error: message, preview } : x,
          ),
        );
        // The chip shows the failure; the toast carries the reason.
        showToast(t("composer.uploadFailed", { message: message.slice(0, 80) }));
      } finally {
        abortRef.current.delete(key);
      }
    }
    textareaRef.current?.focus();
  };

  const removeAttachment = (key: string) => {
    abortRef.current.get(key)?.abort();
    abortRef.current.delete(key);
    setAttachments((a) => a.filter((x) => x.key !== key));
  };

  // Open a chip's stored original in the preview drawer. Only chips whose file
  // the server actually stored carry a reference.
  const previewAttachment = (a: Attachment) => {
    if (!a.preview) return;
    openPreview({ name: a.name, url: fileUrl(a.preview.root, a.preview.rel), ref: a.preview });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition (pinyin, kana, …): Enter confirms the composition and
    // arrows navigate the IME candidate list — neither may submit or drive
    // the slash picker. isComposing misses some Safari versions, hence 229.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    // The slash picker derives "is open" from the text content, so we always
    // forward arrow / Enter / Tab / Esc when the picker is showing.
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setAcIdx((i) => i + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setAcIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        // The picker itself handles the pick via mouse; keyboard Enter uses
        // the same path. The flat item list lives inside the picker.
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        // Insert the highlighted pick rather than submit the raw `/...` text.
        e.preventDefault();
        const items = mergedItems;
        const pick = items[Math.min(acIdx, items.length - 1)];
        if (pick) acceptAc(pick.label);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  // Build the same flat item list the picker renders, so Enter can resolve
  // the highlighted label without the picker exposing a ref-based lookup.
  // Mirrors the filter (substring, case-insensitive, max 8/section) and the
  // Commands → Skills ordering. The picker is "open" only while a `/` token
  // is present AND the user has not dismissed it with Esc.
  const pickerOpen = useMemo(() => {
    const m = value.match(/(^|\s)(\/[^/\s]*)$/);
    if (!m) return false;
    if (pickerDismissed) return false;
    return true;
  }, [value, pickerDismissed]);
  // Reset the dismissed flag whenever the user edits the text (typing or
  // pasting), so the next `/` token re-opens the picker.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — resetting on `pickerDismissed` would immediately undo the Esc-dismiss; `value` is the reset trigger
  useEffect(() => {
    if (pickerDismissed) setPickerDismissed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const mergedItems = useMemo(() => {
    const m = value.match(/(^|\s)(\/[^/\s]*)$/);
    if (!m) return [];
    const query = (m[2] ?? "").slice(1).toLowerCase();
    const cmds = commands
      .filter((c) => c.label.toLowerCase().includes(query))
      .slice(0, 8);
    const sks = skills
      .map((s) => ({ label: `/skill:${s.name}`, description: s.description || "" }))
      .filter((s) => s.label.toLowerCase().includes(query))
      .slice(0, 8);
    return [...cmds, ...sks];
  }, [value, commands, skills]);

  // Drag-drop attaches through the SAME path as the paperclip — dropping a
  // file on the composer means "attach it to this conversation", not "upload
  // it somewhere in the background".
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) attachFiles(files);
  };

  // Determine the active filter index across the merged list. The picker
  // exposes its own index internally; we drive its highlight from here via
  // the `highlight` + `onHighlight` contract. The composer owns the
  // highlight state because it also drives keyboard navigation; the picker
  // clamps it on render.
  const handlePick = (label: string) => acceptAc(label);

  return (
    <div
      className={cn("relative border-t border-border bg-card px-4 py-3", drag && "bg-primary/5")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!drag) setDrag(true);
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDrag(false);
      }}
      onDrop={onDrop}
    >
      <SlashCommandPicker
        text={value}
        open={pickerOpen}
        highlight={acIdx}
        onHighlight={setAcIdx}
        onPick={handlePick}
        commands={commands}
      />
      <div className="mx-auto flex max-w-4xl flex-col gap-2 rounded-2xl border border-border bg-background px-3 py-2 focus-within:border-primary">
        {/* Narrow-viewport plan line (≥ lg it lives in the right-hand panel
            instead). Inside the pinned composer card, so expanding it consumes
            message-log height rather than moving the composer. */}
        <PlanDock />
        {attachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground" data-testid="composer-attach-count">
              {t("chat.composer.attachments", { count: attachments.length })}
            </span>
            {attachments.map((a) => (
              <span
                key={a.key}
                data-testid="composer-attachment"
                data-state={a.state}
                title={a.state === "error" ? a.error : a.state === "uploading" ? t("composer.uploading") : a.name}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs",
                  a.state === "error"
                    ? "border border-destructive/40 bg-destructive/10 text-destructive"
                    : "bg-muted text-foreground",
                )}
              >
                {a.state === "uploading" ? (
                  <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                ) : a.state === "error" ? (
                  <TriangleAlert className="h-3 w-3" />
                ) : (
                  <Paperclip className="h-3 w-3 text-muted-foreground" />
                )}
                {a.preview ? (
                  <button
                    type="button"
                    onClick={() => previewAttachment(a)}
                    aria-label={t("preview.openInDrawer")}
                    className="max-w-[12rem] truncate underline-offset-2 hover:underline focus-visible:underline"
                  >
                    {a.name}
                  </button>
                ) : (
                  <span className="max-w-[12rem] truncate">{a.name}</span>
                )}
                <button
                  onClick={() => removeAttachment(a.key)}
                  aria-label={a.state === "uploading" ? t("composer.cancelUpload") : t("composer.removeAttachment")}
                  className="-my-1 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          data-testid="composer-file-input"
          className="hidden"
          onChange={(e) => {
            attachFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          data-testid="composer-input"
          placeholder={t("composer.placeholder", { assistant })}
          className={cn(
            "min-h-[24px] w-full resize-none bg-transparent text-sm text-foreground outline-none",
            "placeholder:text-muted-foreground",
          )}
        />
        {/* One control row, two clusters, with send/stop as its rightmost
            element (see ControlStrip). The attachment entry inside the `+` menu
            clicks the file input above — the upload path is unchanged. */}
        <ControlStrip
          send={send}
          onOpenCommands={openCommands}
          onAttach={() => fileInputRef.current?.click()}
          trailing={
            /* Typing is never disabled — a local-first product must absorb the
               outage, not punish it: draft while disconnected, send when back. */
            isStreaming ? (
              <button
                onClick={stopStreaming}
                aria-label={t("composer.stop")}
                data-testid="composer-stop"
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-deep text-primary-foreground",
                  "hover:opacity-90",
                )}
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!canSend}
                aria-label={t("composer.send")}
                data-testid="composer-send"
                className={cn(
                  "grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary-deep text-primary-foreground",
                  "hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40",
                )}
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            )
          }
        />
      </div>
      {drag && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-md border-2 border-dashed border-primary bg-primary/5 text-sm text-primary">
          {t("composer.dropHint")}
        </div>
      )}
      <HelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
