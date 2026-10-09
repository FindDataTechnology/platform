// Settings → Deployment branding (openspec: add-deployment-branding; hero
// editor: add-login-hero). Four flat fields + the structured loginHero slot
// group, one PUT. Reads effective values from GET /api/config (stored → env)
// and saves via PUT /api/config/branding (admin-gated when auth on; the
// section itself is admin-visible then, see sections.ts).
//
// The hero block edits one locale at a time (dropdown, closed set); other
// locales' entries ride along unchanged — the PUT sends the merged map, and an
// empty map sends null (clear back to the env fallback).

import { useEffect, useState } from "react";
import { Paintbrush } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppConfig, loadAppConfig } from "@/hooks/useAppConfig";
import { LOCALE_DISPLAY_NAMES, SUPPORTED_LOCALES, type Locale } from "@/i18n/config";
import type { LoginHeroEntry, LoginHeroLink } from "@/lib/login-hero";

const FIELDS = [
  { key: "companyName", labelKey: "settings.branding.companyName", hintKey: null },
  { key: "assistantName", labelKey: "settings.branding.assistantName", hintKey: null },
  { key: "brandIconUrl", labelKey: "settings.branding.brandIconUrl", hintKey: "settings.branding.brandIconUrlHint" },
  { key: "loginFooterText", labelKey: "settings.branding.loginFooterText", hintKey: "settings.branding.loginFooterTextHint" },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];

const inputCls =
  "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none";

interface HeroForm {
  title: string;
  subtitle: string;
  imageUrl: string;
  points: string;
  links: string;
}

