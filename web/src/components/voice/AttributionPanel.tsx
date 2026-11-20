// AttributionPanel.tsx — 「这段话是谁说的」for one capture
// (openspec: add-speaker-attribution, 7.1).
//
// Three rules shape this surface, and each one is a refusal:
//
//   1. `separation` has FOUR states and they are rendered differently. `partial`
//      must never look like `full`: a meeting where the lane stopped separating
//      halfway cannot be presented as a fully attributed one. This is the whole
//      reason the field is not a boolean.
//   2. A cluster with no member is shown as 未确定 and can only be NAMED by a
//      human here. The surface never offers a guess ("可能是 B"), because a guess
//      that looks like an answer gets clicked and then becomes a fact.
//   3. Pending confirmations live in the existing todo surface. This panel points
//      at it — a second inbox is a second place people forget to look.
//
// Rebinding is reversible and audited, so no destructive confirmation is needed;
// the trail underneath is what makes 「改绑不追溯」 checkable by the user.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatOffset } from "@platform/core";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  CaptureRequestError,
  bindCaptureCluster,
  fetchCaptureAttributions,
  listCaptures,
  unbindCaptureCluster,
  type CaptureAttribution,
  type CaptureAttributions,
} from "@/lib/capture-api";

/** The grouping bucket for rows nobody has claimed. */
const UNSET = "__unset__";

interface Props {
  captureId: string | null;
  /** Called after a bind/unbind so a parent can refresh whatever it shows. */
  onChanged?: () => void;
}

interface Group {
  key: string;
  member: string | null;
  cluster: string;
  rows: CaptureAttribution[];
  startMs: number;
  endMs: number;
}

/**
 * Fold the flat row list into one entry per (member, cluster).
 *
 * Grouping by cluster rather than by member keeps two people who share no
 * cluster apart, and keeps one person's several clusters visible — merging them
 * would claim a continuity the data does not have.
 */
