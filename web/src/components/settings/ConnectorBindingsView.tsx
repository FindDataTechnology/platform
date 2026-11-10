// ConnectorBindingsView — the binding-first face of the connector card
// (add-connector-bindings 6.2).
//
// A pack declares what external systems it needs (`connectorBindings`); the
// connector account decides whether a provider can be reached at all. This view
// leads with the former, because "which of my installed packs still need
// something" is the question the user actually asks — the account list below it
// is how they answer.
//
// State vocabulary is the ledger's, rendered verbatim (connector-bindings spec):
//   satisfied     connected；令牌是否已授予另说（granted 决定按钮是「去授权」还是「撤销授权」）
//   missing       no connection for this provider yet — the user's todo
//   stale         the connection existed and stopped working — reconnect
//   unwired       the CATALOG does not cover the declared operations — a
//                 product capability gap, never degraded to `missing` here,
//                 because telling the user to connect something that cannot
//                 work is worse than saying nothing
//   unmapped      a ROLE binding whose system the user has not named yet — not
//                 a gap (the catalog may support many systems) and not a missing
//                 connection (nothing was chosen to connect to). The repair is a
//                 choice, so this row offers a picker instead of a link.
//   undetermined  the catalog could not be asked — not a gap, not a todo
// `deprecated` rows are absent from this view: they record a binding key the
// pack no longer declares, so they are history, not a requirement.
//
// Every row carries the one action that repairs or reverses it (spec: 每条提供
// 对应动作). `unwired` and `undetermined` carry none on purpose — no user
// gesture closes a catalog gap, and an outage is not a todo. Connect/reconnect
// need the console's address from the deployment baseline; without it they are
// hidden rather than rendered as dead links (the account area below still
// offers paste/zero-paste connect).
//
// Local fetch on purpose (same shape as ChatwootConnectPanel): the card is
// self-contained and reads the projection GET /api/connections already serves.
// Nothing here holds credential material — the projection carries states only.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useExtensionsStore } from "@/hooks/useExtensionsStore";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface BindingRow {
  packId: string;
  key: string;
  provider: string;
  operations: string[];
  status: "satisfied" | "missing" | "stale" | "unwired" | "unmapped" | "undetermined" | "deprecated";
  optional: boolean;
  // add-connector-role-mapping: a role binding names a need ("a WMS") and the
  // user names the system. `role` is the mapping key, `provider` the chosen
  // system — equal to `role` while nothing is chosen.
  role?: string | null;
  providerRole?: boolean;
  // Asked of the credential, not inferred: a satisfied binding without a live
  // token still has to be granted.
  granted?: boolean;
  grantedAt?: string | null;
}

export interface BindingSummary {
  packs: number;
  bindings: number;
  unresolved: number;
  unwired: number;
  // Counted apart from `unwired` for the same reason `unwired` is counted apart
  // from `unresolved`: the fix is a choice, not a connection and not a gap.
  unmapped?: number;
}

export interface RoleCandidate {
  provider: string;
  connectionName: string | null;
}

export interface RoleMapping {
  role: string;
  provider: string | null;
  updatedAt: string | null;
  candidates: RoleCandidate[];
  rejected: { provider: string; gaps: string[] }[];
  // `ok: false` means we could not ask — an empty candidate list would then
  // read as "your connections cover none of these", which is a different fact.
  candidatesState: { ok: boolean; code?: string };
}

const STATE_STYLE: Record<string, string> = {
  satisfied: "bg-success/15 text-success",
  missing: "bg-warning/15 text-warning",
  stale: "bg-destructive/15 text-destructive",
  unwired: "bg-muted text-muted-foreground",
  // Actionable by the user and not a defect: neither the warning colour of a
  // missing connection nor the muted grey of a catalog gap.
  unmapped: "bg-primary/15 text-primary",
  undetermined: "bg-muted text-muted-foreground",
};

async function sendJson(method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.code ?? payload?.error ?? `http_${response.status}`;
    throw new Error(String(code));
  }
  return payload;
}

const postJson = (path: string, body: unknown) => sendJson("POST", path, body);

/** The role → system choices this identity has made, keyed by role. */
async function fetchRoleMappings(): Promise<Record<string, RoleMapping> | null> {
  try {
    const response = await fetch("/api/connector/role-mappings");
    if (!response.ok) return null;
    const body = await response.json();
    const map: Record<string, RoleMapping> = {};
    for (const entry of body.mappings ?? []) map[entry.role] = entry;
    return map;
  } catch {
    /* unknown stays unknown */
    return null;
  }
}

