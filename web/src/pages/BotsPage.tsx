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

import { PageShell } from "@/components/ui/page-shell";
import { useCallback, useEffect, useState } from "react";
import { SkeletonList } from "@/components/ui/states-kit";
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
import { showToast } from "@/components/ui/toast";
import { useChatStore } from "@platform/core";
import { BotPlatformIcon } from "@/components/bots/BotPlatformIcons";
import { BotQrPanel } from "@/components/bots/BotQrPanel";
import { Textarea } from "@/components/ui/textarea";
import {
  listBots,
  createBot,
  updateBot,
  deleteBot,
  getBotDispositions,
  type Bot,
  type BotType,
  type BotDispositionSummary,
} from "@platform/core";

type FormState =
  | { mode: "closed" }
  | { mode: "add"; fixedType?: string }
  | { mode: "edit"; bot: Bot };

// Split a pasted/typed sender list into ids. Accepts newlines and commas (and
// the CJK comma, which is what a Chinese IME produces). Duplicates and blanks
// are dropped here so the textarea can stay forgiving while the request stays
// clean — the server also normalizes, but sending a tidy array keeps the
// round-trip stable (the field must not "reformat itself" after a save).
function parseSenderList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,，;；]+/)) {
    const v = raw.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function BotsPage() {
  const { t } = useTranslation();
  const [bots, setBots] = useState<Bot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [types, setTypes] = useState<BotType[]>([]);
  const [form, setForm] = useState<FormState>({ mode: "closed" });
  const [toDelete, setToDelete] = useState<Bot | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await listBots();
      setBots(data.bots);
      setTypes(data.types);
      setLoaded(true);
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
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
      showToast({ severity: "error", title: (e as Error).message });
    }
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    try {
      await deleteBot(toDelete.id);
      setToDelete(null);
      await refresh();
    } catch (e) {
      showToast({ severity: "error", title: (e as Error).message });
    }
  };

  const copyWebhook = async (bot: Bot) => {
    try {
      await navigator.clipboard.writeText(new URL(bot.webhookUrl, window.location.origin).href);
      showToast({ severity: "error", title: t("botsPage.webhookCopied") });
    } catch {
      showToast({ severity: "error", title: t("botsPage.copyFailed") });
    }
  };

  return (
    <PageShell
      data-testid="bots-page"
      title={t("botsPage.title")}
      titleTestId="bots-title"
      subtitle={t("botsPage.subtitle")}
      actions={
        <Button onClick={() => setForm({ mode: "add" })} data-testid="bots-add">
          <Plus className="mr-1 h-4 w-4" />
          {t("botsPage.addBot")}
        </Button>
      }
    >
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
            loaded ? (
              <div
                className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground"
                data-testid="bots-empty"
              >
                {t("botsPage.empty")}
              </div>
            ) : (
              <SkeletonList rows={2} data-testid="bots-loading" />
            )
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

      {form.mode !== "closed" && (
        <BotForm
          types={types}
          bot={form.mode === "edit" ? form.bot : null}
          candidates={bots}
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
    </PageShell>
  );
}

function BotForm({
  types,
  bot,
  candidates,
  fixedType,
  onClose,
  onSaved,
}: {
  types: BotType[];
  bot: Bot | null;
  /** Every bot this operator owns — the legal outbound legs (make-im-lane-outbound-capable). */
  candidates: Bot[];
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
  const [effort, setEffort] = useState(bot?.effort ?? "");
  const [contextBudget, setContextBudget] = useState(bot?.contextBudget != null ? String(bot.contextBudget) : "");
  const [persona, setPersona] = useState(bot?.persona ?? "");
  const [allowTools, setAllowTools] = useState(bot?.allowTools ?? false);
  // Rejection bookkeeping (add-staff-fleet-channels): fetched for a saved bot so
  // the operator can tell "my allowlist turned someone away" from "the channel
  // is broken". Absent/failed fetch = show nothing (this is an observation
  // surface; it must never block editing).
  const [dispositions, setDispositions] = useState<BotDispositionSummary | null>(null);
  // Sender allowlist (add-staff-fleet-channels): edited as free text, one id per
  // line. Newline OR comma separates, because operators paste both shapes and a
  // rejected paste that "looks fine" is the worst failure mode here.
  const [allowedSendersText, setAllowedSendersText] = useState((bot?.allowedSenders ?? []).join("\n"));
  const allowedSenders = parseSenderList(allowedSendersText);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A bot's effective model varies turn to turn — the dropdown offers the
  // UNION of levels any known model declares (add-agent-config-dims D6).
  const modelRoster = useChatStore((st) => st.models);
  const effortUnion = [...new Set(modelRoster.flatMap((m) => m.reasoningEfforts ?? []))];

  const fields = types.find((x) => x.type === type)?.credentialFields ?? [];

  // Fetch the disposal summary for a saved bot (and refresh after a save, since
  // the block above may have just changed who can talk to it). Swallow errors:
  // an observation surface that throws would take the edit form with it.
  useEffect(() => {
    if (!savedBot?.id) return;
    let alive = true;
    void getBotDispositions(savedBot.id)
      .then((s) => { if (alive) setDispositions(s); })
      .catch(() => { if (alive) setDispositions(null); });
    return () => { alive = false; };
  }, [savedBot?.id]);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = savedBot
        ? await updateBot(savedBot.id, {
            name,
            credentials,
            ...(savedBot ? { effort: effort || null, contextBudget: contextBudget.trim() === "" ? null : Number(contextBudget.trim()) } : {}),
            persona: persona.trim() || null,
            allowTools,
            allowedSenders,
          })
        : await createBot({ type, name, credentials, persona: persona.trim() || null, allowTools, allowedSenders });
      setSavedBot(saved);
      // Stored server-side now; blanks must mean "keep" on any further save.
      setCredentials({});
      showToast({ severity: "error", title: t("botsPage.saved") });
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

          {savedBot && effortUnion.length ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bot-effort">{t("botsPage.effort")}</Label>
              <select
                id="bot-effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                data-testid="bot-effort"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                <option value="">{t("botsPage.effortInherit")}</option>
                {effortUnion.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {savedBot ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="bot-budget">{t("botsPage.contextBudget")}</Label>
              <Input
                id="bot-budget"
                type="number"
                min={1024}
                value={contextBudget}
                placeholder={t("botsPage.contextBudgetUnlimited")}
                onChange={(e) => setContextBudget(e.target.value)}
                data-testid="bot-context-budget"
              />
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-persona">{t("botsPage.persona")}</Label>
            <Textarea
              id="bot-persona"
              value={persona}
              placeholder={t("botsPage.personaPlaceholder")}
              onChange={(e) => setPersona(e.target.value)}
              rows={4}
              data-testid="bot-persona"
            />
            <p className="text-xs text-muted-foreground">{t("botsPage.personaHint")}</p>
          </div>

          <div className="flex items-start justify-between gap-3 rounded-md border border-input p-3">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{t("botsPage.allowTools")}</div>
              <p className="mt-1 text-xs text-muted-foreground">{t("botsPage.allowToolsHint")}</p>
            </div>
            <Switch
              checked={allowTools}
              onCheckedChange={setAllowTools}
              aria-label={t("botsPage.allowTools")}
              data-testid="bot-allow-tools"
            />
          </div>

          {/* Sender allowlist (add-staff-fleet-channels). It sits next to the
              tool switch on purpose: the two are one decision. Its own reason
              line is a live warning BEFORE saving (the server's verdict only
              exists after a save, and "saved fine, tools still off" is exactly
              the confusion this pairs of lines must prevent). */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bot-allowed-senders">{t("botsPage.allowedSenders")}</Label>
            <Textarea
              id="bot-allowed-senders"
              value={allowedSendersText}
              placeholder={t("botsPage.allowedSendersPlaceholder")}
              onChange={(e) => setAllowedSendersText(e.target.value)}
              rows={3}
              data-testid="bot-allowed-senders"
            />
            <p className="text-xs text-muted-foreground">{t("botsPage.allowedSendersHint")}</p>
            {allowTools && allowedSenders.length === 0 ? (
              <p className="text-xs text-warning" data-testid="bot-allowlist-warning">
                {t("botsPage.allowedSendersRequiredForTools")}
              </p>
            ) : null}
            {/* All three reasons are shown, including the deployment-wide one:
                the spec's point is that "tools are off" must never be an
                unexplained state. Hiding the ceiling case because it repeats
                across rows would save one line and cost the only explanation
                an operator gets. */}
            {savedBot && !savedBot.toolPosture?.toolsOn ? (
              <p className="text-xs text-muted-foreground" data-testid="bot-tool-posture-reason">
                {t(`botsPage.toolsOffReason.${savedBot.toolPosture?.reason ?? "bot_switch_off"}`)}
              </p>
            ) : null}
            {/* The other half of "silent outward, countable inward": this is
                where the owner learns the allowlist is doing its job. Without
                it a rejected sender and a broken channel are the same silence. */}
            {dispositions && dispositions.senderBlocked.count > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="bot-sender-blocked">
                {t("botsPage.senderBlocked", {
                  count: dispositions.senderBlocked.count,
                  when: dispositions.senderBlocked.lastAt
                    ? new Date(dispositions.senderBlocked.lastAt).toLocaleString()
                    : "—",
                })}
              </p>
            ) : null}
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

          {savedBot && <RoomBindingSection bot={savedBot} onChanged={onSaved} candidates={candidates} />}

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

// Zhiyu IM bridge binding panel (add-zhiyu-im-bridge): bind this bot to a
// room or clear it. Separate from the main save flow — the binding lives in
// its own REST on the cell (it depends only on the bot row, not credentials).
//
// Liveness is shown, not assumed (harden-zhiyu-outbound-lanes 3.3). A binding
// survives its room: production ran with `智语·WeCom` pointing at a room that
// had been deleted straight out of sqlite, and the panel drew it exactly like a
// working binding while every group message quietly fell back to the legacy
// session path. `roomLive` is a TRI-state — true / false / "unknown" — and
// "unknown" must never be rendered as "失效": prompting an operator to unbind a
// bot that is actually fine is the worse failure.
type RoomLive = boolean | "unknown" | null;

// Outbound capability (make-im-lane-outbound-capable 1.3). "Is it bound?" and
// "can it DELIVER?" are different questions — production ran 19 undelivered
// answers from a bot whose panel showed a healthy binding. These modes come
// from the adapter itself (server/bots/adapter.js), never from a guess here.
type OutboundMode = "url-keyed" | "proactive-ip-gated" | "passive-window" | "none";
interface OutboundState {
  mode: OutboundMode;
  inbound: boolean;
  canSendNow: boolean;
  detail: string | null;
}

function RoomBindingSection({
  bot,
  onChanged,
  candidates = [],
}: {
  bot: { id: string; zhiRoomId?: string | null; zhiOutboundBotId?: string | null };
  onChanged: () => void;
  /** This operator's other bots — the only legal outbound legs (3.2). */
  candidates?: Array<{ id: string; name: string; type: string }>;
}) {
  const { t } = useTranslation();
  const [roomInput, setRoomInput] = useState(bot.zhiRoomId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [roomLive, setRoomLive] = useState<RoomLive>(null);
  const [outbound, setOutbound] = useState<OutboundState | null>(null);
  const [outboundLeg, setOutboundLeg] = useState(bot.zhiOutboundBotId ?? "");
  const bound = Boolean(bot.zhiRoomId);

  // Ask whether the bound room still exists. Separate from `call` so a failed
  // liveness read never blocks the binding controls.
  useEffect(() => {
    if (!bound) {
      setRoomLive(null);
      setOutbound(null);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/zhiyu-im-bridge/bots/${encodeURIComponent(bot.id)}/room`);
        const data = (await r.json().catch(() => null)) as { roomLive?: RoomLive; outbound?: OutboundState } | null;
        if (alive) {
          setRoomLive(data?.roomLive ?? "unknown");
          setOutbound(data?.outbound ?? null);
        }
      } catch {
        /* unknown keeps the controls usable; it is not a verdict */
      }
    })();
    return () => {
      alive = false;
    };
  }, [bot.id, bound]);

  const call = async (method: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/zhiyu-im-bridge/bots/${encodeURIComponent(bot.id)}/room`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border p-3">
      <Label>{t("botsPage.roomBinding.label")}</Label>
      {bound ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-sm">
            <code className="truncate text-xs">{bot.zhiRoomId}</code>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void call("DELETE")}>
              {t("botsPage.roomBinding.unbind")}
            </Button>
          </div>
          {/* Capability FIRST, liveness second (make-im-lane-outbound-capable 1.3).
              A live room on an undeliverable leg is precisely the 2026-11-18
              shape: 19 answers died while the panel read "bound, room fine".
              Each mode names its own fix, because the fixes differ. */}
          {outbound ? (
            <div className="flex flex-col gap-0.5" data-testid="bot-room-outbound">
              <p
                className={`text-xs ${outbound.canSendNow ? "text-muted-foreground" : "text-status-failed"}`}
                data-testid={`bot-room-outbound-${outbound.mode}`}
              >
                {t(`botsPage.roomBinding.outbound.${outbound.mode}`, {
                  defaultValue: t("botsPage.roomBinding.outbound.none"),
                })}
                {outbound.detail
                  ? ` · ${t(`botsPage.roomBinding.outboundDetail.${outbound.detail}`, { defaultValue: "" })}`
                  : ""}
              </p>
              {!outbound.inbound ? (
                <p className="text-xs text-muted-foreground" data-testid="bot-room-outbound-out-only">
                  {t("botsPage.roomBinding.outboundOnly")}
                </p>
              ) : null}
            </div>
          ) : null}
          {/* Split legs (3.2/3.4): inbound on the bot that receives, outbound
              optionally on a pure-push channel. This is the answer to "the egress
              moved" — it stops being fatal. Only bots with a real outbound path
              are offered; the server refuses anything else anyway. */}
          <div className="flex items-center gap-2" data-testid="bot-room-outbound-leg">
            <select
              className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs"
              value={outboundLeg}
              onChange={(e) => setOutboundLeg(e.target.value)}
              data-testid="bot-room-outbound-leg-select"
            >
              <option value="">{t("botsPage.roomBinding.outboundLeg.same")}</option>
              {candidates
                .filter((c) => c.id !== bot.id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（{c.type}）
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || outboundLeg === (bot.zhiOutboundBotId ?? "")}
              onClick={() => void call("PUT", { zhiRoomId: bot.zhiRoomId, outboundBotId: outboundLeg || null })}
              data-testid="bot-room-outbound-leg-save"
              className="shrink-0"
            >
              {t("botsPage.roomBinding.outboundLeg.save")}
            </Button>
          </div>
          {roomLive === false ? (
            <>
              <p className="text-xs text-status-failed" data-testid="bot-room-binding-stale">
                {t("botsPage.roomBinding.stale")}
              </p>
              {/* Both ways out, in the same breath: an operator who just learned
                  the binding is dead needs to either drop it or point it
                  somewhere real, and hunting for the control would be the
                  second failure. */}
              <div className="flex items-center gap-2">
                <Input
                  value={roomInput}
                  onChange={(e) => setRoomInput(e.target.value)}
                  placeholder={t("botsPage.roomBinding.placeholder")}
                  className="flex-1"
                  data-testid="bot-room-binding-rebind-input"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !/^zy_[0-9a-f]+$/.test(roomInput.trim())}
                  onClick={() => void call("PUT", { zhiRoomId: roomInput.trim() })}
                  data-testid="bot-room-binding-rebind"
                  className="shrink-0"
                >
                  {t("botsPage.roomBinding.rebind")}
                </Button>
              </div>
            </>
          ) : roomLive === "unknown" ? (
            <p className="text-xs text-muted-foreground" data-testid="bot-room-binding-unknown">
              {t("botsPage.roomBinding.unknown")}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            placeholder={t("botsPage.roomBinding.placeholder")}
            className="flex-1"
            data-testid="bot-room-binding-input"
          />
          <Button size="sm" variant="outline" disabled={busy || !/^zy_[0-9a-f]+$/.test(roomInput.trim())} onClick={() => void call("PUT", { zhiRoomId: roomInput.trim() })} data-testid="bot-room-binding-save" className="shrink-0">
            {t("botsPage.roomBinding.bind")}
          </Button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("botsPage.roomBinding.hint")}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
