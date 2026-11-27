// TeamApprovalsDialog.tsx — the cockpit's 「待批准调用」 queue (openspec:
// add-team-as-a2a-agent, 7.2).
//
// The queue's whole reason to exist is that a refusal told the caller to wait
// for a permission. If the owner cannot see and grant it here, that refusal was
// a dead end. So this surface is a working list, not a log: every pending row
// carries approve (one-off or time-boxed) and reject.
//
// Expiry is expressed as a duration, never a free-form date: "24 小时" is a
// decision an operator can make; an epoch-ms input is a bug waiting to happen.
// The server stores the instant; this UI only chooses it.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";

type Duration = "oneoff" | "24h" | "7d" | "30d";

interface PendingRow {
  caller: string;
  requestedAt: number;
}

interface ApprovedRow {
  subject: string;
  expiresAt: number | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handle: string | null;
  teamName: string;
}

const DURATIONS: { value: Duration; ms: number | null }[] = [
  { value: "oneoff", ms: null },
  { value: "24h", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
];

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export function TeamApprovalsDialog({ open, onOpenChange, handle, teamName }: Props) {
  const { t, i18n } = useTranslation();
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [approved, setApproved] = useState<ApprovedRow[]>([]);
  const [duration, setDuration] = useState<Duration>("oneoff");
  const [error, setError] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const base = handle ? `/api/teams/cards/${encodeURIComponent(handle)}/approvals` : null;

  const load = useCallback(async () => {
    if (!base) return;
    try {
      const out = await jcall<{ pending: PendingRow[]; approved: ApprovedRow[] }>("GET", base);
      setPending(out.pending);
      setApproved(out.approved);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [base]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const approve = async (caller: string) => {
    if (!base) return;
    setBusy(true);
    try {
      const ms = DURATIONS.find((d) => d.value === duration)?.ms ?? null;
      await jcall("POST", base, { caller, expiresAt: ms === null ? null : Date.now() + ms });
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (caller: string) => {
    if (!base) return;
    setBusy(true);
    try {
      await jcall("DELETE", `${base}/${encodeURIComponent(caller)}`);
      setRejectFor(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const fmt = (at: number | null) =>
    at === null ? t("teamApprovals.standing") : new Date(at).toLocaleString(i18n.language);

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto" data-testid="team-approvals-dialog">
          <DialogHeader>
            <DialogTitle>{t("teamApprovals.title", { name: teamName })}</DialogTitle>
            <DialogDescription>{t("teamApprovals.subtitle")}</DialogDescription>
          </DialogHeader>

          {error && (
            <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-sm text-status-failed">{error}</p>
          )}

          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("teamApprovals.grantFor")}</span>
              <Select
                value={duration}
                onChange={(e) => setDuration(e.target.value as Duration)}
                data-testid="approvals-duration"
                className="h-8 w-48"
              >
                {DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {t(`teamApprovals.duration.${d.value}`)}
                  </option>
                ))}
              </Select>
            </div>

            <div data-testid="approvals-pending">
              <div className="mb-1.5 text-xs font-medium text-foreground">{t("teamApprovals.pending")}</div>
              {pending.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
                  {t("teamApprovals.empty")}
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {pending.map((row) => (
                    <li key={row.caller} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground">{row.caller}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {t("teamApprovals.requestedAt", { at: new Date(row.requestedAt).toLocaleString(i18n.language) })}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-2">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => void approve(row.caller)}
                          data-testid={`approvals-approve-${row.caller}`}
                        >
                          {t("teamApprovals.approve")}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => setRejectFor(row.caller)}
                          data-testid={`approvals-reject-${row.caller}`}
                        >
                          {t("teamApprovals.reject")}
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div data-testid="approvals-approved">
              <div className="mb-1.5 text-xs font-medium text-foreground">{t("teamApprovals.approvedTitle")}</div>
              {approved.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("teamApprovals.approvedEmpty")}</p>
              ) : (
                <ul className="space-y-1">
                  {approved.map((row) => (
                    <li key={row.subject} className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate text-foreground">{row.subject}</span>
                      <span className="shrink-0 font-mono text-muted-foreground">{fmt(row.expiresAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rejectFor !== null}
        onOpenChange={(o) => !o && setRejectFor(null)}
        variant="danger"
        title={t("teamApprovals.rejectTitle")}
        description={t("teamApprovals.rejectDescription", { caller: rejectFor ?? "" })}
        confirmLabel={t("teamApprovals.reject")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => rejectFor && void reject(rejectFor)}
        closeOnConfirm={false}
      />
    </>
  );
}
