// TeamAccountsCard — 智语的「团队号」管理面 (add-zhiyu-team-account 5.1).
//
// A team account is a TEAM's outward address: one number that can hang behind
// several doors (website embed today; IM groups and meetings later) without
// re-minting a token per room. This card is the owner's only surface for it:
// create for a fleet they own, mint the embed door, revoke the whole account.
//
// Every list is server-owned (re-fetch after each write), matching the rest of
// the zhiyu pages. Secrets are shown exactly once at mint time and never again —
// the API stores only a hash, so "copy it now" is the honest instruction.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states-kit";
import { StatusPill } from "@/components/ui/status-pill";

interface Door {
  id: string;
  fingerprint: string;
  kind: string;
  allowlist: string[];
  revoked: boolean;
  createdAt: number;
}

interface Account {
  id: string;
  fleetId: string;
  fleetName: string;
  revoked: boolean;
  idleMinutes: number | null;
  replyCap: number | null;
  createdAt: number;
  doors: Door[];
}

interface FleetOption {
  id: string;
  name: string;
}

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
  return data as T;
}

export function TeamAccountsCard() {
  const { t } = useTranslation();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [fleets, setFleets] = useState<FleetOption[]>([]);
  const [fleetId, setFleetId] = useState("");
  const [domain, setDomain] = useState("");
  const [issued, setIssued] = useState<{ accountId: string; snippet: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const out = await jcall<{ accounts: Account[] }>("GET", "/api/zhiyu/team-accounts");
      setAccounts(out.accounts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  // The fleet roster comes from the owner's own cell — the same overview the
  // team console reads. A failure here is not fatal: creation simply has no
  // options, and the server refuses an unverifiable fleet id anyway.
  const loadFleets = useCallback(async () => {
    try {
      const out = await jcall<{ fleets: FleetOption[] }>("GET", "/api/fleets/overview");
      setFleets((out.fleets ?? []).map((f) => ({ id: f.id, name: f.name })));
    } catch {
      setFleets([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    void loadFleets();
  }, [refresh, loadFleets]);

  const create = async () => {
    if (!fleetId) return;
    setBusy(true);
    setNote(null);
    try {
      await jcall("POST", "/api/zhiyu/team-accounts", { fleetId });
      setFleetId("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const mintDoor = async (account: Account) => {
    const allowlist = domain.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!allowlist.length) {
      setError(t("zhiyu.teamAccounts.allowlistRequired"));
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const out = await jcall<{ snippet: string }>("POST", `/api/zhiyu/team-accounts/${account.id}/widget`, { allowlist });
      setIssued({ accountId: account.id, snippet: out.snippet });
      setDomain("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (account: Account) => {
    setBusy(true);
    try {
      await jcall("POST", `/api/zhiyu/team-accounts/${account.id}/revoke`);
      setNote(t("zhiyu.teamAccounts.revokedNote"));
      setIssued(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="zhiyu-team-accounts" title={t("zhiyu.teamAccounts.title")}>
      <p className="mb-3 text-xs text-muted-foreground">{t("zhiyu.teamAccounts.hint")}</p>

      {error && <p className="mb-3 text-xs text-destructive">{error}</p>}
      {note && <p className="mb-3 text-xs text-muted-foreground">{note}</p>}

      {accounts.length === 0 ? (
        <EmptyState className="border-0 bg-transparent p-0" title={t("zhiyu.teamAccounts.empty")} />
      ) : (
        <ul className="mb-4 divide-y divide-border">
          {accounts.map((a) => {
            const live = a.doors.filter((d) => !d.revoked);
            return (
              <li key={a.id} className="space-y-2 py-3" data-testid="zhiyu-team-account-row">
                <div className="flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{a.fleetName || a.fleetId}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{a.id}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <StatusPill
                      status={a.revoked ? "neutral" : "running"}
                      label={a.revoked ? t("zhiyu.teamAccounts.revoked") : t("zhiyu.teamAccounts.live")}
                    />
                    {!a.revoked && (
                      <Button size="sm" variant="outline" disabled={busy} onClick={() => void revoke(a)}>
                        {t("zhiyu.teamAccounts.revoke")}
                      </Button>
                    )}
                  </span>
                </div>

                {!a.revoked && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">
                      {live.length > 0
                        ? t("zhiyu.teamAccounts.doorLive", { fp: live[0]?.fingerprint ?? "", domains: (live[0]?.allowlist ?? []).join(", ") })
                        : t("zhiyu.teamAccounts.noDoor")}
                    </p>
                    <div className="space-y-1.5">
                      <Label htmlFor={`acc-domain-${a.id}`}>{t("zhiyu.teamAccounts.allowlistLabel")}</Label>
                      <Input
                        id={`acc-domain-${a.id}`}
                        value={domain}
                        onChange={(e) => setDomain(e.target.value)}
                        placeholder={t("zhiyu.teamAccounts.allowlistPlaceholder")}
                      />
                    </div>
                    <Button size="sm" disabled={busy} onClick={() => void mintDoor(a)} data-testid="zhiyu-team-account-mint">
                      {t("zhiyu.teamAccounts.mintDoor")}
                    </Button>
                    {issued?.accountId === a.id && (
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">{t("zhiyu.teamAccounts.snippetOnce")}</p>
                        <pre className="overflow-x-auto rounded-md bg-muted p-2 text-[11px]">{issued.snippet}</pre>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {fleets.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <Label htmlFor="acc-fleet">{t("zhiyu.teamAccounts.fleetLabel")}</Label>
          <select
            id="acc-fleet"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={fleetId}
            onChange={(e) => setFleetId(e.target.value)}
          >
            <option value="">{t("zhiyu.teamAccounts.fleetPlaceholder")}</option>
            {fleets.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={busy || !fleetId} onClick={() => void create()} data-testid="zhiyu-team-account-create">
            {t("zhiyu.teamAccounts.create")}
          </Button>
        </div>
      )}
    </Card>
  );
}
