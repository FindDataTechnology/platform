// PackDetailDialog — inspect a pack in full before subscribing: every skill's
// complete body, MCP references (with required groups), agent personas, and
// author identity (spec: pack-marketplace). Subscribe is one action that
// records the subscription on the market and materializes the snapshot in
// this cell; the cell fetches the manifest server-side from the pack id +
// version (pack-install-server-side-manifest).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { PackDetail, PackDeployment, PackReport } from "@/lib/packs-api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";
import { RhythmEditor, rhythmEntryValid } from "./RhythmEditor";
import type { RhythmEntry } from "./RhythmEditor";

interface Props {
  packId: string | null;
  onOpenChange: (open: boolean) => void;
  onSubscribed: (report: PackReport, name: string) => void;
  onGotoMine?: () => void;
}

// The 万星 console deep link (agent-service-config): the deployment's slug and
// the console origin. The slug rule mirrors the serving side's slugFor
// (fd-wanxing wanxing-facade core.js) — a minimal copy, keep the two in
// lockstep (the same discipline the console's setPaused copy follows).
const wanxingConsoleBase = () => import.meta.env.VITE_WANXING_CONSOLE_URL || "https://wanxing.finddatatech.cloud";
const wanxingSlugFor = (agentPath: string) =>
  String(agentPath).replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-").toLowerCase();