export function BrandingSection() {
  const { t } = useTranslation();
  const appConfig = useAppConfig();
  const [values, setValues] = useState<Record<FieldKey, string>>({
    companyName: "",
    assistantName: "",
    brandIconUrl: "",
    loginFooterText: "",
  });
  const [heroLocale, setHeroLocale] = useState<Locale>("en");
  const [hero, setHero] = useState<HeroForm>({ title: "", subtitle: "", imageUrl: "", points: "", links: "" });
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");

  // Seed the form from the effective config once it resolves.
  useEffect(() => {
    setValues({
      companyName: appConfig.companyName ?? "",
      assistantName: appConfig.assistantName ?? "",
      brandIconUrl: appConfig.brandIconUrl ?? "",
      loginFooterText: appConfig.loginFooterText ?? "",
    });
  }, [appConfig]);

  // The hero form follows the selected locale; reseeded when the effective
  // config changes (save refresh) or the locale dropdown moves.
  useEffect(() => {
    const entry: LoginHeroEntry | undefined = appConfig.loginHero?.[heroLocale];
    setHero({
      title: entry?.title ?? "",
      subtitle: entry?.subtitle ?? "",
      imageUrl: entry?.imageUrl ?? "",
      points: entry?.points?.join("\n") ?? "",
      links: entry?.links?.map((l) => `${l.label} | ${l.url}`).join("\n") ?? "",
    });
  }, [appConfig, heroLocale]);

  // `label | https://url` per line → LoginHeroLink[], naming the first bad line.
  const parseLinks = (raw: string): { links?: LoginHeroLink[]; badLine?: number } => {
    const links: LoginHeroLink[] = [];
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const [i, line] of lines.entries()) {
      const match = line.match(/^(.+?)\s*\|\s*(https?:\/\/\S+)$/);
      const label = match?.[1]?.trim();
      const url = match?.[2];
      if (!label || !url) return { badLine: i + 1 };
      links.push({ label, url });
    }
    return links.length ? { links } : {};
  };

  const save = async () => {
    setStatus("saving");
    setError("");
    const parsed = parseLinks(hero.links);
    if (parsed.badLine !== undefined) {
      setError(t("settings.branding.loginHeroLineError", { line: parsed.badLine }));
      setStatus("error");
      return;
    }
    // Rebuild the selected locale's entry from the form, merge with the other
    // locales' stored entries, and clear the whole slot group (PUT null) when
    // nothing remains.
    const entry: LoginHeroEntry = {};
    if (hero.title.trim()) entry.title = hero.title.trim();
    if (hero.subtitle.trim()) entry.subtitle = hero.subtitle.trim();
    if (hero.imageUrl.trim()) entry.imageUrl = hero.imageUrl.trim();
    const points = hero.points.split("\n").map((p) => p.trim()).filter(Boolean);
    if (points.length) entry.points = points;
    if (parsed.links?.length) entry.links = parsed.links;
    const map = { ...(appConfig.loginHero ?? {}) };
    if (Object.keys(entry).length) map[heroLocale] = entry;
    else delete map[heroLocale];
    const loginHero = Object.keys(map).length ? map : null;
    try {
      const res = await fetch("/api/config/branding", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...values, loginHero }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      await loadAppConfig(); // refresh effective values without a server restart
      setStatus("saved");
    } catch (err) {
      setError(err instanceof Error ? err.message : "save failed");
      setStatus("error");
    }
  };

  const heroField = (
    key: keyof HeroForm,
    labelKey: string,
    testid: string,
    hintKey: string | undefined,
    textarea = false,
  ) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground">{t(labelKey)}</span>
      {textarea ? (
        <textarea
          value={hero[key]}
          rows={4}
          data-testid={testid}
          onChange={(e) => {
            setHero((h) => ({ ...h, [key]: e.target.value }));
            setStatus("idle");
          }}
          className={`${inputCls} resize-y`}
        />
      ) : (
        <input
          type="text"
          value={hero[key]}
          maxLength={500}
          data-testid={testid}
          onChange={(e) => {
            setHero((h) => ({ ...h, [key]: e.target.value }));
            setStatus("idle");
          }}
          className={inputCls}
        />
      )}
      {hintKey && <span className="text-xs text-muted-foreground">{t(hintKey)}</span>}
    </label>
  );

  return (
    <div className="flex flex-col gap-4 p-6" data-testid="settings-branding">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Paintbrush className="h-4 w-4" aria-hidden="true" />
        {t("settings.branding.title")}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{t("settings.branding.hint")}</p>
      {FIELDS.map(({ key, labelKey, hintKey }) => (
        <label key={key} className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-foreground">{t(labelKey)}</span>
          <input
            type="text"
            value={values[key]}
            maxLength={200}
            data-testid={`branding-${key}`}
            onChange={(e) => {
              setValues((v) => ({ ...v, [key]: e.target.value }));
              setStatus("idle");
            }}
            className={inputCls}
          />
          {hintKey && <span className="text-xs text-muted-foreground">{t(hintKey)}</span>}
        </label>
      ))}
      <div className="mt-2 flex flex-col gap-3 rounded-md border border-border p-4" data-testid="branding-hero">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs font-medium text-foreground">{t("settings.branding.loginHero")}</span>
          <select
            value={heroLocale}
            onChange={(e) => setHeroLocale(e.target.value as Locale)}
            data-testid="branding-hero-locale"
            className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground focus:border-primary focus:outline-none"
          >
            {SUPPORTED_LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_DISPLAY_NAMES[l]}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs leading-5 text-muted-foreground">{t("settings.branding.loginHeroHint")}</p>
        {heroField("title", "settings.branding.loginHeroTitle", "branding-hero-title", undefined)}
        {heroField("subtitle", "settings.branding.loginHeroSubtitle", "branding-hero-subtitle", undefined)}
        {heroField("imageUrl", "settings.branding.loginHeroImageUrl", "branding-hero-imageUrl", undefined)}
        {heroField("points", "settings.branding.loginHeroPoints", "branding-hero-points", t("settings.branding.loginHeroPointsHint"), true)}
        {heroField("links", "settings.branding.loginHeroLinks", "branding-hero-links", t("settings.branding.loginHeroLinksHint"), true)}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === "saving"}
          data-testid="branding-save"
          className="w-fit rounded-md bg-primary-deep px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary-deep/90 disabled:opacity-50"
        >
          {status === "saving" ? t("common.saving") : t("common.save")}
        </button>
        {status === "saved" && <span className="text-xs text-muted-foreground">{t("settings.branding.saved")}</span>}
        {status === "error" && (
          <span className="text-xs text-destructive" role="alert">
            {t("settings.branding.saveFailed", { error })}
          </span>
        )}
      </div>
    </div>
  );
}