// The "choose your system" control. A role binding cannot be repaired by
// connecting or granting — the missing fact is which system the customer runs —
// so its action is a picker, not a button that opens the console.
//
// Candidates are the user's own connections that cover what the pack declares
// (the API never offers a catalog browse: a system without an account cannot be
// reached, so listing 1570 of them would disguise a config step as a choice).
function RoleChooser({
  row,
  mapping,
  busy,
  onChoose,
}: {
  row: BindingRow;
  mapping: RoleMapping | null;
  busy: boolean;
  onChoose: (provider: string) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(row.provider && row.provider !== row.role ? row.provider : "");
  useEffect(() => {
    setValue(row.provider && row.provider !== row.role ? row.provider : "");
  }, [row.provider, row.role]);

  if (!mapping) {
    // The mapping read failed: say so instead of rendering an empty picker.
    return (
      <span data-testid="connector-binding-choose-unavailable" className="text-[11px] text-muted-foreground">
        {t("settings.connections.bindings.choose.unavailable")}
      </span>
    );
  }
  if (!mapping.candidatesState?.ok) {
    return (
      <span data-testid="connector-binding-choose-unavailable" className="text-[11px] text-muted-foreground">
        {t("settings.connections.bindings.choose.unavailable")}
      </span>
    );
  }
  if (mapping.candidates.length === 0) {
    // Two different facts hide behind "no candidates", and the fix differs:
    //   rejected empty  → nothing connected at all (or nothing covers it)
    //   rejected filled → they DO have systems, but those cannot serve this
    //                     binding; say which ones and what is missing, otherwise
    //                     the card reads as "connect something" when the real
    //                     answer is "the system you already connected lacks a
    //                     capability". The API computes this; the card owes the
    //                     user the reason.
    const rejected = mapping.rejected ?? [];
    return (
      <span data-testid="connector-binding-choose-empty" className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
        {rejected.length === 0
          ? t("settings.connections.bindings.choose.empty")
          : t("settings.connections.bindings.choose.emptyButRejected")}
        {rejected.map((entry) => (
          <span
            key={entry.provider}
            data-testid="connector-binding-choose-rejected"
            data-provider={entry.provider}
            data-gaps={entry.gaps.join(",")}
            className="rounded-sm border border-border px-1.5 py-0.5"
          >
            {entry.provider}
            {entry.gaps.length > 0
              ? ` · ${t("settings.connections.bindings.choose.gapsMissing", {
                  gaps: entry.gaps
                    .map((gap) => t(`settings.connections.bindings.operations.${gap}`, { defaultValue: gap }))
                    .join("/"),
                })}`
              : ""}
          </span>
        ))}
      </span>
    );
  }
  // A chosen system that is no longer offerable (catalog dropped it, or it
  // cannot cover the declared operations) stays visible as the current value —
  // silently hiding it would look like the choice was never made.
  const current = row.provider && row.provider !== row.role ? row.provider : null;
  const currentOffered = current !== null && mapping.candidates.some((candidate) => candidate.provider === current);
  return (
    <span className="flex items-center gap-1">
      <select
        data-testid="connector-binding-choose"
        data-role={row.role ?? ""}
        aria-label={t("settings.connections.bindings.action.chooseSystem")}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        value={value}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
      >
        {!value && <option value="">{t("settings.connections.bindings.choose.placeholder")}</option>}
        {current && !currentOffered && (
          <option value={current}>
            {current} · {t("settings.connections.bindings.choose.currentNotUsable")}
          </option>
        )}
        {mapping.candidates.map((candidate) => (
          <option key={candidate.provider} value={candidate.provider}>
            {candidate.connectionName ? `${candidate.provider} · ${candidate.connectionName}` : candidate.provider}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={busy || !value}
        data-testid="connector-binding-action"
        data-action="choose"
        onClick={() => onChoose(value)}
      >
        {current
          ? t("settings.connections.bindings.action.changeSystem")
          : t("settings.connections.bindings.action.chooseSystem")}
      </Button>
    </span>
  );
}

export function ConnectorBindingsView({ className = "" }: { className?: string }) {
  const { t } = useTranslation();
  const { connectorConnection } = useExtensionsStore();
  const [rows, setRows] = useState<BindingRow[] | null>(null);
  const [summary, setSummary] = useState<BindingSummary | null>(null);
  const [mappings, setMappings] = useState<Record<string, RoleMapping> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/connections");
      if (!r.ok) return null;
      const body = await r.json();
      const connector = (body.connections ?? []).find((c: { id: string }) => c.id === "connector");
      if (!connector || !Array.isArray(connector.bindings)) return null;
      const nextRows = connector.bindings as BindingRow[];
      // Only a set that actually declares a role needs the picker data; asking
      // every user for it would be one extra round trip that can only be empty.
      const nextMappings = nextRows.some((row) => row.role && row.status !== "deprecated")
        ? await fetchRoleMappings()
        : {};
      return {
        rows: nextRows,
        summary: (connector.bindingSummary ?? null) as BindingSummary | null,
        mappings: nextMappings,
      };
    } catch {
      /* unknown stays unknown — never render "nothing needed" on a failed read */
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const next = await load();
      if (!alive || !next) return;
      setRows(next.rows);
      setSummary(next.summary);
      setMappings(next.mappings);
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // The console's user shell (deployment baseline origin + /me). Absent when
  // the baseline has no connector row — then connect/reconnect links are hidden.
  const meUrl = connectorConnection?.connectorUrl
    ? `${connectorConnection.connectorUrl}${connectorConnection.mePath}`
    : null;

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      const next = await load();
      if (next) {
        setRows(next.rows);
        setSummary(next.summary);
        setMappings(next.mappings);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  // Choosing a system is a fact about the customer, not about one pack: the
  // server recomputes every pack that declares the role, and the reload below
  // shows all of them already moved.
  const chooseSystem = (row: BindingRow, provider: string) =>
    act(`${row.packId}:${row.key}`, () =>
      sendJson("PUT", `/api/connector/role-mappings/${encodeURIComponent(row.role ?? "")}`, { provider }),
    );

  // Unknown stays unknown — never render "nothing needed" on a failed read.
  if (!rows) return null;
  const visible = rows.filter((row) => row.status !== "deprecated");
  // No declared bindings is not "nothing to say" any more: the header still
  // carries the entrance to the app directory, which is where a user with no
  // pack-declared needs actually goes to connect something. The empty list
  // itself stays unrendered (an empty state here would read as an achievement).
  const hasRows = visible.length > 0;

  const byPack = new Map<string, BindingRow[]>();
  for (const row of visible) {
    const list = byPack.get(row.packId) ?? [];
    list.push(row);
    byPack.set(row.packId, list);
  }

  const actionFor = (row: BindingRow) => {
    const id = `${row.packId}:${row.key}`;
    if (row.status === "satisfied") {
      return row.granted ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={busy === id}
          data-testid="connector-binding-action"
          data-action="revoke"
          onClick={() =>
            act(id, () => postJson("/api/connector/bindings/revoke", { packId: row.packId, bindingKey: row.key }))
          }
        >
          {t("settings.connections.bindings.action.revoke")}
        </Button>
      ) : (
        <Button
          size="sm"
          disabled={busy === id}
          data-testid="connector-binding-action"
          data-action="grant"
          onClick={() =>
            act(id, () =>
              postJson("/api/connector/bindings/grant", { packId: row.packId, bindingKeys: [row.key] }),
            )
          }
        >
          {t("settings.connections.bindings.action.grant")}
        </Button>
      );
    }
    // A role binding's repair is a choice, not a connection: the user has to say
    // which system they run. That holds for `unmapped` (nothing chosen yet) and
    // for a chosen system that no longer works — `unwired` (catalog lost it or
    // under-covers the declared operations) and `missing`/`stale` (the connection
    // for it died). Without this the role card would send the user to the
    // console for a provider they never picked.
    if (row.role) {
      return (
        <RoleChooser
          row={row}
          mapping={mappings?.[row.role] ?? null}
          busy={busy === id}
          onChoose={(provider) => chooseSystem(row, provider)}
        />
      );
    }
    // A dead or absent connection is repaired inside the connector console.
    // There is no documented per-provider deep link, so the link opens the
    // console's own connections shell rather than inventing a query parameter.
    if ((row.status === "missing" || row.status === "stale") && meUrl) {
      return (
        <a
          href={meUrl}
          target="_blank"
          rel="noreferrer"
          data-testid="connector-binding-action"
          data-action={row.status === "stale" ? "reconnect" : "connect"}
          className="inline-flex h-8 items-center rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
        >
          {t(
            row.status === "stale"
              ? "settings.connections.bindings.action.reconnect"
              : "settings.connections.bindings.action.connect",
          )}
        </a>
      );
    }
    return null;
  };

  return (
    <div data-testid="connector-bindings-view" className={`flex flex-col gap-2 ${className}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="plug" size={14} className="text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">{t("settings.connections.bindings.title")}</span>
        {/* The directory itself lives in the connector console: one catalog, one
            place to keep it honest. This is the door, not a second wall. */}
        {meUrl && (
          <a
            href={`${meUrl}#catalog`}
            target="_blank"
            rel="noreferrer"
            data-testid="connector-browse-catalog"
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t("settings.connections.bindings.browseCatalog")}
          </a>
        )}
        {summary && (
          <span className="text-xs text-muted-foreground" data-testid="connector-bindings-summary">
            {t("settings.connections.bindings.summary", {
              packs: summary.packs,
              bindings: summary.bindings,
              unresolved: summary.unresolved,
              unwired: summary.unwired,
            })}
          </span>
        )}
        {/* Not folded into the summary string: "waiting for your choice" is a
            different sentence from "to resolve" and from "capability gaps", and
            a locale should be able to drop it without editing the others. */}
        {(summary?.unmapped ?? 0) > 0 && (
          <span
            className="rounded-sm bg-primary/15 px-1.5 py-0.5 text-xs text-primary"
            data-testid="connector-bindings-unmapped"
          >
            {t("settings.connections.bindings.summaryUnmapped", { count: summary?.unmapped })}
          </span>
        )}
      </div>

      {error && (
        <p className="px-1 text-xs text-destructive" data-testid="connector-bindings-error">
          {t("settings.connections.bindings.actionFailed", { error })}
        </p>
      )}

      {hasRows && (
      <ul className="flex flex-col gap-2">
        {[...byPack.entries()].map(([packId, packRows]) => (
          <li key={packId} data-testid="connector-binding-pack" data-pack={packId} className="flex flex-col gap-1">
            <p className="px-1 text-xs font-medium text-muted-foreground">{packId}</p>
            <ul className="flex flex-col gap-1">
              {packRows.map((row) => {
                const state = row.status;
                // A role row leads with the need ("wms") and follows with the
                // system the user named for it; while nothing is chosen the two
                // are the same string, so the system half is omitted.
                const named = row.provider && row.provider !== row.role ? row.provider : null;
                return (
                  <li
                    key={`${packId}:${row.key}`}
                    data-testid="connector-binding-row"
                    data-binding-key={row.key}
                    data-provider={row.provider}
                    data-role={row.role ?? ""}
                    data-state={state}
                    data-optional={row.optional ? "1" : "0"}
                    data-granted={row.granted ? "1" : "0"}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-1.5"
                  >
                    <span className="text-sm">{row.role ?? (row.provider || row.key)}</span>
                    {row.role && named && <span className="text-xs text-muted-foreground">→ {named}</span>}
                    {row.operations.length > 0 && (
                      <span className="flex gap-1">
                        {row.operations.map((op) => (
                          <span
                            key={op}
                            className="rounded-sm bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {t(`settings.connections.bindings.operations.${op}`, { defaultValue: op })}
                          </span>
                        ))}
                      </span>
                    )}
                    {row.optional && (
                      <span
                        data-testid="connector-binding-optional"
                        className="rounded-sm border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {t("settings.connections.bindings.optional")}
                      </span>
                    )}
                    {row.granted && row.grantedAt && (
                      <span data-testid="connector-binding-granted-at" className="text-[11px] text-muted-foreground">
                        {t("settings.connections.bindings.grantedAt", {
                          when: new Date(row.grantedAt).toLocaleString(),
                        })}
                      </span>
                    )}
                    <div className="flex-1" />
                    <span
                      data-testid="connector-binding-state"
                      data-state={state}
                      className={`rounded-full px-2 py-0.5 text-xs ${STATE_STYLE[state] ?? "bg-muted text-muted-foreground"}`}
                    >
                      {t(`settings.connections.bindings.state.${state}`, { defaultValue: state })}
                    </span>
                    {actionFor(row)}
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      )}

      {/* `unwired` and `undetermined` get one sentence each, and only when
          present: they are the two states a badge alone misreads. The first is
          a capability gap no account closes; the second is an outage, not an
          answer. */}
      {visible.some((row) => row.status === "unwired") && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="connector-bindings-unwired-hint">
          {t("settings.connections.bindings.hint.unwired")}
        </p>
      )}
      {visible.some((row) => row.status === "undetermined") && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="connector-bindings-undetermined-hint">
          {t("settings.connections.bindings.hint.undetermined")}
        </p>
      )}
      {/* Its own sentence for the same reason: nothing is missing from the
          catalog and nothing needs connecting — the user has to say which
          system they run before this binding can be authorized. */}
      {visible.some((row) => row.status === "unmapped") && (
        <p className="px-1 text-xs text-muted-foreground" data-testid="connector-bindings-unmapped-hint">
          {t("settings.connections.bindings.hint.unmapped")}
        </p>
      )}
    </div>
  );
}
