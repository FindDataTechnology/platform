// OverlayPanel — the per-role 资源微调 dialog (add-focus-overlay, design D4).
//
// One focused role's effective set with per-item remove toggles, plus add
// chip-pickers drawn from the GET's addable universes. Applying PUTs the
// preference diff and shows the next-session note; the effect composes on the
// serialized runtime-mutation path (rejected while a turn streams). The panel
// renders what the GET says — no optimistic state — and refetches when the
// deployment-global overlay_changed pulse arrives, so two clients looking at
// the same role always agree.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FocusOverlay } from "@platform/core";
import { fetchOverlay, saveOverlay, type OverlayDoc } from "@/lib/overlay-api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useOverlayStore } from "@/hooks/useOverlayStore";
import { cn } from "@/lib/utils";

const EMPTY: FocusOverlay = { addMcp: [], removeMcp: [], addSkills: [], removeSkills: [] };

interface Props {
  role: { id: string; name: string; packName?: string } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const toggleIn = (list: string[], name: string, on: boolean) =>
  on ? [...new Set([...list, name])] : list.filter((n) => n !== name);

// One toggle chip: an effective-set member the user may remove (and restore).
function MemberChip({
  name,
  removed,
  onToggle,
  added,
}: {
  name: string;
  removed: boolean;
  added: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid={`overlay-item-${name}`}
      data-removed={removed ? "true" : undefined}
      data-origin={added ? "overlay-add" : "derived"}
      onClick={onToggle}
      title={removed ? t("overlay.restore") : t("overlay.remove")}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px]",
        removed
          ? "border-border bg-muted text-muted-foreground line-through"
          : "border-border bg-background text-foreground hover:bg-muted",
      )}
    >
      {added && !removed && <span className="text-primary">+</span>}
      {name}
      <span className="text-muted-foreground">{removed ? "○" : "✕"}</span>
    </button>
  );
}