export function groupAttributions(rows: CaptureAttribution[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const row of rows) {
    const member = row.member ?? null;
    const key = member === null ? `${UNSET}:${row.cluster}` : `${member}:${row.cluster}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.rows.push(row);
      existing.startMs = Math.min(existing.startMs, row.startMs);
      existing.endMs = Math.max(existing.endMs, row.endMs);
    } else {
      byKey.set(key, {
        key,
        member,
        cluster: row.cluster,
        rows: [row],
        startMs: row.startMs,
        endMs: row.endMs,
      });
    }
  }
  // Named groups first (a human decision outranks an open question), then by
  // time — a stable order the reader can learn.
  return [...byKey.values()].sort((a, b) => {
    if (Boolean(a.member) !== Boolean(b.member)) return a.member ? -1 : 1;
    return a.startMs - b.startMs || a.cluster.localeCompare(b.cluster);
  });
}

export function AttributionPanel({ captureId, onChanged }: Props) {
  const { t, i18n } = useTranslation();
  const [data, setData] = useState<CaptureAttributions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [showTrail, setShowTrail] = useState(false);
  const [memberDraft, setMemberDraft] = useState<Record<string, string>>({});
  const [candidates, setCandidates] = useState<string[]>([]);

  const load = useCallback(async () => {
    if (!captureId) {
      setData(null);
      return;
    }
    try {
      const out = await fetchCaptureAttributions(captureId);
      setData(out);
      setError(null);
      // Candidates are whoever already appears in this capture (a member bound
      // earlier, or the session identity) plus the owner. The server is the
      // authority on who is allowed — this list only saves typing.
      const known = new Set<string>();
      for (const row of out.attributions) if (row.member) known.add(row.member);
      for (const b of out.bindings) known.add(b.member);
      setCandidates([...known].sort());
    } catch (err) {
      setError((err as Error).message);
    }
  }, [captureId]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => (data ? groupAttributions(data.attributions) : []), [data]);

  const bind = async (cluster: string) => {
    if (!captureId) return;
    const member = (memberDraft[cluster] ?? candidates[0] ?? "").trim();
    if (!member) {
      setBindingError(t("speakerAttribution.errors.memberRequired"));
      return;
    }
    setBusy(true);
    setBindingError(null);
    try {
      await bindCaptureCluster(captureId, cluster, member);
      await load();
      onChanged?.();
    } catch (err) {
      // Refusals are rendered from their CODE, so 「不在场」 says something a
      // person can act on rather than echoing an English server message.
      const code = err instanceof CaptureRequestError ? err.code : "internal_error";
      setBindingError(t(`speakerAttribution.errors.${code}`, { defaultValue: t("speakerAttribution.errors.internal_error") }));
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (cluster: string) => {
    if (!captureId) return;
    setBusy(true);
    setBindingError(null);
    try {
      await unbindCaptureCluster(captureId, cluster);
      await load();
      onChanged?.();
    } catch (err) {
      const code = err instanceof CaptureRequestError ? err.code : "internal_error";
      setBindingError(t(`speakerAttribution.errors.${code}`, { defaultValue: t("speakerAttribution.errors.internal_error") }));
    } finally {
      setBusy(false);
    }
  };

  if (!captureId) return null;

  const separation = data?.summary.separation ?? "none";

  return (
    <div className="space-y-3" data-testid="attribution-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{t("speakerAttribution.title")}</div>
        {data && (
          <span className="text-[11px] text-muted-foreground" data-testid="attribution-summary">
            {t("speakerAttribution.summary", {
              total: data.summary.total,
              named: data.summary.session + data.summary.bound,
              pending: data.summary.needsConfirmation,
            })}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed">
          {t("speakerAttribution.errors.loadFailed")}
        </p>
      )}

      {/* The four separation states, each with its own words. `partial` in
          particular must not read as done. */}
      <p
        className={
          separation === "full" || separation === "not_needed"
            ? "rounded-md border border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground"
            : "rounded-md border border-status-waiting/40 bg-status-waiting/5 px-3 py-2 text-[11px] text-foreground"
        }
        data-testid="attribution-separation"
        data-separation={separation}
      >
        {t(`speakerAttribution.separation.${separation}`)}
      </p>

      {data && data.summary.conflicts > 0 && (
        <p
          className="rounded-md border border-status-waiting/40 bg-status-waiting/5 px-3 py-2 text-[11px] text-foreground"
          data-testid="attribution-conflict"
        >
          {t("speakerAttribution.conflictNotice", { n: data.summary.conflicts })}
        </p>
      )}

      {data && data.attributions.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          {t("speakerAttribution.empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {groups.map((group) => (
            <li
              key={group.key}
              className="rounded-md border border-border p-3"
              data-testid={`attribution-group-${group.member ?? "anonymous"}`}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-foreground">
                  {group.member ?? t("speakerAttribution.unset")}
                  <span className="ml-2 font-mono text-[11px] text-muted-foreground">{group.cluster}</span>
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {formatOffset(group.startMs)} – {formatOffset(group.endMs)} · {t("speakerAttribution.sliceCount", { n: group.rows.length })}
                </span>
              </div>

              <ul className="mt-1 space-y-0.5">
                {group.rows.map((row, i) => (
                  <li key={`${row.cluster}-${row.startMs}`} className="flex gap-2 text-[11px]" data-testid={`attribution-row-${i}`}>
                    <span className="shrink-0 tabular-nums text-muted-foreground">{formatOffset(row.startMs)}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.basis}</span>
                    {row.conflict && (
                      <span className="shrink-0 text-status-waiting">{t("speakerAttribution.overridden")}</span>
                    )}
                  </li>
                ))}
              </ul>

              {group.member === null ? (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {candidates.length > 0 ? (
                    <Select
                      value={memberDraft[group.cluster] ?? candidates[0]}
                      onChange={(e) => setMemberDraft((d) => ({ ...d, [group.cluster]: e.target.value }))}
                      className="h-8 w-56"
                      data-testid={`attribution-member-${group.cluster}`}
                    >
                      {candidates.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">{t("speakerAttribution.noCandidates")}</span>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy || candidates.length === 0}
                    onClick={() => void bind(group.cluster)}
                    data-testid={`attribution-name-${group.cluster}`}
                  >
                    {t("speakerAttribution.name")}
                  </Button>
                </div>
              ) : (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    disabled={busy}
                    onClick={() => void unbind(group.cluster)}
                    data-testid={`attribution-unbind-${group.cluster}`}
                  >
                    {t("speakerAttribution.unbind")}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {bindingError && (
        <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="attribution-error">
          {bindingError}
        </p>
      )}

      {data && data.summary.needsConfirmation > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="attribution-pending-hint">
          {t("speakerAttribution.pendingHint")}
        </p>
      )}

      {data && data.events.length > 0 && (
        <div>
          <button
            type="button"
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowTrail((v) => !v)}
            data-testid="attribution-events-toggle"
          >
            {t("speakerAttribution.trail", { n: data.events.length })}
          </button>
          {showTrail && (
            <ul className="mt-1 space-y-0.5" data-testid="attribution-events">
              {data.events.map((e) => (
                <li key={`${e.cluster}-${e.at}-${e.op}-${e.actor}`} className="text-[11px] text-muted-foreground">
                  {new Date(e.at).toLocaleString(i18n.language)} ·{" "}
                  {t(`speakerAttribution.op.${e.op}`)} · {e.from ?? "—"} → {e.to ?? "—"} · {e.actor}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The mountable section: pick which finished capture to inspect, then show its
 * attribution.
 *
 * A picker rather than "the current capture" because attribution is READ AFTER
 * the fact — the person reviewing a meeting is rarely the one still recording.
 * Only finished captures are offered: an unfinished one has no merged text, so
 * its attribution would be a promise about slices that do not exist yet.
 */
export function AttributionSection() {
  const { t } = useTranslation();
  const [captures, setCaptures] = useState<{ id: string; title: string; status: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await listCaptures();
      const finished = all.filter((c) => c.status === "finished");
      setCaptures(finished);
      setSelected((prev) => (prev && finished.some((c) => c.id === prev) ? prev : (finished[0]?.id ?? null)));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed">
        {t("speakerAttribution.errors.loadFailed")}
      </p>
    );
  }
  if (!captures.length) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground" data-testid="attribution-no-captures">
        {t("speakerAttribution.empty")}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {captures.length > 1 && (
        <Select
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value)}
          className="h-8 w-72"
          data-testid="attribution-capture-picker"
        >
          {captures.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || c.id}
            </option>
          ))}
        </Select>
      )}
      <AttributionPanel captureId={selected} onChanged={() => void load()} />
    </div>
  );
}
