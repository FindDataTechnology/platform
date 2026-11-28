// AgentRosterView — the role (persona) management section on /agents?tab=mine
// (add-agent-roster-management).
//
// WHY this exists: the role layer was the only one of the four agent objects
// without a management door. A role could only be reached through the chat
// picker's per-row ⚙, and the ONE way to express "I don't want this one" was
// uninstalling its whole pack. This section gives one row per role with its
// source and usage, and a REVERSIBLE hide that is a view preference, not a
// deletion.
//
// Three facts it must not bend:
//   * the row set comes from GET /api/catalog — the SAME projection the picker
//     reads, so the two can never drift (design D5);
//   * usage is per-requester and honest: a failed read renders as 未知, never
//     as 0 (design D7);
//   * every action rides an EXISTING write path (hide → /api/agent/hidden,
//     adjust → OverlayPanel, copy → POST /api/agent/presets), and every result
//     is reported per-row — no silent no-ops.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { EyeOff, RotateCcw, SlidersHorizontal, Copy, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/states-kit";
import { OverlayPanel } from "@/components/OverlayPanel";
import { createCustomPreset } from "@/lib/presets-api";
import * as rosterApi from "@/lib/roster-api";
import type { AgentUsageDoc, HiddenDoc } from "@/lib/roster-api";
import {
  addHidden,
  canAdjust,
  canCopy,
  canHide,
  removeHidden,
  toRow,
  usageFor,
  type CatalogAgentLike,
  type RosterRow,
} from "@/lib/roster-view";
import { cn } from "@/lib/utils";

// The role's persona body, from the source that actually owns it. The catalog
// is redacted; the pack manifest (via /api/mypacks) and the custom-preset row
// (via /api/agent/presets) are the two real sources. Returns null when neither
// owns this id — the copy action is then not offered.
async function resolvePersona(row: RosterRow): Promise<string | null> {
  if (row.source === "custom") {
    const { presets } = await import("@/lib/presets-api").then((m) => m.fetchCustomPresets());
    return presets.find((p) => p.id === row.id)?.persona ?? null;
  }
  if (row.source === "pack") {
    const { listInstalledPacks } = await import("@/lib/packs-api");
    const { packs } = await listInstalledPacks();
    for (const p of packs) {
      const agent = (p.manifest.agents ?? []).find((a) => a.id === row.id);
      if (agent?.persona) return agent.persona;
    }
  }
  return null;
}

