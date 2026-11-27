// PublishTeamCardDialog.tsx — 「发布到目录」 (openspec: add-agent-team-directory,
// tasks 4.3–4.4).
//
// Three disciplines are structural here, not copy:
//   1. NOTHING IS WRITTEN BEFORE CONFIRM. The preview is a server dry run
//      (`POST /api/teams/cards/preview`) that runs the SAME validation and the
//      SAME derivation the save will — so "所见即所发" is literal and a bad value
//      is refused before it can become a publication row.
//   2. `open` needs a second, explicit acknowledgement. Until it is given the
//      save is disabled — the client never quietly downgrades the choice, and
//      the visibility stays whatever it was.
//   3. The receipt tells the truth about latency: the owner sees their own cell
//      immediately, everyone else sees it after the gateway's 60s sampling
//      window. No "immediately visible" promise, because it would be false.
//
// Withdraw is a separate destructive action with its own confirmation; the
// receipt says the team itself is untouched, because that is the only thing an
// owner will wonder about at that moment.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentSpecSheet } from "@/components/packs/AgentSpecSheet";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusPill } from "@/components/ui/status-pill";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { StatusKind } from "@/lib/statusTokens";

type Visibility = "private" | "listed" | "open";

interface TeamCard {
  name: string;
  description: string;
  version: number;
  capabilities: string[];
  skills: { id: string; name: string }[];
  posts: { id: string; title: string }[];
  pricing: { callsPerDay: number; tokensPerDay: number; usdPerDay: number; currency: string; billedTo: string };
  availability: { state: string; accepting: boolean };
  trust: { publishedAt: number; cellId: string };
}

interface Publication {
  handle: string;
  fleetId: string;
  displayName: string;
  description: string;
  visibility: Visibility;
  callers: string[];
  quota: { callsPerDay: number; tokensPerDay: number; usdPerDay: number };
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fleetId: string;
  fleetName: string;
  /** The published handle (or null after a withdraw) so the cockpit can open the
   *  approvals queue for exactly this card. */
  onChanged?: (handle?: string | null) => void;
}

const VISIBILITIES: Visibility[] = ["private", "listed", "open"];

async function jcall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((data as { error?: string } | null)?.error ?? `HTTP ${r.status}`);
    (err as Error & { field?: string }).field = (data as { field?: string } | null)?.field;
    throw err;
  }
  return data as T;
}

/** A handle derived from the fleet id: readable, stable, obviously editable. */
function defaultHandle(fleetId: string) {
  const tail = fleetId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8);
  return `team-${tail || "card"}`;
}

