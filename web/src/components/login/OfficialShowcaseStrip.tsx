// OfficialShowcaseStrip — the pre-login official-assets section
// (add-official-pack-showcase). Reads GET /api/packs/official (anonymous by
// contract: public-face fields only). A failed or EMPTY answer renders
// NOTHING — the login page must never break or clutter on an unconfigured
// deployment; the honest empty is the endpoint's 200-empty, tested
// server-side. Cards never trigger writes: clicking one surfaces the
// sign-in guidance line (spec: 登录墙前看官方资产).

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";

interface ShowcasePack {
  id: string;
  name: string;
  description: string;
  official: boolean;
}

interface Showcase {
  templates: ShowcasePack[];
  assistants: ShowcasePack[];
  featured: ShowcasePack[];
}

export function OfficialShowcaseStrip({ testId = "login-official" }: { testId?: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Showcase | null>(null);
  const [hintFor, setHintFor] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/packs/official")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((body: Showcase) => {
        if (!alive) return;
        const empty = !body?.templates?.length && !body?.featured?.length && !body?.assistants?.length;
        setData(empty ? null : body);
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!data) return null;
  const templates = data.templates.slice(0, 3);
  const featured = data.featured.filter((p) => p.official).slice(0, 2);
  const cards = [
    ...templates.map((p) => ({ ...p, kind: "template" as const })),
    ...featured.map((p) => ({ ...p, kind: "featured" as const })),
  ];
  if (cards.length === 0) return null;

  return (
    <div className="w-full max-w-md" data-testid={testId}>
      <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        {t("loginHero.official.title")}
      </p>
      <div className="mt-2 grid gap-2">
        {cards.map((c) => (
          <button
            key={`${c.kind}-${c.id}`}
            type="button"
            data-testid={`${testId}-card-${c.id}`}
            onClick={() => setHintFor(c.id)}
            className="rounded-md border border-border bg-card/70 p-2.5 text-left transition-colors hover:border-primary/40"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium text-foreground">{c.name}</span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                {c.kind === "template" ? t("loginHero.official.kindTemplate") : t("loginHero.official.kindFeatured")}
              </span>
            </span>
            <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">{c.description}</span>
          </button>
        ))}
      </div>
      {hintFor ? (
        <p className="mt-2 text-xs text-primary" data-testid={`${testId}-hint`}>
          {t("loginHero.official.hint")}
        </p>
      ) : null}
    </div>
  );
}
