// MyPacksView — the subscriber's installed packs: version snapshots, update
// badge (pull-on-view comparison against the gateway's latest — design D13),
// explicit upgrade, and uninstall with the modified-skill confirmation
// (spec: pack-installation).

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "@/lib/packs-api";
import type { InstalledPack } from "@/lib/packs-api";
import { Button } from "@/components/ui/button";
import { Badge } from "./Badge";
import { VendorEarningsPanel } from "./VendorEarningsPanel";

interface UninstallPreview {
  packId: string;
  name: string;
  skills: string[];
  modifiedSkills: string[];
  agents: { id: string; name: string }[];
  // Bot units (pack-bot-units): pack-owned bot rows this uninstall removes.
  bots?: { id: string; name: string; skill?: string | null }[];
  // The operator's channel credentials on those bots — kept in the detach
  // ledger, not deleted (the same "kept items" contract as mcpServersKept).
  botsCredentialsKept?: string[];
  mcpServersKept: string[];
}

export function MyPacksView() {
  const { t } = useTranslation();
  const [packs, setPacks] = useState<InstalledPack[]>([]);
  const [latest, setLatest] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<UninstallPreview | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mine, market] = await Promise.all([api.listInstalledPacks(), api.listPacks()]);
      setPacks(mine.packs);
      setLatest(Object.fromEntries(market.packs.map((p) => [p.id, p.version])));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upgrade = async (pack: InstalledPack) => {
    setBusy(pack.packId);
    setError(null);
    try {
      const sub = await api.subscribePack(pack.packId);
      // {packId, version} only — the cell retrieves the manifest server-side
      // (pack-install-server-side-manifest).
      await api.installPack(sub.packId, sub.version);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const openUninstall = async (pack: InstalledPack) => {
    setBusy(pack.packId);
    try {
      setPreview(await api.uninstallPreview(pack.packId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const confirmUninstall = async (force: boolean) => {
    if (!preview) return;
    setBusy(preview.packId);
    try {
      await api.uninstallPack(preview.packId, force);
      // Best-effort: the gateway's subscription record is advisory.
      api.unsubscribePackRecord(preview.packId).catch(() => {});
      setPreview(null);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (loading)
    return (
      <div className="grid gap-3" data-testid="my-packs-skeleton">
        {[0, 1].map((i) => (
          <div key={i} className="border border-border rounded-lg p-4 space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-4 w-32 animate-pulse rounded bg-muted" />
              <div className="h-4 w-10 animate-pulse rounded bg-muted" />
            </div>
            <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  if (error) {
    return (
      <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-md mb-4 space-y-1" data-testid="my-packs-error">
        <p>{error}</p>
        <button type="button" className="text-sm text-destructive underline" onClick={() => void refresh()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  return (
    <section data-testid="my-packs-section" className="space-y-3">
      {/* 供应结算（add-market-revenue-share 4.3）：无 vendor 绑定的作者整段
          不渲染 — 市场面对免费创作者的既有视觉合同零变更。 */}
      <VendorEarningsPanel />
      {packs.length === 0 && <p className="text-sm text-muted-foreground">{t("packs.mine.empty")}</p>}
      {packs.map((pack) => {
        const hasUpdate = (latest[pack.packId] ?? pack.version) > pack.version;
        return (
          <div key={pack.packId} className="border border-border rounded-lg p-4" data-testid={`my-pack-${pack.packId}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{pack.name}</span>
              <span className="text-xs text-muted-foreground">v{pack.version}</span>
              {pack.source === "bundle" && (
                // Provenance badge (add-offline-pack-supply): a pack that came
                // from an offline bundle (imported by hand or from the
                // installer's starters) is NOT on the market — the upgrade
                // action below would have nowhere to fetch from, so the badge
                // says where it came from instead of pretending it is current.
                <span
                  className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  data-testid={`pack-source-badge-${pack.packId}`}
                >
                  {t("packs.mine.sourceBundle")}
                </span>
              )}
              {hasUpdate && (
                <span
                  className="inline-flex items-center rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary"
                  data-testid={`pack-update-badge-${pack.packId}`}
                >
                  {t("packs.mine.updateAvailable", { version: latest[pack.packId] })}
                </span>
              )}
              <div className="ml-auto flex gap-2">
                {hasUpdate && (
                  <Button
                    size="sm"
                    onClick={() => void upgrade(pack)}
                    disabled={busy === pack.packId}
                    data-testid={`pack-upgrade-${pack.packId}`}
                  >
                    {t("packs.mine.upgrade")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openUninstall(pack)}
                  disabled={busy === pack.packId}
                  data-testid={`pack-uninstall-${pack.packId}`}
                >
                  {t("packs.mine.uninstall")}
                </Button>
              </div>
            </div>
            <div className="flex gap-1.5 flex-wrap mt-2">
              {(pack.manifest.skills ?? []).map((s) => (
                <Badge key={s.name}>{s.name}</Badge>
              ))}
              {(pack.manifest.mcpServers ?? []).map((m) => (
                <Badge key={m.registryName}>{m.registryName}</Badge>
              ))}
              {(pack.manifest.agents ?? []).map((a) => (
                <Badge key={a.id}>{a.name}</Badge>
              ))}
              {(pack.manifest.bots ?? []).map((b) => (
                <Badge key={b.id}>{b.name}</Badge>
              ))}
            </div>
          </div>
        );
      })}

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="pack-uninstall-confirm">
          <div className="bg-background border border-border rounded-lg max-w-lg w-full p-5">
            <h3 className="font-semibold text-foreground mb-2">
              {t("packs.uninstall.title", { name: preview.name })}
            </h3>
            <p className="text-sm text-muted-foreground">{t("packs.uninstall.willRemove")}</p>
            <ul className="text-sm list-disc pl-5 my-2">
              {preview.skills.map((s) => (
                <li key={s} className="font-mono text-xs">{s}</li>
              ))}
              {preview.agents.map((a) => (
                <li key={a.id}>{a.name}</li>
              ))}
              {(preview.bots ?? []).map((b) => (
                <li key={b.id} data-testid={`pack-uninstall-bot-${b.id}`}>{b.name}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              {t("packs.uninstall.mcpKept", { servers: preview.mcpServersKept.join(", ") || "—" })}
            </p>
            {(preview.botsCredentialsKept ?? []).length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("packs.uninstall.botsCredentialsKept", { bots: (preview.botsCredentialsKept ?? []).join(", ") })}
              </p>
            )}
            {preview.modifiedSkills.length > 0 && (
              <div className="bg-destructive/10 text-destructive px-3 py-2 rounded-md text-sm mt-3" data-testid="pack-uninstall-modified">
                {t("packs.uninstall.modifiedWarning", { skills: preview.modifiedSkills.join(", ") })}
              </div>
            )}
            <div className="flex justify-end gap-2 mt-4">
              <Button size="sm" variant="outline" onClick={() => setPreview(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void confirmUninstall(preview.modifiedSkills.length > 0)}
                disabled={busy === preview.packId}
              >
                {t("packs.uninstall.confirm")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