// One addable chip from the universe.
function AddChip({ name, on, onToggle }: { name: string; on: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      data-testid={`overlay-add-${name}`}
      data-on={on ? "true" : undefined}
      onClick={onToggle}
      title={t("overlay.add")}
      className={cn(
        "flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 font-mono text-[11px]",
        on
          ? "border-primary/50 bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {on ? "✓" : "+"} {name}
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="pb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{children}</div>;
}

export function OverlayPanel({ role, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const pulse = useOverlayStore((s) => s.pulse);
  const [doc, setDoc] = useState<OverlayDoc | null>(null);
  const [draft, setDraft] = useState<FocusOverlay>(EMPTY);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const preset = role?.id ?? null;

  const load = useCallback(async () => {
    if (!preset) return;
    try {
      const d = await fetchOverlay(preset);
      setDoc(d);
      setDraft(d.overlay ?? EMPTY);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [preset]);

  useEffect(() => {
    if (!open) return;
    setApplyError(null);
    setApplied(false);
    void load();
  }, [open, load]);

  // Deployment-global refresh: any client's PUT pulses; refetch this role's
  // view so the panel never disagrees with the stored diff. The latest
  // open/doc/load are read through a ref — pulse is the sole trigger, and
  // listing the guards as deps would refetch on every doc update.
  const liveRef = useRef({ open: false, load: null as null | (() => Promise<void>) });
  liveRef.current = { open, load };
  // biome-ignore lint/correctness/useExhaustiveDependencies: pulse is the sole trigger by design; open/load are read through liveRef exactly so doc updates do not refetch
  useEffect(() => {
    if (liveRef.current.open) void liveRef.current.load?.();
  }, [pulse]);

  const dim = useMemo(
    () => ({
      mcp: {
        effective: doc?.effective.mcpServers ?? [],
        universe: doc?.addableMcp ?? [],
        storedAdd: doc?.overlay?.addMcp ?? [],
        storedRemove: doc?.overlay?.removeMcp ?? [],
        added: draft.addMcp,
        removed: draft.removeMcp,
      },
      skills: {
        effective: doc?.effective.skills ?? [],
        universe: doc?.addableSkills ?? [],
        storedAdd: doc?.overlay?.addSkills ?? [],
        storedRemove: doc?.overlay?.removeSkills ?? [],
        added: draft.addSkills,
        removed: draft.removeSkills,
      },
    }),
    [doc, draft],
  );

  // An effective member toggles OFF into removeMcp — unless the stored overlay
  // ADDED it (then dropping it from addMcp is the honest off) — and back ON by
  // leaving whichever list held it. `on` is the wanted state.
  const toggleMember = (scope: "mcp" | "skills", name: string, on: boolean) => {
    const d = dim[scope];
    const wasStoredAdd = d.storedAdd.includes(name);
    setApplyError(null);
    setApplied(false);
    setDraft((prev) => {
      if (scope === "mcp") {
        return {
          ...prev,
          removeMcp: on
            ? toggleIn(prev.removeMcp, name, false)
            : wasStoredAdd ? prev.removeMcp : toggleIn(prev.removeMcp, name, true),
          addMcp: on
            ? (wasStoredAdd ? toggleIn(prev.addMcp, name, true) : prev.addMcp)
            : toggleIn(prev.addMcp, name, false),
        };
      }
      return {
        ...prev,
        removeSkills: on
          ? toggleIn(prev.removeSkills, name, false)
          : wasStoredAdd ? prev.removeSkills : toggleIn(prev.removeSkills, name, true),
        addSkills: on
          ? (wasStoredAdd ? toggleIn(prev.addSkills, name, true) : prev.addSkills)
          : toggleIn(prev.addSkills, name, false),
      };
    });
  };

  // A universe chip toggles a pending add — unless the stored overlay REMOVED
  // the name, in which case the chip is a restore toggle over removeMcp (an
  // add would clash with the stored removal and 400).
  const toggleUniverse = (scope: "mcp" | "skills", name: string, on: boolean) => {
    const d = dim[scope];
    setApplyError(null);
    setApplied(false);
    setDraft((prev) => {
      if (d.storedRemove.includes(name)) {
        return scope === "mcp"
          ? { ...prev, removeMcp: toggleIn(prev.removeMcp, name, !on) }
          : { ...prev, removeSkills: toggleIn(prev.removeSkills, name, !on) };
      }
      return scope === "mcp"
        ? { ...prev, addMcp: toggleIn(prev.addMcp, name, on) }
        : { ...prev, addSkills: toggleIn(prev.addSkills, name, on) };
    });
  };

  // A universe chip is ON when its add is pending, or when it is a stored
  // removal the draft restores (still rendered here until the next fetch
  // moves it into the effective set).
  const universeOn = (scope: "mcp" | "skills", name: string) => {
    const d = dim[scope];
    return d.added.includes(name) || (d.storedRemove.includes(name) && !d.removed.includes(name));
  };

  const apply = async () => {
    if (!preset || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      await saveOverlay(preset, draft);
      await load();
      setApplied(true);
    } catch (e) {
      const err = e as Error & { status?: number };
      setApplyError(err.status === 409 ? t("overlay.streamBusy") : err.message);
    } finally {
      setApplying(false);
    }
  };

  if (!role) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("overlay.title")}
        className="max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t("overlay.title")}
            <span className="ml-2 font-normal text-muted-foreground">
              {role.name}
              {role.packName ? ` · ${role.packName}` : ""}
            </span>
          </DialogTitle>
          <DialogDescription>{t("overlay.desc")}</DialogDescription>
        </DialogHeader>

        {loadError && (
          <p data-testid="overlay-load-error" className="text-xs text-destructive">
            {t("overlay.loadError")}: {loadError}
          </p>
        )}
        {!doc && !loadError && <p className="text-xs text-muted-foreground">…</p>}

        {doc && (
          <div className="max-h-[50vh] space-y-4 overflow-y-auto py-1">
            <div>
              <SectionLabel>{t("overlay.mcp")}</SectionLabel>
              <div className="flex flex-wrap gap-1.5" data-testid="overlay-mcp-members">
                {dim.mcp.effective.map((name) => (
                  <MemberChip
                    key={name}
                    name={name}
                    added={dim.mcp.storedAdd.includes(name)}
                    removed={dim.mcp.removed.includes(name) && !dim.mcp.added.includes(name)}
                    onToggle={() => toggleMember("mcp", name, dim.mcp.removed.includes(name))}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="overlay-mcp-addable">
                {dim.mcp.universe.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">{t("overlay.noneAddable")}</span>
                )}
                {dim.mcp.universe.map((name) => (
                  <AddChip
                    key={name}
                    name={name}
                    on={universeOn("mcp", name)}
                    onToggle={() => toggleUniverse("mcp", name, !universeOn("mcp", name))}
                  />
                ))}
              </div>
            </div>

            <div>
              <SectionLabel>{t("overlay.skills")}</SectionLabel>
              <div className="flex flex-wrap gap-1.5" data-testid="overlay-skill-members">
                {dim.skills.effective.map((name) => (
                  <MemberChip
                    key={name}
                    name={name}
                    added={dim.skills.storedAdd.includes(name)}
                    removed={dim.skills.removed.includes(name) && !dim.skills.added.includes(name)}
                    onToggle={() => toggleMember("skills", name, dim.skills.removed.includes(name))}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="overlay-skill-addable">
                {dim.skills.universe.length === 0 && (
                  <span className="text-[11px] text-muted-foreground">{t("overlay.noneAddable")}</span>
                )}
                {dim.skills.universe.map((name) => (
                  <AddChip
                    key={name}
                    name={name}
                    on={universeOn("skills", name)}
                    onToggle={() => toggleUniverse("skills", name, !universeOn("skills", name))}
                  />
                ))}
              </div>
            </div>

            <div>
              <SectionLabel>{t("overlay.baseline")}</SectionLabel>
              <div className="flex flex-wrap gap-1.5" data-testid="overlay-baseline">
                {doc.effective.baselineSkills.map((name) => (
                  <span
                    key={name}
                    className="rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {name}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="min-w-0 text-[11px]">
            {applied && (
              <span data-testid="overlay-note" className="text-primary">
                {t("overlay.appliedNote")}
              </span>
            )}
            {applyError && (
              <span data-testid="overlay-error" className="text-destructive">
                {applyError}
              </span>
            )}
            {!applied && !applyError && <span className="text-muted-foreground">{t("overlay.deploymentNote")}</span>}
          </div>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying || !doc}
            data-testid="overlay-apply"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applying ? t("overlay.applying") : t("overlay.apply")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
