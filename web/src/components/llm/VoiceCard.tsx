// VoiceCard — the voice lane's settings card in the Models section
// (voice-lane, design D6).
//
// Status first (available / disabled / no key, and whose account bills), then
// the fields of the `voice` block for administrators. The voice is no longer
// two free-text boxes (add-room-voice-and-catalog): `ttsModel` and `ttsVoice`
// are two halves of ONE selection drawn from the voice catalog, so this card
// renders a single entry picker plus a "preview" button. Blank = the upstream
// default, exactly as before. Non-administrators see the status read-only.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Mic, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { showToast } from "@/components/ui/toast";
import { refreshVoiceStatus, useVoice } from "@/hooks/useVoice";
import { fetchVoiceCatalog, previewVoice, speechPlayer, updateVoiceConfig, VoiceError, type VoiceCatalog, type VoiceConfig } from "@/lib/voice";

const FORMATS = ["mp3", "wav", "opus", "aac", "flac"];

type Draft = Pick<VoiceConfig, "enabled" | "asrModel" | "ttsModel" | "ttsVoice" | "ttsFormat">;

export function VoiceCard({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const { status, loaded } = useVoice();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catalog, setCatalog] = useState<VoiceCatalog | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount: re-read the status (the cached one may predate a settings save on
  // another tab) and seed the draft from the resolved config.
  useEffect(() => {
    void refreshVoiceStatus();
    void fetchVoiceCatalog()
      .then(setCatalog)
      .catch(() => setCatalog(null)); // an unreadable catalog just hides the picker
  }, []);
  useEffect(() => {
    if (status && draft === null) setDraft({ ...status.config });
  }, [status, draft]);

  // The selected catalog entry, or null when the pair is blank (upstream
  // default) or names something the catalog no longer carries.
  const selected =
    draft && draft.ttsModel && draft.ttsVoice
      ? catalog?.entries.find((e) => e.model === draft.ttsModel && e.voice === draft.ttsVoice) ?? null
      : null;
  const selectionIsStale = Boolean(draft?.ttsModel || draft?.ttsVoice) && catalog !== null && selected === null;

  const dirty =
    draft !== null &&
    status !== null &&
    (["enabled", "asrModel", "ttsModel", "ttsVoice", "ttsFormat"] as const).some((k) => draft[k] !== status.config[k]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await updateVoiceConfig(draft);
      await refreshVoiceStatus();
      setDraft(null); // re-seed from the saved block
      showToast({ severity: "error", title: t("voiceCard.saved") });
    } catch (e) {
      setError(e instanceof VoiceError ? e.message : (e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, t]);

  // Preview goes through the same lane as real synthesis, which is the point:
  // it is the only place an entry the upstream has dropped will fail visibly.
  const preview = useCallback(async () => {
    const entry = selected ?? catalog?.default ?? null;
    if (!entry) return;
    setPreviewing(true);
    try {
      const blob = await previewVoice(entry);
      await speechPlayer.play(`preview:${entry.model}:${entry.voice}`, blob);
    } catch (e) {
      showToast({ severity: "error", title: e instanceof VoiceError ? e.message : t("voiceCard.previewFailed") });
    } finally {
      setPreviewing(false);
    }
  }, [selected, catalog, t]);

  const statusKey = !status
    ? loaded
      ? "voiceCard.status.unavailable"
      : "voiceCard.status.loading"
    : status.available
      ? "voiceCard.status.available"
      : status.reason === "disabled"
        ? "voiceCard.status.disabled"
        : "voiceCard.status.noKey";
  const stateAttr = !status ? (loaded ? "unavailable" : "loading") : status.available ? "available" : (status.reason ?? "unavailable");

  const field = (key: Exclude<keyof Draft, "enabled" | "ttsFormat">, testId: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`voice-${key}`}>{t(`voiceCard.${key}`)}</Label>
      {isAdmin ? (
        <Input
          id={`voice-${key}`}
          data-testid={testId}
          value={draft?.[key] ?? ""}
          placeholder={t("voiceCard.blankHint")}
          maxLength={120}
          disabled={saving || !draft}
          onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))}
        />
      ) : (
        <div className="text-sm text-foreground" data-testid={testId}>
          {status?.config[key] || <span className="text-muted-foreground">{t("voiceCard.blankHint")}</span>}
        </div>
      )}
    </div>
  );

  return (
    <section
      data-testid="voice-card"
      className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Mic className="h-4 w-4" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-foreground">{t("voiceCard.title")}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("voiceCard.subtitle")}</p>
          </div>
        </div>
        <div className="text-right text-xs">
          <div
            data-testid="voice-card-status"
            data-state={stateAttr}
            className={status?.available ? "text-success" : "text-muted-foreground"}
          >
            {t(statusKey)}
          </div>
          {status?.available && status.keySource && (
            <div className="mt-0.5 text-muted-foreground" data-testid="voice-card-key-source">
              {t(`voiceCard.keySource.${status.keySource}`)}
            </div>
          )}
        </div>
      </header>

      {isAdmin ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="voice-enabled">{t("voiceCard.enabled")}</Label>
            <Switch
              id="voice-enabled"
              data-testid="voice-card-enabled"
              checked={draft?.enabled ?? true}
              disabled={saving || !draft}
              onCheckedChange={(checked) => setDraft((d) => (d ? { ...d, enabled: checked } : d))}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {field("asrModel", "voice-card-asr-model")}
            <div className="flex flex-col gap-1 sm:col-span-2">
              <Label htmlFor="voice-tts-entry">{t("voiceCard.ttsVoice")}</Label>
              {isAdmin ? (
                <div className="flex items-center gap-2">
                  <select
                    id="voice-tts-entry"
                    data-testid="voice-card-tts-voice"
                    value={selected ? `${selected.model}|${selected.voice}` : ""}
                    disabled={saving || !draft || catalog === null}
                    onChange={(e) => {
                      const [m, v] = e.target.value.split("|");
                      setDraft((d) => (d ? { ...d, ttsModel: m ?? "", ttsVoice: v ?? "" } : d));
                    }}
                    className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                  >
                    <option value="">{t("voiceCard.blankHint")}</option>
                    {(catalog?.entries ?? []).map((e) => (
                      <option key={`${e.model}|${e.voice}`} value={`${e.model}|${e.voice}`}>
                        {e.label} · {e.protocol}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="voice-card-preview"
                    disabled={previewing || (!selected && !catalog?.default)}
                    onClick={() => void preview()}
                  >
                    <Play className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                    {t("voiceCard.preview")}
                  </Button>
                </div>
              ) : (
                <div className="text-sm text-foreground" data-testid="voice-card-tts-voice">
                  {selected?.label ?? <span className="text-muted-foreground">{t("voiceCard.blankHint")}</span>}
                </div>
              )}
              {selectionIsStale && (
                <p className="text-xs text-destructive" data-testid="voice-card-voice-stale">
                  {t("voiceCard.staleSelection")}
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="voice-ttsFormat">{t("voiceCard.ttsFormat")}</Label>
              <select
                id="voice-ttsFormat"
                data-testid="voice-card-tts-format"
                value={draft?.ttsFormat ?? "mp3"}
                disabled={saving || !draft}
                onChange={(e) => setDraft((d) => (d ? { ...d, ttsFormat: e.target.value } : d))}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
              >
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && (
            <p className="text-xs text-destructive" data-testid="voice-card-error">
              {error}
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={save} disabled={!dirty || saving} data-testid="voice-card-save">
              {saving ? t("voiceCard.saving") : t("voiceCard.save")}
            </Button>
          </div>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {field("asrModel", "voice-card-asr-model")}
          <div className="flex flex-col gap-1">
            <Label>{t("voiceCard.ttsVoice")}</Label>
            <div className="text-sm text-foreground" data-testid="voice-card-tts-voice">
              {selected?.label ?? <span className="text-muted-foreground">{t("voiceCard.blankHint")}</span>}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t("voiceCard.ttsFormat")}</Label>
            <div className="text-sm text-foreground" data-testid="voice-card-tts-format">
              {status?.config.ttsFormat ?? "mp3"}
            </div>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-2">{t("voiceCard.readOnly")}</p>
        </div>
      )}
    </section>
  );
}
