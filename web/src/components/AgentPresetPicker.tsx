// AgentPresetPicker — the mode picker on the chat welcome (blank) state.
//
// dsh composes each session's agent capabilities from an agent preset, and a
// preset is fixed at session creation — dsh refuses to recompose a session
// that has produced turns. So, exactly like dsh's own surfaces: this picker is
// offered ONLY on the welcome state (a mode choice is a "next session"
// decision), and an active session shows a read-only label instead (see
// ChatHeader). Selecting restarts the dsh child with the preset baked into
// its `initialize` handshake — the same restart path as a model switch — so
// the control shows the shared pendingConfig spinner until the server's
// `current_preset` broadcast lands.
//
// Rendering rules (spec): rows come from the runtime's roster; broken rows
// stay visible but disabled with their reason; user-authored rows are marked;
// the active selection is highlighted; an empty roster renders NOTHING (no
// error — a deployment that composes no roster keeps plain chat).

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, TriangleAlert, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChatStore } from "@platform/core";
import type { ClientMessage } from "@platform/core";
import type { PresetInfo } from "@platform/core";
import { cn } from "@/lib/utils";

// The four shipped preset ids. Their preset.yml metadata is zh-only, so the
// web bundle owns localized names/descriptions; any other (user or unknown)
// preset renders the file-published name/description verbatim.
const SHIPPED_PRESET_IDS = new Set(["standard", "code", "minimal", "cordis"]);

export function presetDisplayName(preset: PresetInfo, t: (k: string) => string): string {
  return SHIPPED_PRESET_IDS.has(preset.id) ? t(`chat.preset.names.${preset.id}`) : preset.name;
}

export function presetDisplayDescription(preset: PresetInfo, t: (k: string) => string): string {
  return SHIPPED_PRESET_IDS.has(preset.id)
    ? t(`chat.preset.descriptions.${preset.id}`)
    : preset.description;
}

interface Props {
  send: (m: ClientMessage) => void;
}

export function AgentPresetPicker({ send }: Props) {
  const { t } = useTranslation();
  const presets = useChatStore((s) => s.presets);
  const currentPreset = useChatStore((s) => s.currentPreset);
  const pendingConfig = useChatStore((s) => s.pendingConfig);
  const setPendingConfig = useChatStore((s) => s.setPendingConfig);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // A deployment that composes no roster (or hasn't answered yet) renders no
  // control at all — chat is never gated on the picker.
  if (presets.length === 0) return null;

  const current = presets.find((p) => p.id === currentPreset);
  const pending = pendingConfig === "preset";
  const disabled = pendingConfig !== null;

  return (
    <section aria-labelledby="welcome-preset-heading" className="flex flex-col items-center gap-2">
      <h2 id="welcome-preset-heading" className="text-sm font-medium text-muted-foreground">
        {t("chat.preset.label")}
      </h2>
      <div ref={ref} className="relative">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-label={t("chat.preset.label")}
          aria-haspopup="menu"
          aria-expanded={open}
          data-testid="agent-preset-picker"
          data-pending={pending ? "true" : undefined}
          className={cn(
            "flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 text-sm",
            "text-foreground hover:border-primary/40 hover:bg-muted/50",
            "disabled:cursor-not-allowed disabled:opacity-50",
            open && "border-primary/40 bg-muted/50",
          )}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <span className="truncate">{current ? presetDisplayName(current, t) : t("chat.preset.unset")}</span>
          )}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </button>
        {open && (
          <div
            role="menu"
            data-testid="agent-preset-picker-menu"
            className={cn(
              "absolute left-1/2 top-full z-50 mt-1 w-[22rem] max-w-[90vw] -translate-x-1/2",
              "overflow-hidden rounded-lg border border-border bg-popover shadow-lg",
            )}
          >
            <div className="max-h-80 overflow-y-auto py-1">
              {presets.map((p) => {
                const active = p.id === currentPreset;
                const name = presetDisplayName(p, t);
                const description = presetDisplayDescription(p, t);
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    disabled={!!p.broken}
                    data-testid="agent-preset-option"
                    data-preset-id={p.id}
                    data-broken={p.broken ? "true" : undefined}
                    title={p.broken || undefined}
                    onClick={() => {
                      setOpen(false);
                      if (p.broken || p.id === currentPreset) return;
                      // Same contract as the strip's model control: mark the
                      // control pending so the composer blocks until the
                      // server's current_preset broadcast lands (a preset
                      // switch restarts the dsh child). A rejection arrives
                      // as an error toast, which clears pendingConfig.
                      setPendingConfig("preset");
                      send({ type: "set_preset", id: p.id });
                    }}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                      p.broken
                        ? "cursor-not-allowed opacity-50"
                        : active
                          ? "bg-muted text-foreground"
                          : "text-foreground hover:bg-muted/60",
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{name}</span>
                      {p.trust === "user" && (
                        <span
                          data-testid="agent-preset-user-badge"
                          className="inline-flex shrink-0 items-center gap-0.5 rounded border border-border px-1 py-px text-[10px] text-muted-foreground"
                        >
                          <UserRound className="h-2.5 w-2.5" aria-hidden="true" />
                          {t("chat.preset.userBadge")}
                        </span>
                      )}
                      {p.broken && (
                        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-destructive">
                          <TriangleAlert className="h-3 w-3" aria-hidden="true" />
                          {t("chat.preset.brokenBadge")}
                        </span>
                      )}
                    </span>
                    {description && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
                    )}
                    {p.broken && (
                      <span className="w-full truncate text-[10px] text-destructive">{p.broken}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
