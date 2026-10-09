// ChatHeader — sticky session header for the in-session state.
//
// Two things only: the editable session title (click → input, Enter commits,
// Esc cancels) and an overflow (⋯) that opens the session context menu for the
// active session. The old `model · agent · status` strip is gone — the control
// strip beneath the composer reports model and agent (and is where you change
// them), and the sidebar footer reports connection status. Three places
// showing the same state was three places to keep in sync.
//
// The title-edit logic is local state with a 300ms debounce on keystrokes;
// Enter commits immediately. The WS `rename_session` broadcasts
// `session_renamed` to all clients.

import { useCallback, useEffect, useRef, useState } from "react";
import { Pencil, X, Check, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import { ChatSessionMenu } from "@/components/ChatSessionMenu";
import { LocalFileButton } from "@/components/preview/LocalFileButton";
import { presetDisplayName } from "@/components/AgentPresetPicker";

interface Props {
  send: (m: { type: "rename_session"; id: string; title: string }) => void;
}

const DEBOUNCE_MS = 300;

export function ChatHeader({ send }: Props) {
  const { t } = useTranslation();
  const currentSessionId = useChatStore((s) => s.currentSessionId);
  const sessions = useChatStore((s) => s.sessions);
  const renameSession = useChatStore((s) => s.renameSession);

  const session = sessions.find((s) => s.id === currentSessionId);
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);

  const [menuOpen, setMenuOpen] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);

  // Delete from the header targets the ACTIVE session, which the server 409s
  // and the menu disables — so this only ever runs if that guard changes.
  const handleDeleteSession = useCallback(async (id: string) => {
    const r = await fetch(`/api/chat-history/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${r.status}`);
    }
  }, []);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session?.title || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync the draft with the store's current title whenever the active session
  // changes (e.g. the user switches via the sidebar).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `currentSessionId` is a deliberate trigger — draft must reset even when switching between sessions with identical titles
  useEffect(() => {
    setDraft(session?.title || "");
    setEditing(false);
  }, [currentSessionId, session?.title]);

  // Focus the input on edit start.
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = (text: string) => {
    if (!currentSessionId) return;
    const next = text.trim();
    if (!next || next === session?.title) {
      setDraft(session?.title || "");
      setEditing(false);
      return;
    }
    renameSession(currentSessionId, next);
    send({ type: "rename_session", id: currentSessionId, title: next });
    setEditing(false);
  };

  const onChange = (text: string) => {
    setDraft(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => commit(text), DEBOUNCE_MS);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      commit(draft);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setDraft(session?.title || "");
      setEditing(false);
    }
  };

  if (!session) return null;

  // This session's agent preset, as read-only chrome: the session started
  // under a fixed composition (dsh refuses to recompose a session with turns),
  // so the header NAMES the mode — it is never a live switch. Sessions created
  // before presets (blank metadata) read as the deployment default; a preset
  // no longer on the roster falls back to its raw id.
  const sessionPresetId = session.agentPreset || currentPreset;
  const rosterRow = presets.find((p) => p.id === sessionPresetId);
  const presetLabel =
    sessionPresetId &&
    (rosterRow ? presetDisplayName(rosterRow, t) : sessionPresetId);

  return (
    <header
      data-testid="chat-header"
      className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-card/95 px-4 py-2 backdrop-blur"
    >
      <div className="flex min-w-0 items-center gap-2">
        {editing ? (
          <>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={onKey}
              onBlur={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                commit(draft);
              }}
              maxLength={200}
              data-testid="chat-header-title-input"
              aria-label={t("chat.header.rename")}
              placeholder={t("chat.header.titlePlaceholder")}
              className="min-w-0 max-w-md flex-1 rounded-md border border-primary/60 bg-background px-2 py-1 text-sm text-foreground outline-none"
            />
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault() /* keep input focused */}
              onClick={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                commit(draft);
              }}
              data-testid="chat-header-title-confirm"
              aria-label={t("chat.header.rename")}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Check className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                setDraft(session?.title || "");
                setEditing(false);
              }}
              data-testid="chat-header-title-cancel"
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        ) : (
          <button
            type="button"
            data-testid="chat-header-title"
            onClick={() => setEditing(true)}
            aria-label={t("chat.header.editTitle")}
            className="group flex max-w-md items-center gap-1.5 truncate rounded-md px-1 py-0.5 text-sm font-medium text-foreground hover:bg-muted"
          >
            <span className="truncate">{session.title}</span>
            <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {presetLabel && (
          <span
            data-testid="agent-preset-label"
            aria-label={t("chat.preset.label")}
            className="max-w-[10rem] truncate rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
          >
            {presetLabel}
          </span>
        )}
        <LocalFileButton className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" />
        <button
          type="button"
          ref={overflowRef}
          onClick={() => setMenuOpen(true)}
          data-testid="chat-header-overflow"
          aria-label={t("chat.header.sessionActions")}
          aria-haspopup="menu"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      {menuOpen && overflowRef.current && (
        <ChatSessionMenu
          sessionId={session.id}
          isCurrent
          onDelete={handleDeleteSession}
          triggerRef={{ current: overflowRef.current }}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </header>
  );
}
