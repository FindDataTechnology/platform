// ── ActionCard (add-line-boards-and-action-gate task 7; add-wire-line-board 3.3)
//
// Renders a gated action proposal as a confirmation card. Two hosts:
//   - the chat ToolBlock (`block`): the propose_action tool result
//   - a line board (`proposal`): an inline button's proposal
//
// Pending face: impact + risk tier + the action's user-filled fields (design
// D5 — the model's values for these were discarded server-side, the user types
// them here; confirm stays disabled until every required one is filled) +
// confirm / cancel. The card owns the approve/reject round-trip and renders
// the outcome itself: executed with the result summary, or failed with the
// upstream's field errors verbatim and, on a dead credential, a re-authorize
// pointer. The server does not broadcast approve/reject, so there is no other
// source of truth to wait for.

import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { AlertTriangle, CheckCircle, XCircle, Clock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export interface UserFilledArg {
  key: string;
  label: string;
  kind: "url[]" | "text" | "boolean";
  required?: boolean;
}

export interface ActionProposal {
  proposalId: string;
  // `failed` = execution failed (inspectable, re-proposable); `rejected` = the
  // human said no. Mirrors server/routes/actions.js.
  state: "pending" | "approved" | "executed" | "rejected" | "failed" | "expired";
  impact: string;
  risk: string;
  target: string;
  tier: string;
  userFilledArgs?: UserFilledArg[];
  resultSummary?: string | null;
}

interface FieldError {
  field: string;
  message: string;
}

interface Props {
  block?: {
    name: string;
    args?: unknown;
    state: "done" | "running" | "error";
    result?: ActionProposal | unknown;
  };
  proposal?: ActionProposal;
  onResolved?: (outcome: { state: ActionProposal["state"]; resultSummary?: string | null }) => void;
}

function statusIcon(state: string) {
  switch (state) {
    case "pending":
      return <Clock className="h-4 w-4 text-muted-foreground" />;
    case "approved":
    case "executed":
      return <CheckCircle className="h-4 w-4 text-success" />;
    case "rejected":
      return <XCircle className="h-4 w-4 text-destructive" />;
    case "failed":
      return <AlertTriangle className="h-4 w-4 text-destructive" />;
    case "expired":
      return <AlertTriangle className="h-4 w-4 text-warning" />;
    default:
      return null;
  }
}

function riskBadge(risk: string) {
  const color =
    risk === "read"
      ? "bg-green-500/10 text-green-600 dark:text-green-400"
      : risk === "write"
        ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
        : risk === "destructive" || risk === "cost"
          ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
          : risk === "publish"
            ? "bg-purple-500/10 text-purple-600 dark:text-purple-400"
            : "bg-gray-500/10 text-gray-600 dark:text-gray-400";
  return <span className={cn("rounded px-2 py-0.5 text-xs font-medium", color)}>{risk}</span>;
}

// The tool result arrives as the JSON text the MCP child returned; the store
// may or may not have parsed it. Accept both.
function coerceProposal(result: unknown): ActionProposal | null {
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return coerceProposal(JSON.parse(result));
    } catch {
      return null;
    }
  }
  if (typeof result !== "object") return null;
  const r = result as Partial<ActionProposal>;
  if (typeof r.proposalId !== "string") return null;
  return {
    proposalId: r.proposalId,
    state: r.state ?? "pending",
    impact: r.impact ?? "",
    risk: r.risk ?? "read",
    target: r.target ?? "any",
    tier: r.tier ?? "auto",
    userFilledArgs: Array.isArray(r.userFilledArgs) ? r.userFilledArgs : [],
    resultSummary: r.resultSummary ?? null,
  };
}

type UserValue = string | boolean | string[];

function isFilled(field: UserFilledArg, v: UserValue | undefined): boolean {
  if (field.kind === "boolean") return v === true;
  if (field.kind === "url[]") return Array.isArray(v) && v.length > 0;
  return typeof v === "string" && v.trim().length > 0;
}