export function PublishTeamCardDialog({ open, onOpenChange, fleetId, fleetName, onChanged }: Props) {
  const { t } = useTranslation();
  const [publication, setPublication] = useState<Publication | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  const [callersText, setCallersText] = useState("");
  const [calls, setCalls] = useState("");
  const [tokens, setTokens] = useState("");
  const [usd, setUsd] = useState("");
  const [openAcknowledged, setOpenAcknowledged] = useState(false);

  const [preview, setPreview] = useState<{ card: TeamCard; fallbacks: { field: string; value: number }[] } | null>(null);
  const [previewError, setPreviewError] = useState<{ message: string; field?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<"saved" | "withdrawn" | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const previewSeq = useRef(0);

  const isOpenSwitch = visibility === "open" && !openAcknowledged;

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const out = await jcall<{ publication: Publication | null }>("GET", `/api/teams/cards/for-fleet/${encodeURIComponent(fleetId)}`);
      setPublication(out.publication);
      const p = out.publication;
      setHandle(p?.handle ?? defaultHandle(fleetId));
      setDisplayName(p?.displayName ?? fleetName);
      setDescription(p?.description ?? "");
      setVisibility(p?.visibility ?? "private");
      setCallersText((p?.callers ?? []).join("\n"));
      setCalls(p ? String(p.quota.callsPerDay) : "");
      setTokens(p ? String(p.quota.tokensPerDay) : "");
      setUsd(p ? String(p.quota.usdPerDay) : "");
      setOpenAcknowledged(p?.visibility === "open");
      setReceipt(null);
    } catch (err) {
      setLoadError((err as Error).message);
    }
  }, [fleetId, fleetName]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const body = useMemo(() => {
    const callers = callersText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const num = (raw: string) => (raw.trim() ? Number(raw.trim()) : undefined);
    return {
      fleetId,
      handle,
      displayName,
      description,
      visibility,
      callers,
      ...(num(calls) !== undefined ? { callsPerDay: num(calls) } : {}),
      ...(num(tokens) !== undefined ? { tokensPerDay: num(tokens) } : {}),
      ...(num(usd) !== undefined ? { usdPerDay: num(usd) } : {}),
    };
  }, [fleetId, handle, displayName, description, visibility, callersText, calls, tokens, usd]);

  // Debounced dry run. Every keystroke is a request only if the user pauses;
  // a stale response can never overwrite a newer preview (sequence guard).
  useEffect(() => {
    if (!open || receipt === "withdrawn") return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = await jcall<{ card: TeamCard; fallbacks: { field: string; value: number }[] }>(
            "POST",
            "/api/teams/cards/preview",
            body,
          );
          if (seq !== previewSeq.current) return;
          setPreview(out);
          setPreviewError(null);
        } catch (err) {
          if (seq !== previewSeq.current) return;
          setPreview(null);
          setPreviewError({ message: (err as Error).message, field: (err as Error & { field?: string }).field });
        }
      })();
    }, 250);
    return () => clearTimeout(timer);
  }, [open, body, receipt]);

  const save = async () => {
    if (isOpenSwitch) return; // defensive: the button is disabled anyway
    setBusy(true);
    setPreviewError(null);
    try {
      const path = `/api/teams/cards/${encodeURIComponent(handle)}`;
      const out = await jcall<{ publication: Publication }>(publication ? "PATCH" : "POST", path, body);
      setPublication(out.publication);
      setReceipt("saved");
      onChanged?.(out.publication.handle);
    } catch (err) {
      setPreviewError({ message: (err as Error).message, field: (err as Error & { field?: string }).field });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!publication) return;
    setBusy(true);
    try {
      await jcall("DELETE", `/api/teams/cards/${encodeURIComponent(publication.handle)}`);
      setConfirmWithdraw(false);
      setPublication(null);
      setVisibility("private");
      setReceipt("withdrawn");
      onChanged?.(null);
    } catch (err) {
      setPreviewError({ message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const availability = preview?.card.availability;
  const status: StatusKind = availability?.accepting ? "running" : availability?.state === "paused" ? "paused" : "failed";

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto" data-testid="publish-card-dialog">
          <DialogHeader>
            <DialogTitle>{t("teamCard.title")}</DialogTitle>
            <DialogDescription>{t("teamCard.subtitle")}</DialogDescription>
          </DialogHeader>

          {loadError ? (
            <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-sm text-status-failed">
              {t("teamCard.loadFailed", { error: loadError })}
            </p>
          ) : (
            <div className="space-y-5">
              {receipt === "saved" && (
                <p
                  className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground"
                  data-testid="publish-receipt-saved"
                >
                  {t("teamCard.receipt.saved")}
                </p>
              )}
              {receipt === "withdrawn" && (
                <p
                  className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-foreground"
                  data-testid="publish-receipt-withdrawn"
                >
                  {t("teamCard.receipt.withdrawn")}
                </p>
              )}

              {/* ── identity ── */}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="tc-handle">{t("teamCard.fields.handle")}</Label>
                  <Input
                    id="tc-handle"
                    value={handle}
                    disabled={publication !== null}
                    onChange={(e) => setHandle(e.target.value.toLowerCase())}
                    placeholder="cs-team"
                    className="font-mono"
                    data-testid="publish-handle"
                  />
                  <p className="text-[11px] text-muted-foreground">{t("teamCard.fields.handleHint")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="tc-name">{t("teamCard.fields.name")}</Label>
                  <Input
                    id="tc-name"
                    value={displayName}
                    maxLength={120}
                    onChange={(e) => setDisplayName(e.target.value)}
                    data-testid="publish-name"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="tc-desc">{t("teamCard.fields.description")}</Label>
                <Textarea
                  id="tc-desc"
                  value={description}
                  maxLength={500}
                  rows={2}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t("teamCard.fields.descriptionPlaceholder")}
                  data-testid="publish-description"
                />
              </div>

              {/* ── visibility: three values, two doors ── */}
              <fieldset className="space-y-2">
                <legend className="text-xs font-medium text-foreground">{t("teamCard.visibility.title")}</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {VISIBILITIES.map((value) => (
                    <label
                      key={value}
                      className={`cursor-pointer rounded-md border p-3 transition-colors ${
                        visibility === value ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                      }`}
                      data-testid={`publish-visibility-${value}`}
                    >
                      <input
                        type="radio"
                        name="tc-visibility"
                        className="sr-only"
                        checked={visibility === value}
                        onChange={() => {
                          setVisibility(value);
                          // Leaving `open` never needs the acknowledgement, and
                          // coming back to it does — re-arm on every change.
                          setOpenAcknowledged(value === "open" ? false : true);
                        }}
                      />
                      <span className="block text-xs font-medium text-foreground">
                        {t(`teamCard.visibility.${value}.label`)}
                      </span>
                      <span className="mt-1 block text-[11px] leading-4 text-muted-foreground">
                        {t(`teamCard.visibility.${value}.hint`)}
                      </span>
                    </label>
                  ))}
                </div>
                {visibility === "open" && (
                  <div className="rounded-md border border-status-waiting/40 bg-status-waiting/5 p-3" data-testid="publish-open-gate">
                    <p className="text-[11px] leading-5 text-foreground">{t("teamCard.openGate.hint")}</p>
                    <label className="mt-2 flex items-center gap-2 text-[11px] text-foreground">
                      <Switch checked={openAcknowledged} onCheckedChange={setOpenAcknowledged} />
                      <span>{t("teamCard.openGate.acknowledge")}</span>
                    </label>
                  </div>
                )}
              </fieldset>

              {/* ── quota: visible before anyone calls ── */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">{t("teamCard.quota.title")}</div>
                <div className="grid gap-3 sm:grid-cols-3">
                  {(
                    [
                      ["calls", calls, setCalls, "200"],
                      ["tokens", tokens, setTokens, "2000000"],
                      ["usd", usd, setUsd, "5"],
                    ] as const
                  ).map(([key, value, setter, placeholder]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`tc-${key}`}>{t(`teamCard.quota.${key}`)}</Label>
                      <Input
                        id={`tc-${key}`}
                        type="number"
                        min={1}
                        value={value}
                        placeholder={placeholder}
                        onChange={(e) => setter(e.target.value)}
                        className="font-mono"
                        data-testid={`publish-quota-${key}`}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{t("teamCard.quota.hint")}</p>
                {preview?.fallbacks.map((f) => (
                  <p key={f.field} className="text-[11px] text-status-waiting" data-testid={`publish-fallback-${f.field}`}>
                    {t("teamCard.quota.fallback", { field: t(`teamCard.quota.${f.field}`), value: f.value })}
                  </p>
                ))}
              </div>

              {/* ── caller allow-list ── */}
              <div className="space-y-1.5">
                <Label htmlFor="tc-callers">{t("teamCard.callers.title")}</Label>
                <Textarea
                  id="tc-callers"
                  value={callersText}
                  rows={3}
                  onChange={(e) => setCallersText(e.target.value)}
                  placeholder={"alice@example.com\nbob@example.com"}
                  className="font-mono text-xs"
                  data-testid="publish-callers"
                />
                <p className="text-[11px] text-muted-foreground">{t("teamCard.callers.hint")}</p>
              </div>

              {/* ── preview: the server's own derivation, not a client copy ── */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-foreground">{t("teamCard.preview.title")}</div>
                {previewError ? (
                  <p className="rounded-md border border-status-failed/40 bg-card px-3 py-2 text-xs text-status-failed" data-testid="publish-preview-error">
                    {t("teamCard.preview.invalid", { error: previewError.message })}
                  </p>
                ) : preview ? (
                  <div className="space-y-2 rounded-md border border-border p-3" data-testid="publish-preview">
                    <div className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate text-sm font-semibold text-foreground">{preview.card.name}</span>
                      <StatusPill status={status} label={t(`teamDirectory.availability.${preview.card.availability.state}`)} />
                    </div>
                    {preview.card.description && (
                      <p className="text-xs leading-5 text-muted-foreground">{preview.card.description}</p>
                    )}
                    <AgentSpecSheet
                      variant="compact"
                      testIdPrefix="publish-sheet"
                      roles={preview.card.posts.map((p) => ({ id: p.id, name: p.title }))}
                      skillCount={preview.card.skills.length}
                    />
                    <p className="border-t border-border pt-2 text-[11px] text-muted-foreground">
                      {t("teamDirectory.pricing.compact", {
                        calls: preview.card.pricing.callsPerDay,
                        usd: preview.card.pricing.usdPerDay,
                      })}
                    </p>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground">{t("teamCard.preview.loading")}</p>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="mt-4 gap-2 sm:gap-2">
            {publication && (
              <Button
                type="button"
                variant="destructive"
                className="mr-auto"
                disabled={busy}
                onClick={() => setConfirmWithdraw(true)}
                data-testid="publish-withdraw"
              >
                {t("teamCard.actions.withdraw")}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("teamCard.actions.close")}
            </Button>
            <Button
              type="button"
              disabled={busy || isOpenSwitch || !!previewError?.field || loadError !== null}
              onClick={() => void save()}
              data-testid="publish-save"
            >
              {busy ? t("teamCard.actions.saving") : publication ? t("teamCard.actions.update") : t("teamCard.actions.publish")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        variant="danger"
        title={t("teamCard.withdraw.title")}
        description={t("teamCard.withdraw.description")}
        confirmLabel={t("teamCard.withdraw.confirm")}
        cancelLabel={t("common.cancel")}
        onConfirm={() => void withdraw()}
        closeOnConfirm={false}
      />
    </>
  );
}