export function AgentRosterView() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RosterRow[] | null>(null);
  const [hidden, setHidden] = useState<HiddenDoc>({ hidden: [], entries: [] });
  // Three states, not two: null = not loaded, "error" = the read failed. The
  // usage columns must distinguish "unavailable" from "zero" (design D7).
  const [usage, setUsage] = useState<AgentUsageDoc | null>(null);
  const [usageFailed, setUsageFailed] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowNote, setRowNote] = useState<Record<string, string>>({});
  const [adjustRole, setAdjustRole] = useState<{ id: string; name: string; packName?: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [cat, h] = await Promise.all([
        fetch("/api/catalog").then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status))))),
        rosterApi.fetchHidden(),
      ]);
      const agents: CatalogAgentLike[] = (cat?.agents ?? []).filter(
        (a: CatalogAgentLike) => a.type !== "app",
      );
      setRows(agents.map(toRow));
      setHidden(h);
    } catch (err) {
      setLoadError((err as Error).message);
      setRows([]);
    }
  }, []);

  const loadUsage = useCallback(async () => {
    try {
      setUsage(await rosterApi.fetchAgentUsage(7));
      setUsageFailed(false);
    } catch {
      setUsage(null);
      setUsageFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadUsage();
  }, [load, loadUsage]);

  const hideOne = async (id: string) => {
    setBusy(id);
    setRowError((p) => ({ ...p, [id]: "" }));
    try {
      const doc = await rosterApi.saveHidden(addHidden(hidden.hidden, id));
      setHidden(doc);
      setRows((p) => (p ? p.filter((r) => r.id !== id) : p));
    } catch (err) {
      setRowError((p) => ({ ...p, [id]: t("agents.roster.hideFailed", { error: (err as Error).message }) }));
    } finally {
      setBusy(null);
    }
  };

  const unhideOne = async (id: string) => {
    setBusy(id);
    setRowError((p) => ({ ...p, [id]: "" }));
    try {
      const doc = await rosterApi.saveHidden(removeHidden(hidden.hidden, id));
      setHidden(doc);
      await load(); // the row must come back with its real source/resources
      void loadUsage();
    } catch (err) {
      setRowError((p) => ({ ...p, [id]: t("agents.roster.unhideFailed", { error: (err as Error).message }) }));
    } finally {
      setBusy(null);
    }
  };

  const cloneOne = async (row: RosterRow) => {
    setBusy(row.id);
    setRowError((p) => ({ ...p, [row.id]: "" }));
    setRowNote((p) => ({ ...p, [row.id]: "" }));
    try {
      // /api/catalog is deliberately redacted (no persona body — agent-catalog
      // "Secret redaction"), so the persona comes from the SOURCE the role is
      // actually made of: the installed pack's manifest, or the custom preset
      // row. A role with neither (local / catalog-sourced remote) has no
      // persona this cell owns, and its copy action is not offered.
      const persona = await resolvePersona(row);
      if (persona == null) throw new Error(t("agents.roster.cloneNoSource"));
      const created = await createCustomPreset({ name: row.name, persona });
      setRowNote((p) => ({ ...p, [row.id]: t("agents.roster.cloneDone", { name: created.preset.name }) }));
    } catch (err) {
      setRowError((p) => ({ ...p, [row.id]: t("agents.roster.cloneFailed", { error: (err as Error).message }) }));
    } finally {
      setBusy(null);
    }
  };

  const sourceLabel = (s: RosterRow["source"]) =>
    t(
      s === "pack"
        ? "agents.roster.srcPack"
        : s === "custom"
          ? "agents.roster.srcCustom"
          : s === "local"
            ? "agents.roster.srcLocal"
            : "agents.roster.srcCatalog",
    );

  const resourceLabel = (row: RosterRow) => {
    if (row.skillCount == null && row.mcpCount == null) return t("agents.roster.resNone");
    const parts: string[] = [];
    if (row.skillCount != null) parts.push(t("agents.roster.resSkills", { n: row.skillCount }));
    if (row.mcpCount != null) parts.push(t("agents.roster.resMcp", { n: row.mcpCount }));
    return parts.join(" · ");
  };

  // usageFor is the single place the three states are decided (D7): a failed
  // read is 未知, a read-with-no-row is 未用过, and "not read yet" is neither.
  const turnsLabel = (id: string) => {
    const u = usageFor(id, usage, usageFailed);
    if (u.state === "loading") return "…";
    if (u.state === "unknown") return t("agents.roster.unknown");
    if (u.state === "zero") return t("agents.roster.neverUsed");
    return String(u.turns);
  };

  const lastUsedLabel = (id: string) => {
    const u = usageFor(id, usage, usageFailed);
    if (u.state === "loading") return "…";
    if (u.state === "unknown") return t("agents.roster.unknown");
    if (u.state === "zero") return t("agents.roster.neverUsed");
    return new Date(u.lastUsedAt).toLocaleString();
  };

  if (rows == null) {
    return <div className="space-y-2" data-testid="agent-roster-loading" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-12 animate-pulse rounded-md border border-border bg-muted/40" />
      ))}
    </div>;
  }

  return (
    <div className="space-y-3" data-testid="agent-roster">
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-muted-foreground">{t("agents.roster.title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("agents.roster.subtitle")}</p>
        </div>
      </div>

      {loadError ? (
        <p className="text-sm text-destructive" data-testid="agent-roster-error">
          {t("agents.roster.loadFailed", { error: loadError })}
        </p>
      ) : null}

      {usageFailed ? (
        <p className="text-xs text-warning" data-testid="agent-roster-usage-unavailable">
          {t("agents.roster.usageFailed")}
        </p>
      ) : null}

      {rows.length === 0 && !loadError ? (
        <EmptyState title={t("agents.roster.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm" data-testid="agent-roster-table">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2">{t("agents.roster.colName")}</th>
                <th className="px-3 py-2">{t("agents.roster.colSource")}</th>
                <th className="px-3 py-2">{t("agents.roster.colResources")}</th>
                <th className="px-3 py-2">{t("agents.roster.colTurns")}</th>
                <th className="px-3 py-2">{t("agents.roster.colLastUsed")}</th>
                <th className="px-3 py-2">{t("agents.roster.colActions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0" data-testid={`agent-roster-row-${row.id}`}>
                  <td className="px-3 py-2">
                    <span className="font-medium text-foreground">{row.name}</span>
                    {row.name !== row.id && (
                      <span className="ml-2 font-mono text-[11px] text-muted-foreground">{row.id}</span>
                    )}
                    {rowError[row.id] ? (
                      <div className="mt-1 text-xs text-destructive" data-testid={`agent-roster-row-error-${row.id}`}>
                        {rowError[row.id]}
                      </div>
                    ) : null}
                    {rowNote[row.id] ? (
                      <div className="mt-1 text-xs text-primary" data-testid={`agent-roster-row-note-${row.id}`}>
                        {rowNote[row.id]}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">
                    {row.packName ? `${sourceLabel(row.source)} · ${row.packName}` : sourceLabel(row.source)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{resourceLabel(row)}</td>
                  <td className="px-3 py-2 text-xs" data-testid={`agent-roster-turns-${row.id}`}>
                    {turnsLabel(row.id)}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{lastUsedLabel(row.id)}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {canHide(row) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === row.id}
                          onClick={() => void hideOne(row.id)}
                          data-testid={`agent-roster-hide-${row.id}`}
                        >
                          <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t("agents.roster.hide")}
                        </Button>
                      ) : (
                        // The built-in agent renders the action disabled WITH its
                        // reason, rather than hiding it — an absent control reads
                        // as "the feature is missing", a disabled one reads as
                        // "not for this row".
                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          title={t("agents.roster.localNoHide")}
                          data-testid={`agent-roster-hide-${row.id}`}
                        >
                          <EyeOff className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t("agents.roster.hide")}
                        </Button>
                      )}
                      {canAdjust(row) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setAdjustRole({ id: row.id, name: row.name, packName: row.packName ?? undefined })}
                          data-testid={`agent-roster-adjust-${row.id}`}
                        >
                          <SlidersHorizontal className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t("agents.roster.adjust")}
                        </Button>
                      ) : null}
                      {canCopy(row) ? (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy === row.id}
                          onClick={() => void cloneOne(row)}
                          data-testid={`agent-roster-clone-${row.id}`}
                        >
                          <Copy className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                          {t("agents.roster.clone")}
                        </Button>
                      ) : null}
                      <Link
                        to="/tuning"
                        className={cn(
                          "inline-flex h-8 items-center rounded-md border border-input bg-background px-2 text-xs hover:bg-accent",
                        )}
                        data-testid={`agent-roster-revisions-${row.id}`}
                      >
                        <History className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                        {t("agents.roster.revisions")}
                      </Link>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hidden.entries.length > 0 ? (
        <div className="rounded-md border border-border p-3" data-testid="agent-roster-hidden">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-sm font-medium">
              {t("agents.roster.hiddenSection", { n: hidden.entries.length })}
            </div>
            <p className="text-xs text-muted-foreground">{t("agents.roster.hiddenHint")}</p>
          </div>
          <ul className="mt-2 space-y-1">
            {hidden.entries.map((h) => (
              <li key={h.id} className="flex items-center gap-2 text-xs" data-testid={`agent-roster-hidden-row-${h.id}`}>
                <span className="font-medium text-foreground">{h.name ?? h.id}</span>
                {h.known ? null : (
                  <span className="rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                    {t("agents.roster.hiddenDeparted")}
                  </span>
                )}
                <Button
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  disabled={busy === h.id}
                  onClick={() => void unhideOne(h.id)}
                  data-testid={`agent-roster-unhide-${h.id}`}
                >
                  <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />
                  {t("agents.roster.unhide")}
                </Button>
                {rowError[h.id] ? <span className="text-destructive">{rowError[h.id]}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <OverlayPanel role={adjustRole} open={adjustRole !== null} onOpenChange={(o) => (!o ? setAdjustRole(null) : null)} />
    </div>
  );
}