export function PackDetailDialog({ packId, onOpenChange, onSubscribed, onGotoMine }: Props) {
  const { t } = useTranslation();
  const [pack, setPack] = useState<PackDetail | null>(null);
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deployments, setDeployments] = useState<PackDeployment[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [deployNote, setDeployNote] = useState<string | null>(null);
  // Deployer rhythm overrides (add-agent-residency D7): agentId → entries.
  const [overrides, setOverrides] = useState<Record<string, RhythmEntry[]>>({});
  const [pauseBusy, setPauseBusy] = useState<string | null>(null);
  // Billing readout (add-agent-platform-ops D3; revised by
  // revise-billing-key-acquisition): linked + accountState drives the deploy
  // surface — "none" shows the SSO connect guidance, "ok" shows the balance
  // and the per-agent key paste inputs; unlinked shows no readout, no gate.
  const [billing, setBilling] = useState<api.MyBillingState | null>(null);
  // Serving agentId → whether a key is already bound (booleans only).
  const [bindings, setBindings] = useState<Record<string, boolean> | null>(null);
  // Paste inputs, serving agentId → drafted key (never echoed back).
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    setPack(null);
    setError(null);
    setDeployments([]);
    setDeployNote(null);
    setBindings(null);
    setKeyDrafts({});
    if (!packId) return;
    api
      .getPack(packId)
      .then(setPack)
      .catch((err) => setError((err as Error).message));
    api
      .getPackDeployments(packId)
      .then((d) => setDeployments(d.deployments ?? []))
      .catch(() => setDeployments([])); // deployments route absent = nothing deployed
    api
      .myBillingState()
      .then(setBilling)
      .catch(() => setBilling(null));
    api
      .getBillingBindings(packId)
      .then(setBindings)
      .catch(() => setBindings(null)); // bindings route absent = pre-revise gateway
  }, [packId]);

  const subscribe = async () => {
    if (!packId || !pack) return;
    setSubscribing(true);
    setError(null);
    try {
      const sub = await api.subscribePack(packId);
      // Only the reference crosses the wire: the cell fetches the manifest
      // server-side (pack-install-server-side-manifest).
      const { report } = await api.installPack(sub.packId, sub.version);
      onSubscribed(report, pack.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubscribing(false);
    }
  };

  const servingAgents = (pack?.manifest?.agents ?? []).filter((a) => a.serving);

  const deploy = async () => {
    if (!packId || !pack) return;
    setDeploying(true);
    setError(null);
    setDeployNote(null);
    try {
      // Only VALID filled override entries ride the deploy request; untouched
      // agents (and the empty map) mean "manifest default".
      const rhythms: Record<string, RhythmEntry[]> = {};
      for (const [agentId, entries] of Object.entries(overrides)) {
        const valid = (entries ?? []).filter(rhythmEntryValid);
        if (valid.length > 0) rhythms[agentId] = valid;
      }
      // Pasted keys (revise-billing-key-acquisition): non-empty drafts only —
      // omitted agents keep their existing binding (absent=keep).
      const billingKeys: Record<string, string> = {};
      for (const a of servingAgents) {
        const draft = (keyDrafts[a.id] ?? "").trim();
        if (draft) billingKeys[a.id] = draft;
      }
      const out = await api.deployPack(
        packId,
        pack.version,
        Object.keys(rhythms).length > 0 ? rhythms : undefined,
        Object.keys(billingKeys).length > 0 ? billingKeys : undefined,
      );
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
      setKeyDrafts({});
      api.getBillingBindings(packId).then(setBindings).catch(() => {});
      setDeployNote(t("packs.detail.deployEffective", { minutes: Math.ceil(out.effectiveWithinSecs / 60) }));
    } catch (err) {
      const e = err as Error & { body?: { code?: string; reason?: string } };
      const code = e.body?.code;
      if (code === "BILLING_KEY_INVALID") {
        setError(t(`packs.detail.keyInvalid.${e.body?.reason ?? "liveness"}`, { defaultValue: e.message }));
      } else if (code === "BILLING_KEY_REQUIRED") {
        setError(t("packs.detail.keyRequired", { defaultValue: e.message }));
      } else {
        setError(e.message);
      }
      // A 402 no-account answer may race the open-time readout: refresh.
      if (code === "NO_SUB2API_ACCOUNT" || code === "INSUFFICIENT_BALANCE") {
        api.myBillingState().then(setBilling).catch(() => {});
      }
    } finally {
      setDeploying(false);
    }
  };

  const togglePause = async (agentId: string, paused: boolean) => {
    if (!packId) return;
    setPauseBusy(agentId);
    setError(null);
    try {
      await api.pauseDeployment(packId, agentId, paused);
      const d = await api.getPackDeployments(packId);
      setDeployments(d.deployments ?? []);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPauseBusy(null);
    }
  };

  const m = pack?.manifest;

  return (
    <Dialog open={!!packId} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-auto" data-testid="pack-detail">
        <DialogHeader>
          <DialogTitle>
            {pack?.name ?? (error ? t("packs.detail.notFound") : "")}
            {pack?.visibility === "private" && (
              <span data-testid="pack-private-badge" className="ml-2 rounded-sm border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 align-middle">
                {t("packs.detail.private")}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {pack ? `${pack.authorEmail} · v${pack.version}` : ""}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">{error}</div>
        )}

        {pack && m && (
          <div className="space-y-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <p className="text-muted-foreground">{pack.description}</p>
              {/* Raw download surface (add-facet-platform 4.4): the anonymous
                  skill-md route and the version manifest stay linkable from
                  the SPA — editors and scripts consume exactly these. */}
              <a
                href={`/api/packs/${pack.id}/versions/${pack.version}`}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-xs text-primary hover:underline"
                data-testid="pack-manifest-link"
              >
                {t("packs.detail.manifestJson")}
              </a>
            </div>
            {!!pack.tags?.length && (
              <div className="flex gap-1.5 flex-wrap">
                {pack.tags.map((tag) => (
                  <Badge key={tag}>{tag}</Badge>
                ))}
              </div>
            )}

            {(m.skills?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.skills")}</h4>
                <div className="space-y-2">
                  {m.skills!.map((s) => (
                    <div key={s.name} className="border border-border rounded-md p-3" data-testid={`pack-skill-${s.name}`}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-xs text-foreground">{s.name}</div>
                        <a
                          href={`/api/packs/${pack.id}/versions/${pack.version}/skills/${encodeURIComponent(s.name)}.md`}
                          download
                          className="shrink-0 text-xs text-primary hover:underline"
                          data-testid={`pack-skill-download-${s.name}`}
                        >
                          {t("packs.detail.downloadSkill")}
                        </a>
                      </div>
                      <div className="text-xs text-muted-foreground mb-1">{s.description}</div>
                      <pre className="text-xs whitespace-pre-wrap bg-muted/50 rounded p-2 max-h-48 overflow-auto">
                        {s.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {(m.mcpServers?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.mcp")}</h4>
                <ul className="space-y-1">
                  {m.mcpServers!.map((r) => (
                    <li key={r.registryName} className="flex items-center gap-2">
                      <span className="font-mono text-xs">{r.registryName}</span>
                      {r.requiredGroup && <Badge>{t("packs.detail.requiresGroup", { group: r.requiredGroup })}</Badge>}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {(m.agents?.length ?? 0) > 0 && (
              <section>
                <h4 className="font-medium mb-2">{t("packs.detail.agents")}</h4>
                <div className="space-y-2">
                  {m.agents!.map((a) => (
                    <div key={a.id} className="border border-border rounded-md p-3">
                      <div className="flex items-center gap-2">
                        <div className="text-foreground">{a.name}</div>
                        {a.serving && (
                          <span
                            data-testid={`pack-agent-serving-${a.id}`}
                            className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
                          >
                            A2A
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">{a.id}</div>
                      {!!a.serving?.rhythm?.length && (
                        <div className="flex flex-wrap gap-1 mt-1" data-testid={`pack-agent-rhythm-default-${a.id}`}>
                          {a.serving.rhythm.map((r, j) => (
                            /* biome-ignore lint/suspicious/noArrayIndexKey: read-only chips from an immutable manifest snapshot — never reordered */
                            <span key={j} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                              {r.daily ?? r.every}
                              {r.do ? ` · ${r.do.slice(0, 18)}${r.do.length > 18 ? "…" : ""}` : ""}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="text-xs whitespace-pre-wrap mt-1">{a.persona}</p>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {servingAgents.length > 0 && (
              <section className="border border-border rounded-md p-3" data-testid="pack-deploy-section">
                <h4 className="font-medium mb-2">{t("packs.detail.deployTitle")}</h4>
                {billing?.linked && billing.accountState === "none" && (
                  <div className="text-xs mb-2 rounded-md px-2 py-2 bg-amber-500/10 text-amber-700" data-testid="pack-billing-no-account">
                    <p>{t("packs.detail.noAccountHintNew")}</p>
                    <p className="mt-1 text-muted-foreground">{t("packs.detail.noAccountHintExisting")}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 px-2 text-xs"
                      onClick={() => billing.panelUrl && window.open(billing.panelUrl, "_blank", "noopener")}
                      data-testid="pack-billing-connect"
                    >
                      {t("packs.detail.connectPanel")}
                    </Button>
                  </div>
                )}
                {billing?.linked && billing.accountState === "ok" && (
                  <div
                    data-testid="pack-billing-readout"
                    className={`text-xs mb-2 rounded-md px-2 py-1 ${billing.balance != null && billing.balance <= 1 ? "bg-amber-500/10 text-amber-700" : "text-muted-foreground"}`}
                  >
                    {billing.balance != null
                      ? t("packs.detail.balance", { balance: billing.balance.toFixed(2) })
                      : t("packs.detail.balanceUnknown")}
                    {billing.balance != null && billing.balance <= 1 && (
                      <span className="block">{t("packs.detail.balanceLow")}</span>
                    )}
                  </div>
                )}
                {billing?.linked && billing.accountState === "ok" && (
                  <div className="mb-2 space-y-2">
                    {servingAgents.map((a) => (
                      <div key={a.id} data-testid={`pack-billing-key-${a.id}`}>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">
                            {t("packs.detail.keyPasteLabel", { id: a.id })}
                          </p>
                          {bindings?.[a.id] && (
                            <span
                              className="rounded-md border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary"
                              data-testid={`pack-billing-bound-${a.id}`}
                            >
                              {t("packs.detail.keyBoundBadge")}
                            </span>
                          )}
                        </div>
                        <input
                          type="text"
                          className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                          placeholder={t("packs.detail.keyPastePlaceholder")}
                          value={keyDrafts[a.id] ?? ""}
                          onChange={(e) => setKeyDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                          autoComplete="off"
                          spellCheck={false}
                          data-testid={`pack-billing-key-input-${a.id}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {servingAgents.map((a) => (
                  <div key={a.id} className="mb-2" data-testid={`pack-deploy-override-${a.id}`}>
                    <p className="text-xs text-muted-foreground">{t("packs.detail.rhythmOverride", { id: a.id })}</p>
                    <RhythmEditor
                      value={overrides[a.id] ?? []}
                      onChange={(entries) => setOverrides((o) => ({ ...o, [a.id]: entries }))}
                      testIdPrefix={`pack-deploy-override-editor-${a.id}`}
                    />
                  </div>
                ))}
                {deployments.length > 0 && (
                  <ul className="space-y-1 mb-2">
                    {deployments.map((d) => (
                      <li key={d.agentId} className="flex items-center gap-2 text-xs" data-testid="pack-deployment-row">
                        <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono">{d.agentId}</span>
                        <span className="text-muted-foreground">v{d.version}</span>
                        <span className={d.paused ? "text-amber-600" : "text-primary"} data-testid={`pack-deployment-state-${d.agentId}`}>
                          {d.paused ? t("packs.detail.paused") : t("packs.detail.deployOnline")}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto h-6 px-2 text-xs"
                          disabled={pauseBusy === d.agentId}
                          onClick={() => void togglePause(d.agentId, !d.paused)}
                          data-testid={`pack-deployment-pause-${d.agentId}`}
                        >
                          {d.paused ? t("packs.detail.resumeBtn") : t("packs.detail.pauseBtn")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          onClick={() =>
                            window.open(`${wanxingConsoleBase()}/#/console/${wanxingSlugFor(d.agentPath)}`, "_blank", "noopener")
                          }
                          data-testid={`pack-deployment-config-${d.agentId}`}
                        >
                          {t("packs.detail.gotoConfig")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
                {deployNote && <p className="text-xs text-primary mb-2">{deployNote}</p>}
                <Button
                  variant="outline"
                  onClick={() => void deploy()}
                  disabled={deploying}
                  data-testid="pack-deploy-btn"
                >
                  {deploying ? t("common.loading") : t("packs.detail.deployBtn")}
                </Button>
              </section>
            )}

            <div className="flex items-center gap-2 pt-2">
              <Button onClick={() => void subscribe()} disabled={subscribing} data-testid="pack-subscribe">
                {subscribing ? t("common.loading") : t("packs.detail.subscribe")}
              </Button>
              {onGotoMine && (
                <Button variant="ghost" onClick={onGotoMine}>
                  {t("packs.detail.gotoMine")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
