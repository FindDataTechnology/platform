// TeamsManagementView — the fleet management face (agent-teams-management).
//
// One table, all fleets: inline quick-edit of the three everyday fields
// (name / defaultModel / state — D4: orchestration and effort/contextBudget
// stay in the cockpit where they have diff confirmation and blast-radius
// prompts), checkbox batch actions with per-item receipts, and a per-row
// cockpit entry. Writes reuse the existing single-fleet PATCH and the batch
// endpoint; rows refresh from the server response, never optimistic writes
// on derived values.

import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ManageFleet {
  id: string;
  name: string;
  state: string;
  memberCount?: number;
  defaultModel?: string | null;
  openDecisions?: number;
  statusCounts?: Record<string, number>;
}

interface BatchResult {
  results: { id: string; ok: boolean; error?: string; state?: string }[];
  summary: { ok: number; failed: number };
}

export function TeamsManagementView({
  fleets,
  modelRoster,
  onPatch,
  onBatch,
  onOpenCockpit,
  onCreate,
}: {
  fleets: ManageFleet[];
  modelRoster: { id: string }[];
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<{ ok: boolean; error?: string; fleet?: ManageFleet }>;
  onBatch: (action: string, ids: string[]) => Promise<{ ok: boolean; body?: BatchResult; error?: string }>;
  onOpenCockpit: (fleetId: string) => void;
  onCreate: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pendingArchive, setPendingArchive] = useState<(() => void) | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [batchBusy, setBatchBusy] = useState(false);
  const [receipt, setReceipt] = useState<BatchResult | null>(null);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedIds = useMemo(() => [...selected], [selected]);

  const runBatch = async (action: string) => {
    if (selectedIds.length === 0 || batchBusy) return;
    if (action === "archive") {
      // Archive freezes cadences — themed confirmation, then re-enter.
      setPendingArchive(() => () => void runBatch(action));
      setArchiveOpen(true);
      return;
    }
    setBatchBusy(true);
    setReceipt(null);
    try {
      const r = await onBatch(action, selectedIds);
      if (r.ok && r.body) {
        setReceipt(r.body);
        setSelected(new Set());
      } else {
        setRowErrors((prev) => ({ ...prev, __batch: r.error ?? String(r) }));
      }
    } finally {
      setBatchBusy(false);
    }
  };

  const saveName = async (fleet: ManageFleet) => {
    const name = editName.trim();
    setEditingId(null);
    if (!name || name === fleet.name) return;
    const r = await onPatch(fleet.id, { name });
    if (!r.ok) setRowErrors((prev) => ({ ...prev, [fleet.id]: r.error ?? "" }));
    else setRowErrors((prev) => ({ ...prev, [fleet.id]: "" }));
  };

  const patchModel = async (fleet: ManageFleet, defaultModel: string) => {
    const r = await onPatch(fleet.id, { defaultModel: defaultModel || null });
    if (!r.ok) setRowErrors((prev) => ({ ...prev, [fleet.id]: r.error ?? "" }));
    else setRowErrors((prev) => ({ ...prev, [fleet.id]: "" }));
  };

  const patchState = async (fleet: ManageFleet, state: string) => {
    const r = await onPatch(fleet.id, { state });
    if (!r.ok) setRowErrors((prev) => ({ ...prev, [fleet.id]: r.error ?? "" }));
    else setRowErrors((prev) => ({ ...prev, [fleet.id]: "" }));
  };

  if (fleets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16" data-testid="teams-manage-empty">
        <p className="text-sm text-muted-foreground">{t("fleets.empty")}</p>
        <Button size="sm" onClick={onCreate} data-testid="teams-manage-empty-create">
          {t("fleets.create")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="teams-manage">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={selectedIds.length === 0 || batchBusy}
          onClick={() => void runBatch("pause")}
          data-testid="teams-batch-pause"
        >
          {t("agentTeams.manage.batchPause")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedIds.length === 0 || batchBusy}
          onClick={() => void runBatch("resume")}
          data-testid="teams-batch-resume"
        >
          {t("agentTeams.manage.batchResume")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={selectedIds.length === 0 || batchBusy}
          onClick={() => void runBatch("archive")}
          data-testid="teams-batch-archive"
        >
          {t("agentTeams.manage.batchArchive")}
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="teams-batch-count">
          {t("agentTeams.manage.selected", { count: selectedIds.length })}
        </span>
      </div>

      {receipt ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            receipt.summary.failed > 0 ? "border-warning/50 bg-warning/10" : "border-border bg-muted/30"
          }`}
          data-testid="teams-batch-receipt"
        >
          <div className="font-medium">
            {t("agentTeams.manage.receipt", { ok: receipt.summary.ok, failed: receipt.summary.failed })}
          </div>
          {receipt.summary.failed > 0 ? (
            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {receipt.results
                .filter((r) => !r.ok)
                .map((r) => {
                  const name = fleets.find((f) => f.id === r.id)?.name ?? r.id;
                  return (
                    <li key={r.id} data-testid="teams-batch-receipt-failure">
                      • {name}: {r.error}
                    </li>
                  );
                })}
            </ul>
          ) : null}
        </div>
      ) : null}
      {rowErrors["__batch"] ? (
        <p className="text-sm text-destructive" data-testid="teams-batch-error">
          {rowErrors["__batch"]}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm" data-testid="teams-manage-table">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="w-8 px-3 py-2" />
              <th className="px-3 py-2">{t("agentTeams.manage.colName")}</th>
              <th className="px-3 py-2">{t("agentTeams.manage.colState")}</th>
              <th className="px-3 py-2">{t("agentTeams.manage.colModel")}</th>
              <th className="px-3 py-2">{t("agentTeams.manage.colMembers")}</th>
              <th className="px-3 py-2">{t("agentTeams.manage.colDecisions")}</th>
              <th className="px-3 py-2">{t("agentTeams.manage.colActions")}</th>
            </tr>
          </thead>
          <tbody>
            {fleets.map((f) => (
              <tr key={f.id} className="border-b border-border/60 last:border-b-0" data-testid={`teams-row-${f.id}`}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(f.id)}
                    onChange={() => toggle(f.id)}
                    aria-label={t("agentTeams.manage.selectRow", { name: f.name })}
                    data-testid={`teams-row-check-${f.id}`}
                  />
                </td>
                <td className="px-3 py-2">
                  {editingId === f.id ? (
                    <Input
                      className="h-7 w-44"
                      value={editName}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onBlur={() => void saveName(f)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveName(f);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      data-testid={`teams-row-name-input-${f.id}`}
                    />
                  ) : (
                    <button
                      type="button"
                      className="truncate text-left font-medium hover:underline"
                      onClick={() => {
                        setEditingId(f.id);
                        setEditName(f.name);
                      }}
                      title={t("agentTeams.manage.editName")}
                      data-testid={`teams-row-name-${f.id}`}
                    >
                      {f.name}
                    </button>
                  )}
                  {rowErrors[f.id] ? (
                    <p className="mt-0.5 text-xs text-destructive" data-testid={`teams-row-error-${f.id}`}>
                      {rowErrors[f.id]}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <span className="mr-2 rounded-full bg-muted px-2 py-0.5 text-xs" data-testid={`teams-row-state-${f.id}`}>
                    {f.state}
                  </span>
                  {f.state === "active" ? (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void patchState(f, "paused")}>
                      {t("fleets.ops.pause")}
                    </Button>
                  ) : f.state === "paused" ? (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => void patchState(f, "active")}>
                      {t("fleets.ops.resume")}
                    </Button>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <select
                    className="h-7 rounded-md border border-border bg-background px-1 text-xs"
                    value={f.defaultModel ?? ""}
                    onChange={(e) => void patchModel(f, e.target.value)}
                    data-testid={`teams-row-model-${f.id}`}
                  >
                    <option value="">{t("agentTeams.manage.modelInherit")}</option>
                    {(modelRoster ?? []).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.id}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2 text-muted-foreground">{f.memberCount ?? 0}</td>
                <td className="px-3 py-2 text-muted-foreground" data-testid={`teams-row-decisions-${f.id}`}>
                  {f.openDecisions}
                </td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => onOpenCockpit(f.id)}
                    data-testid={`teams-row-cockpit-${f.id}`}
                  >
                    {t("agentTeams.manage.openCockpit")}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t("agentTeams.manage.scopeNote")}</p>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={t("agentTeams.manage.batchArchive")}
        description={t("agentTeams.manage.confirmArchive")}
        confirmLabel={t("agentTeams.manage.batchArchive")}
        cancelLabel={t("common.cancel")}
        variant="danger"
        onConfirm={() => {
          const run = pendingArchive;
          setPendingArchive(null);
          run?.();
        }}
      />
    </div>
  );
}
