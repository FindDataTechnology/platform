// PresetPublishFlow — 壹座's "发布并部署" one-click flow (add-facet-platform
// S4.1; spec: pack-marketplace — Preset-to-service one-click flow). A single
// action on a custom preset runs the existing pieces in order:
//   1. compose  — the preset→draft bridge resolves migratability server-side;
//   2. confirm  — the composed draft is presented with name/description
//                 editable and the not-carried-over report shown once;
//   3. publish  — draft save → pack publish (new pack or new version);
//   4. deploy   — offered only when the published agent entry carries a
//                 serving contract; skipped for content-only packs.
// Any step's failure stops the flow with that step named, and no later step
// runs. The preset itself is never touched; a composed draft that stops at
// confirm/publish stays in the drafts list for the editor path.

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { CustomPreset } from "@/lib/presets-api";
import * as presetsApi from "@/lib/presets-api";
import * as packsApi from "@/lib/packs-api";
import type { MyBillingState, PackDraft, PackManifest, PackManifestAgent } from "@/lib/packs-api";
import type { BridgeReport } from "@/lib/pack-draft-bridge";
import { settingsPath } from "@/components/settings/sections";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "./Badge";

type FlowStep = "compose" | "publish" | "deploy";

export function PresetPublishFlow({
  preset,
  onOpenChange,
}: {
  preset: CustomPreset;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<PackDraft | null>(null);
  const [report, setReport] = useState<BridgeReport | null>(null);
  const [name, setName] = useState(preset.name);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState<FlowStep | null>("compose");
  const [failed, setFailed] = useState<{ step: FlowStep; message: string } | null>(null);
  const [published, setPublished] = useState<{ packId: string; version: number; manifest: PackManifest } | null>(null);
  const [billing, setBilling] = useState<MyBillingState | null>(null);
  const [bindings, setBindings] = useState<Record<string, boolean> | null>(null);
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const [deployNote, setDeployNote] = useState<string | null>(null);

  const compose = useCallback(async () => {
    setBusy("compose");
    setFailed(null);
    try {
      const r = await presetsApi.convertPresetToPackDraft(preset.id);
      const d = r.draft as unknown as PackDraft;
      setDraft(d);
      setReport(r.report);
      setName(d.name);
      setDescription(d.description ?? "");
    } catch (e) {
      const err = e as Error & { status?: number };
      setFailed({ step: "compose", message: err.status === 403 ? t("customPresets.bridgeDenied") : err.message });
    } finally {
      setBusy(null);
    }
  }, [preset.id, t]);

  // The flow starts on open — the click IS the first step.
  useEffect(() => {
    void compose();
  }, [compose]);

  const servingAgents: PackManifestAgent[] = (published?.manifest.agents ?? []).filter((a) => a.serving);

  // Billing state gates the deploy step's key inputs (same three-state readout
  // as the pack detail surface); absent routes degrade to no readout.
  useEffect(() => {
    if (!published) return;
    packsApi.myBillingState().then(setBilling).catch(() => setBilling(null));
    packsApi.getBillingBindings(published.packId).then(setBindings).catch(() => setBindings(null));
  }, [published]);

  const publish = async () => {
    if (!draft) return;
    setBusy("publish");
    setFailed(null);
    try {
      const { draft: updated } = await packsApi.updatePackDraft(draft.id, { name, description });
      const manifest: PackManifest = {
        name: updated.name,
        description: updated.description,
        visibility: "public",
        tags: updated.tags,
        skills: updated.entries.skills ?? [],
        mcpServers: updated.entries.mcpServers ?? [],
        agents: updated.entries.agents ?? [],
      };
      const r = await packsApi.publishPack({ packId: draft.publishedPackId, manifest });
      if (!draft.publishedPackId) await packsApi.markDraftPublished(draft.id, r.id);
      setDraft({ ...updated, publishedPackId: draft.publishedPackId ?? r.id });
      setPublished({ packId: r.id, version: r.version, manifest });
    } catch (e) {
      const err = e as Error & { status?: number };
      setFailed({ step: "publish", message: err.status === 403 ? t("presetPublish.publishDenied") : err.message });
    } finally {
      setBusy(null);
    }
  };

  const deploy = async () => {
    if (!published) return;
    setBusy("deploy");
    setFailed(null);
    setDeployNote(null);
    try {
      const keys: Record<string, string> = {};
      for (const a of servingAgents) {
        const v = (keyDrafts[a.id] ?? "").trim();
        if (v) keys[a.id] = v;
      }
      const out = await packsApi.deployPack(
        published.packId,
        published.version,
        undefined,
        Object.keys(keys).length > 0 ? keys : undefined,
      );
      setKeyDrafts({});
      setDeployNote(t("packs.detail.deployEffective", { minutes: Math.ceil(out.effectiveWithinSecs / 60) }));
    } catch (e) {
      const err = e as Error & { status?: number; body?: { code?: string; reason?: string } };
      const code = err.body?.code;
      let message = err.message;
      if (code === "BILLING_KEY_INVALID") message = t(`packs.detail.keyInvalid.${err.body?.reason ?? "liveness"}`, { defaultValue: err.message });
      else if (code === "BILLING_KEY_REQUIRED") message = t("packs.detail.keyRequired", { defaultValue: err.message });
      setFailed({ step: "deploy", message });
      if (code === "NO_SUB2API_ACCOUNT" || code === "INSUFFICIENT_BALANCE") {
        packsApi.myBillingState().then(setBilling).catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  };

  const gotoMarket = () => {
    onOpenChange(false);
    navigate(settingsPath("packs"));
  };

  const pendingSkills = report?.pendingSkills ?? [];
  const pendingServers = report?.pendingServers ?? [];

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onOpenChange(false)}>
      <DialogContent className="max-w-xl max-h-[85vh] overflow-auto" data-testid="preset-publish-flow">
        <DialogHeader>
          <DialogTitle>{t("presetPublish.title", { name: preset.name })}</DialogTitle>
          <DialogDescription>{published ? t("presetPublish.published", { version: published.version }) : t("presetPublish.confirmHint")}</DialogDescription>
        </DialogHeader>

        {busy === "compose" && (
          <p className="text-sm text-muted-foreground" data-testid="preset-publish-composing">
            {t("presetPublish.compose")}
          </p>
        )}

        {failed && (
          <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md text-sm" data-testid="preset-publish-error">
            {t("presetPublish.stepFailed", {
              step: t(`presetPublish.step.${failed.step}`),
              message: failed.message,
            })}
          </div>
        )}

        {!published && draft && (
          <div className="space-y-3 text-sm">
            <div className="grid gap-3">
              <div>
                <Label htmlFor="preset-publish-name">{t("presetPublish.name")}</Label>
                <Input
                  id="preset-publish-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="preset-publish-name"
                />
              </div>
              <div>
                <Label htmlFor="preset-publish-desc">{t("presetPublish.description")}</Label>
                <Textarea
                  id="preset-publish-desc"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                  data-testid="preset-publish-desc"
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground" data-testid="preset-publish-parts">
              {t("presetPublish.parts", {
                skills: draft.entries.skills?.length ?? 0,
                mcp: draft.entries.mcpServers?.length ?? 0,
                agents: draft.entries.agents?.length ?? 0,
              })}
            </p>
            {(pendingSkills.length > 0 || pendingServers.length > 0) && (
              <div className="border border-amber-500/40 bg-amber-500/5 rounded-md p-3 space-y-1" data-testid="preset-publish-report">
                <p className="text-xs font-medium text-foreground">{t("presetPublish.reportTitle")}</p>
                <ul className="text-xs text-muted-foreground list-disc pl-4">
                  {pendingSkills.map((s) => (
                    <li key={`sk-${s.name}`} data-testid={`preset-publish-pending-skill-${s.name}`}>
                      {s.name} — {s.pack ? t("packs.bridge.reason.pack", { pack: s.pack }) : t("packs.bridge.reason.unavailable")}
                    </li>
                  ))}
                  {pendingServers.map((s) => (
                    <li key={`mc-${s.name}`} data-testid={`preset-publish-pending-server-${s.name}`}>
                      {s.name} — {t(`packs.bridge.reason.${s.reason}`)}
                    </li>
                  ))}
                </ul>
                <p className="text-xs text-muted-foreground">{t("packs.bridge.replaceHint")}</p>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button onClick={() => void publish()} disabled={busy !== null || !name.trim()} data-testid="preset-publish-submit">
                {busy === "publish" ? t("common.loading") : t("presetPublish.publish")}
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy !== null}>
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}

        {published && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2" data-testid="preset-publish-done">
              <Badge>{t("presetPublish.publishedBadge")}</Badge>
              <span className="text-muted-foreground">{t("presetPublish.published", { version: published.version })}</span>
            </div>
            {servingAgents.length === 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="preset-publish-no-serving">
                {t("presetPublish.noServing")}
              </p>
            ) : (
              <section className="border border-border rounded-md p-3 space-y-2" data-testid="preset-publish-deploy">
                <h4 className="font-medium">{t("presetPublish.deployTitle")}</h4>
                <p className="text-xs text-muted-foreground">{t("presetPublish.deployHint")}</p>
                {billing?.linked && billing.accountState === "none" && (
                  <div className="text-xs rounded-md px-2 py-2 bg-amber-500/10 text-amber-700" data-testid="preset-publish-no-account">
                    <p>{t("packs.detail.noAccountHintNew")}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-7 px-2 text-xs"
                      onClick={() => billing.panelUrl && window.open(billing.panelUrl, "_blank", "noopener")}
                      data-testid="preset-publish-connect"
                    >
                      {t("packs.detail.connectPanel")}
                    </Button>
                  </div>
                )}
                {billing?.linked && billing.accountState === "ok" && (
                  <div className="space-y-2">
                    {billing.balance != null && (
                      <p className="text-xs text-muted-foreground" data-testid="preset-publish-balance">
                        {t("packs.detail.balance", { balance: billing.balance.toFixed(2) })}
                      </p>
                    )}
                    {servingAgents.map((a) => (
                      <div key={a.id} data-testid={`preset-publish-key-${a.id}`}>
                        <div className="flex items-center gap-2">
                          <p className="text-xs text-muted-foreground">{t("packs.detail.keyPasteLabel", { id: a.id })}</p>
                          {bindings?.[a.id] && <Badge>{t("packs.detail.keyBoundBadge")}</Badge>}
                        </div>
                        <input
                          type="text"
                          className="mt-1 w-full rounded-md border border-border bg-transparent px-2 py-1 font-mono text-xs"
                          placeholder={t("packs.detail.keyPastePlaceholder")}
                          value={keyDrafts[a.id] ?? ""}
                          onChange={(e) => setKeyDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                          autoComplete="off"
                          spellCheck={false}
                          data-testid={`preset-publish-key-input-${a.id}`}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {deployNote && (
                  <p className="text-xs text-primary" data-testid="preset-publish-deploy-note">
                    {deployNote}
                  </p>
                )}
                <Button variant="outline" onClick={() => void deploy()} disabled={busy !== null} data-testid="preset-publish-deploy-btn">
                  {busy === "deploy" ? t("common.loading") : t("presetPublish.deploy")}
                </Button>
              </section>
            )}
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={gotoMarket} data-testid="preset-publish-goto-market">
                {t("presetPublish.viewMarket")}
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("presetPublish.done")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}