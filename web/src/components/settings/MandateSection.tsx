// 委托状设置面 (add-personal-mandate 6.1-6.3)。
//
// 与 DelegationSection 同一片设置区、同一套 token 与 copy 纪律（中文优先、
// 五语言键 parity 由 check:locales 守）。差别是这里编的是「授权」而不是
// 「谁裁决」：每域一个决策模式、额度、有效期、撤销窗口，外加两个独立范围。
//
// 两条不可绕过的约束在 UI 上如实呈现，不做成可选：
//   · 未配置的域只有 advise（不预勾选、不预填额度）；
//   · read_scope 与 disclose_scope 分开勾选——能读不等于能说。
// 写走 PUT /api/fleets/delegation-policy 的 mandate 分支：服务端拒绝未知域名，
// 也拒绝任何把对外发布降级为自动执行的配置，所以这里不提供那些选项。

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

type Mode = "advise" | "draft" | "act-notify" | "act-silent";
type Level = "public" | "internal" | "confidential" | "hr" | "finance";

type DomainBlock = {
  mode: Mode;
  limits: { amount: number | null; count: number | null };
  expiresAt: number | null;
  revokeWindowMinutes: number | null;
  readScope: Level[];
  discloseScope: Level[];
};

type Mandate = { version: number; domains: Record<string, DomainBlock> };

type LedgerRow = {
  proposal_id: string;
  action_id: string;
  mandate_domain: string | null;
  mandate_mode: string | null;
  disclose_level: string | null;
  reversible_until: number | null;
  revoked_at: string | null;
  created_at: string;
};

const DOMAINS = ["ops", "external-comms", "advancement", "research"] as const;
const MODES: Mode[] = ["advise", "draft", "act-notify", "act-silent"];
const LEVELS: Level[] = ["public", "internal", "confidential", "hr", "finance"];

const EMPTY: DomainBlock = {
  mode: "advise",
  limits: { amount: null, count: null },
  expiresAt: null,
  revokeWindowMinutes: null,
  readScope: [],
  discloseScope: [],
};

const MODE_KEY: Record<Mode, string> = {
  advise: "modeAdvise",
  draft: "modeDraft",
  "act-notify": "modeNotify",
  "act-silent": "modeSilent",
};

function dayToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T23:59:59`);
  return Number.isFinite(ms) ? ms : null;
}

function epochToDay(value: number | null): string {
  if (!value) return "";
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function MandateSection() {
  const { t } = useTranslation();
  const [mandate, setMandate] = useState<Mandate | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [policyRes, ledgerRes] = await Promise.all([
        fetch("/api/fleets/delegation-policy"),
        fetch("/api/actions/mandate/ledger?limit=20"),
      ]);
      const policyBody = await policyRes.json().catch(() => ({}));
      if (!policyRes.ok) throw new Error(policyBody.error ?? `read ${policyRes.status}`);
      setMandate(policyBody.mandate ?? { version: 2, domains: {} });

      const ledgerBody = await ledgerRes.json().catch(() => ({}));
      setLedger(Array.isArray(ledgerBody.rows) ? ledgerBody.rows : []);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const blockFor = (domain: string): DomainBlock => ({
    ...EMPTY,
    ...(mandate?.domains?.[domain] ?? {}),
    limits: { ...EMPTY.limits, ...(mandate?.domains?.[domain]?.limits ?? {}) },
  });

  const patchDomain = (domain: string, part: Partial<DomainBlock>) => {
    if (!mandate) return;
    setMandate({
      ...mandate,
      domains: { ...mandate.domains, [domain]: { ...blockFor(domain), ...part } },
    });
  };

  const toggleLevel = (domain: string, field: "readScope" | "discloseScope", level: Level) => {
    const current = blockFor(domain)[field];
    const next = current.includes(level) ? current.filter((l) => l !== level) : [...current, level];
    patchDomain(domain, { [field]: next } as Partial<DomainBlock>);
  };

  const save = async () => {
    if (!mandate) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/fleets/delegation-policy", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope: "cell", mandate }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `write ${r.status}`);
      setMandate(body.mandate ?? mandate);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (proposalId: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/actions/${proposalId}/revoke`, { method: "POST" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error ?? `revoke ${r.status}`);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  if (error && !mandate) {
    return <p className="text-sm text-destructive" data-testid="mandate-error">{error}</p>;
  }
  if (!mandate) return <p className="text-sm text-muted-foreground" data-testid="mandate-loading">…</p>;

  const configured = DOMAINS.filter((d) => Boolean(mandate.domains[d]));

  return (
    <div className="flex flex-col gap-6" data-testid="mandate-section">
      <p className="text-sm text-muted-foreground">{t("settings.mandate.hint")}</p>
      {error ? <p className="text-sm text-destructive" data-testid="mandate-write-error">{error}</p> : null}

      <div className="flex flex-col gap-4">
        {DOMAINS.map((domain) => {
          const block = blockFor(domain);
          const isConfigured = configured.includes(domain);
          return (
            <section
              key={domain}
              className="rounded-lg border border-border bg-card p-4"
              data-testid={`mandate-domain-${domain}`}
              data-configured={isConfigured || undefined}
            >
              <header className="mb-3 flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{t(`settings.mandate.domain.${domain}`)}</h3>
                {!isConfigured ? (
                  <span className="text-xs text-muted-foreground">{t("settings.mandate.modeAdvise")}</span>
                ) : null}
              </header>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.mandate.mode")}</span>
                  <Select
                    data-testid={`mandate-mode-${domain}`}
                    value={block.mode}
                    onChange={(e) => patchDomain(domain, { mode: e.target.value as Mode })}
                  >
                    {MODES.map((mode) => (
                      <option key={mode} value={mode}>{t(`settings.mandate.${MODE_KEY[mode]}`)}</option>
                    ))}
                  </Select>
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.mandate.quota")}</span>
                  <input
                    type="number"
                    min={0}
                    data-testid={`mandate-quota-${domain}`}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={block.limits.count ?? ""}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      patchDomain(domain, {
                        limits: { ...block.limits, count: raw === "" ? null : Math.max(0, Number(raw) || 0) },
                      });
                    }}
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.mandate.expiry")}</span>
                  <input
                    type="date"
                    data-testid={`mandate-expiry-${domain}`}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={epochToDay(block.expiresAt)}
                    onChange={(e) => patchDomain(domain, { expiresAt: dayToEpoch(e.target.value) })}
                  />
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">{t("settings.mandate.revokeWindow")}</span>
                  <input
                    type="number"
                    min={0}
                    data-testid={`mandate-revoke-${domain}`}
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                    value={block.revokeWindowMinutes ?? ""}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.target.value.trim();
                      patchDomain(domain, {
                        revokeWindowMinutes: raw === "" ? null : Math.max(0, Number(raw) || 0),
                      });
                    }}
                  />
                </label>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {(["readScope", "discloseScope"] as const).map((field) => (
                  <fieldset key={field} className="flex flex-wrap items-center gap-2">
                    <legend className="mb-1 text-xs text-muted-foreground">
                      {t(`settings.mandate.${field}`)}
                    </legend>
                    {LEVELS.map((level) => {
                      const on = block[field].includes(level);
                      return (
                        <button
                          key={level}
                          type="button"
                          aria-pressed={on}
                          data-testid={`mandate-${field}-${domain}-${level}`}
                          onClick={() => toggleLevel(domain, field, level)}
                          className={
                            on
                              ? "rounded-full border border-primary bg-primary px-2.5 py-1 text-xs text-primary-foreground"
                              : "rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
                          }
                        >
                          {t(`settings.mandate.level.${level}`)}
                        </button>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{t("settings.mandate.scopeHint")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("settings.mandate.noDowngrade")}</p>
            </section>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" data-testid="mandate-save" disabled={busy} onClick={() => void save()}>
          {t("settings.mandate.save")}
        </Button>
        {saved ? (
          <span className="text-sm text-muted-foreground" data-testid="mandate-saved">
            {t("settings.mandate.saved")}
          </span>
        ) : null}
      </div>

      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("settings.mandate.ledger")}</h3>
        {ledger.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="mandate-ledger-empty">
            {t("settings.mandate.ledgerEmpty")}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {ledger.map((row) => {
              const reversible = row.reversible_until !== null && row.reversible_until > Date.now();
              const revoked = Boolean(row.revoked_at);
              return (
                <li
                  key={row.proposal_id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                  data-testid={`mandate-ledger-row-${row.proposal_id}`}
                >
                  <span className="font-mono text-xs text-muted-foreground">{row.action_id}</span>
                  <span className="text-xs">{row.mandate_domain ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">{row.mandate_mode ?? "—"}</span>
                  <span className="text-xs text-muted-foreground">
                    {revoked
                      ? t("settings.mandate.ledgerRevoked")
                      : reversible
                        ? `${t("settings.mandate.ledgerReversible")} ${new Date(row.reversible_until as number).toLocaleTimeString()}`
                        : t("settings.mandate.ledgerIrreversible")}
                  </span>
                  {reversible && !revoked ? (
                    <Button
                      type="button"
                      variant="secondary"
                      data-testid={`mandate-revoke-action-${row.proposal_id}`}
                      onClick={() => void revoke(row.proposal_id)}
                    >
                      {t("settings.mandate.revoke")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
