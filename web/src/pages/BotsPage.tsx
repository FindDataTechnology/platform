// BotsPage — /bots, the management surface for social chat channels.
//
// The primary entry is the platform icon grid (redesign-bots-surface, D1):
// clicking a tile starts the add flow with that type fixed. Configured bots
// render below as cards carrying their platform's brand icon, the enable
// toggle, edit/delete, and the webhook URL copy. The credential form is driven
// by the per-type `credentialFields` the server advertises, so adding a
// platform adapter needs no change here. Credential values are write-only: the
// server returns which keys are configured, never their values, and a blank
// field on edit means "keep the stored one".

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Copy, Trash2, Pencil, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { showToast } from "@/components/Toast";
import { BotPlatformIcon } from "@/components/bots/BotPlatformIcons";
import { BotQrPanel } from "@/components/bots/BotQrPanel";
import {
  listBots,
  createBot,
  updateBot,
  deleteBot,
  type Bot,
  type BotType,
} from "@platform/core";

type FormState =
  | { mode: "closed" }
  | { mode: "add"; fixedType?: string }
  | { mode: "edit"; bot: Bot };

export function BotsPage() {
  const { t } = useTranslation();
  const [bots, setBots] = useState<Bot[]>([]);
  const [types, setTypes] = useState<BotType[]>([]);
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [toDelete, setToDelete] = useState<Bot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listBots();
      setBots(data.bots);
      setTypes(data.types);
    } catch (e) {
      showToast((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggle = async (bot: Bot, enabled: boolean) => {
    try {
      await updateBot(bot.id, { enabled });
      await refresh();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteBot(toDelete.id);
      setToDelete(null);
      await refresh();
    } catch (e) {
      showToast((e as Error).message);
    }
  };

  const copyWebhook = async (bot: Bot) => {
    try {
      await navigator.clipboard.writeText(new URL(bot.webhookUrl, window.location.origin).href);
      showToast(t("botsPage.webhookCopied"));
    } catch {
      showToast(t("botsPage.copyFailed"));
    }
  };

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto" data-testid="bots-page">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{t("botsPage.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("botsPage.subtitle")}</p>
          </div>
          <Button onClick={() => setForm({ mode: "add" })} data-testid="bots-add">
            <Plus className="mr-1 h-4 w-4" />
            {t("botsPage.addBot")}
          </Button>
        </header>

        <section className="flex flex-col gap-2" data-testid="bot-platform-grid">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {types.map((x) => (
              <button
                key={x.type}
                type="button"
                onClick={() => setForm({ mode: "add", fixedType: x.type })}
                data-testid="bot-platform-tile"
                data-platform={x.type}
                className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-5 text-foreground transition-colors hover:border-primary/50 hover:bg-accent/50"
              >
                <BotPlatformIcon type={x.type} className="h-9 w-9" />
                <span className="text-sm font-medium">{t(`botsPage.types.${x.type}`, x.type)}</span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t("botsPage.gridHint")}</p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-medium text-foreground">{t("botsPage.configuredTitle")}</h2>
          {bots.length === 0 ? (
            <div
              className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground"
              data-testid="bots-empty"
            >
              {t("botsPage.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {bots.map((bot) => (
                <div
                  key={bot.id}
                  data-testid="bot-card"
                  className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span data-testid="bot-card-icon" className="shrink-0">
                        <BotPlatformIcon type={bot.type} className="h-6 w-6" />
                      </span>
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{bot.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {t(`botsPage.types.${bot.type}`, bot.type)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={bot.enabled}
                        onCheckedChange={(v) => toggle(bot, v)}
                        aria-label={t("botsPage.enabled")}
                        data-testid="bot-enable"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setForm({ mode: "edit", bot })}
                        title={t("botsPage.qr.title")}
                        data-testid="bot-qr-open"
                      >
                        <QrCode className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setForm({ mode: "edit", bot })}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setToDelete(bot)} data-testid="bot-delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 text-xs text-muted-foreground">
                      {bot.webhookUrl}
                    </code>
                    <Button variant="outline" size="sm" onClick={() => copyWebhook(bot)} data-testid="bot-copy-webhook">
                      <Copy className="mr-1 h-3.5 w-3.5" />
                      {t("botsPage.copy")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {form.mode !== "closed" && (
        <BotForm
          types={types}
          bot={form.mode === "edit" ? form.bot : null}
          fixedType={form.mode === "add" ? form.fixedType : undefined}
          onClose={() => setForm({ mode: "closed" })}
          onSaved={refresh}
        />
      )}

      <Dialog open={Boolean(toDelete)} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("botsPage.confirmDeleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("botsPage.confirmDelete", { name: toDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>
              {t("botsPage.cancel")}
            </Button>
            <Button variant="destructive" onClick={confirmDelete} data-testid="bot-delete-confirm">
              {t("botsPage.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function BotForm({
  types,
  bot,
  fixedType,
  onClose,
  onSaved,
}: {
  types: BotType[];
  bot: Bot | null;
  fixedType?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  // The persisted bot backing this dialog. Starting null, the QR section only
  // exists after the first save (design D4) — a create lands here and the
  // dialog turns into the edit view with the panel resolving.
  const [savedBot, setSavedBot] = useState<Bot | null>(bot);
  const [type, setType] = useState(bot?.type ?? fixedType ?? types[0]?.type ?? "");
  const [name, setName] = useState(bot?.name ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fields = types.find((x) => x.type === type)?.credentialFields ?? [];

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = savedBot
        ? await updateBot(savedBot.id, { name, credentials })
        : await createBot({ type, name, credentials });
      setSavedBot(saved);
      // Stored server-side now; blanks must mean "keep" on any further save.
      setCredentials({});
      showToast(t("botsPage.saved"));
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{savedBot ? t("botsPage.editBot") : t("botsPage.addBot")}</DialogTitle>
          <DialogDescription>{t("botsPage.formHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-type">{t("botsPage.type")}</Label>
            <select
              id="bot-type"
              value={type}
              disabled={Boolean(savedBot) || Boolean(fixedType)}
              onChange={(e) => {
                setType(e.target.value);
                setCredentials({});
              }}
              data-testid="bot-type"
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground disabled:opacity-50"
            >
              {types.map((x) => (
                <option key={x.type} value={x.type}>
                  {t(`botsPage.types.${x.type}`, x.type)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-name">{t("botsPage.name")}</Label>
            <Input id="bot-name" value={name} onChange={(e) => setName(e.target.value)} data-testid="bot-name" />
          </div>

          {fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={`bot-cred-${f.key}`}>{f.label}</Label>
              <Input
                id={`bot-cred-${f.key}`}
                type={f.secret ? "password" : "text"}
                value={credentials[f.key] ?? ""}
                // Editing shows no stored value (the server never sends one);
                // blank means "keep it".
                placeholder={savedBot?.configuredCredentials.includes(f.key) ? t("botsPage.keepStored") : ""}
                onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                data-testid={`bot-cred-${f.key}`}
              />
            </div>
          ))}

          {savedBot && <BotQrPanel bot={savedBot} onSaved={onSaved} />}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("botsPage.cancel")}
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()} data-testid="bot-save">
            {t("botsPage.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