export const ActionCard = memo(function ActionCard({ block, proposal, onResolved }: Props) {
  const { t } = useTranslation();
  const initial = useMemo(() => proposal ?? coerceProposal(block?.result), [proposal, block?.result]);

  if (!initial) {
    // Running state — the proposal has not come back yet.
    return (
      <div data-testid="action-card-pending" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 animate-spin text-primary" />
          <span>{t("action.pending")}</span>
        </div>
      </div>
    );
  }
  return <ProposalCard key={initial.proposalId} proposal={initial} onResolved={onResolved} />;
});

function ProposalCard({ proposal, onResolved }: { proposal: ActionProposal; onResolved?: Props["onResolved"] }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<ActionProposal["state"]>(proposal.state ?? "pending");
  const [summary, setSummary] = useState<string | null>(proposal.resultSummary ?? null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldError[]>([]);
  const [connectPath, setConnectPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [values, setValues] = useState<Record<string, UserValue>>({});

  const schema = proposal.userFilledArgs ?? [];
  const ready = schema.every((f) => !f.required || isFilled(f, values[f.key]));
  const risk = proposal.risk ?? "read";
  const tier = proposal.tier ?? "auto";

  const finish = (next: ActionProposal["state"], resultSummary?: string | null) => {
    setState(next);
    onResolved?.({ state: next, resultSummary });
  };

  const approve = async () => {
    if (!ready || busy) return;
    setBusy("approve");
    setError(null);
    setFields([]);
    try {
      const userArgs: Record<string, UserValue> = {};
      for (const f of schema) {
        const v = values[f.key];
        if (v !== undefined) userArgs[f.key] = v;
      }
      const res = await fetch(`/api/actions/${encodeURIComponent(proposal.proposalId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userArgs }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok) {
        setSummary(json.resultSummary ?? null);
        finish(json.state === "approved" ? "approved" : "executed", json.resultSummary ?? null);
        return;
      }
      // 400 = our own validation (stay pending, show why); anything else = the
      // execution failed and the proposal is now 'failed' server-side.
      if (res.status === 400) {
        setError(json.details || json.error || t("action.failed"));
        return;
      }
      setError(json.message || json.error || t("action.failed"));
      if (Array.isArray(json.fields)) setFields(json.fields);
      if (json.credentialInvalidated && json.credentialRef) {
        setConnectPath(`/settings/connections?panel=${encodeURIComponent(connectPanelFor(json.credentialRef))}`);
      }
      finish("failed", json.message ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("action.failed"));
    } finally {
      setBusy(null);
    }
  };

  const reject = async () => {
    if (busy) return;
    setBusy("reject");
    try {
      const res = await fetch(`/api/actions/${encodeURIComponent(proposal.proposalId)}/reject`, { method: "POST" });
      if (res.ok) finish("rejected", null);
      else setError(t("action.failed"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("action.failed"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      data-testid={`action-card-${state}`}
      data-proposal-id={proposal.proposalId}
      className={cn(
        "rounded-md border border-l-2 bg-muted px-3 py-2 text-sm",
        state === "pending" && "border-l-primary",
        state === "approved" || state === "executed"
          ? "border-l-success"
          : state === "rejected" || state === "failed"
            ? "border-l-destructive"
            : state === "expired"
              ? "border-l-warning"
              : "border-l-muted",
      )}
    >
      <div className="flex items-start gap-2">
        <div className="mt-0.5">{statusIcon(state)}</div>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="font-semibold text-foreground">{t(`action.state.${state}`, { defaultValue: state })}</span>
            {riskBadge(risk)}
            <span className="text-xs text-muted-foreground">{proposal.target}</span>
          </div>
          <p className="text-xs text-foreground">{proposal.impact}</p>

          {state === "pending" && (
            <>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{t(`action.tierName.${tier}`, { defaultValue: tier })}</span>
                <span>•</span>
                <span>ID: {proposal.proposalId.slice(0, 8)}…</span>
              </div>

              {schema.length > 0 && (
                <fieldset data-testid="action-user-fill" className="mt-3 space-y-2 rounded border border-border bg-background p-2">
                  <legend className="px-1 text-xs font-medium text-foreground">{t("action.userFill.title")}</legend>
                  <p className="text-[11px] text-muted-foreground">{t("action.userFill.hint")}</p>
                  {schema.map((f) => (
                    <UserField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
                  ))}
                </fieldset>
              )}

              {error && (
                <p data-testid="action-card-error" className="mt-2 text-xs text-destructive">
                  {error}
                </p>
              )}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  data-testid="action-confirm"
                  onClick={approve}
                  disabled={!ready || busy !== null}
                  title={ready ? undefined : t("action.fillRequired")}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === "approve" && <Loader2 className="h-3 w-3 animate-spin" />}
                  {busy === "approve" ? t("action.confirming") : t("action.confirm")}
                </button>
                <button
                  type="button"
                  data-testid="action-cancel"
                  onClick={reject}
                  disabled={busy !== null}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
                >
                  {t("action.cancel")}
                </button>
                {!ready && schema.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">{t("action.fillRequired")}</span>
                )}
              </div>
            </>
          )}

          {state !== "pending" && (
            <div className="mt-2 space-y-1 text-xs">
              {summary && (state === "executed" || state === "approved") && (
                <p data-testid="action-card-summary" className="text-foreground">
                  {summary}
                </p>
              )}
              {error && (
                <p data-testid="action-card-error" className="text-destructive">
                  {error}
                </p>
              )}
              {fields.length > 0 && (
                <ul data-testid="action-card-fields" className="list-disc pl-4 text-destructive">
                  {fields.map((fe) => (
                    <li key={`${fe.field}:${fe.message}`}>
                      <span className="font-mono">{fe.field}</span>: {fe.message}
                    </li>
                  ))}
                </ul>
              )}
              {connectPath && (
                <button
                  type="button"
                  data-testid="action-card-reconnect"
                  onClick={() => navigate(connectPath)}
                  className="text-primary hover:underline"
                >
                  {t("action.reconnect")}
                </button>
              )}
              {!summary && !error && <span className="text-muted-foreground">{t("action.result")}</span>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UserField({ field, value, onChange }: { field: UserFilledArg; value: UserValue | undefined; onChange: (v: UserValue) => void }) {
  const { t } = useTranslation();
  const label = t(`action.field.${field.key}`, { defaultValue: field.label });
  const id = `uf-${field.key}`;
  if (field.kind === "boolean") {
    return (
      <label htmlFor={id} className="flex items-start gap-2 text-xs">
        <input
          id={id}
          type="checkbox"
          data-testid={`action-field-${field.key}`}
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          {label}
          {field.required && <span className="text-destructive"> *</span>}
        </span>
      </label>
    );
  }
  if (field.kind === "url[]") {
    const text = Array.isArray(value) ? value.join("\n") : "";
    return (
      <label htmlFor={id} className="block text-xs">
        <span>
          {label}
          {field.required && <span className="text-destructive"> *</span>}
        </span>
        <textarea
          id={id}
          data-testid={`action-field-${field.key}`}
          rows={2}
          value={text}
          placeholder="https://…（每行一个）"
          onChange={(e) => onChange(e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))}
          className="mt-1 w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs"
        />
      </label>
    );
  }
  return (
    <label htmlFor={id} className="block text-xs">
      <span>
        {label}
        {field.required && <span className="text-destructive"> *</span>}
      </span>
      <input
        id={id}
        type="text"
        data-testid={`action-field-${field.key}`}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-border bg-background px-2 py-1 text-xs"
      />
    </label>
  );
}

// Mirror of credential-refs.js KNOWN_CONNECT_PANELS for the refs a gated
// action can invalidate; unknown refs fall back to the registry panel like the
// server does.
function connectPanelFor(ref: string): string {
  const panels: Record<string, string> = {
    "wire-customer": "line-wire-customer",
    lex: "line-lex",
    "wanxing-caller": "ciyuan-account",
    "facet-market": "facet-market",
    "paper-trading": "paper-trading",
  };
  return panels[ref] ?? "registry";
}
