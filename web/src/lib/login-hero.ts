// Login hero slot resolution (openspec: add-login-hero).
//
// The server exposes `loginHero` as a locale-keyed config object (deployment
// branding). This module is the single place that knows its shape and its
// resolution chain: current UI locale → `en` → none. It is deliberately
// dependency-free (types + pure functions only) so node --test can import it
// directly — scripts/test-login-hero.mjs locks the chain.

export interface LoginHeroLink {
  label: string;
  url: string;
}

export interface LoginHeroEntry {
  title?: string;
  subtitle?: string;
  points?: string[];
  imageUrl?: string;
  links?: LoginHeroLink[];
}

// Partial map: at least one locale entry, never empty, when present at all.
export type LoginHeroConfig = Partial<Record<string, LoginHeroEntry>>;

// What the login page actually renders: the hero panel (null when the resolved
// entry carries no presentational content) and the link row (independent — a
// links-only deployment still gets its row under the card).
export interface ResolvedLoginHero {
  hero: { title: string; subtitle: string; points: string[]; imageUrl: string | null } | null;
  links: LoginHeroLink[] | null;
}

// Defensive parse of whatever /api/config returned: unknown locales and
// unknown fields are dropped (reader-lenient), malformed entries vanish
// rather than break the page, and nothing usable remains → null (the
// unconfigured / neutral login card).
export function parseLoginHero(input: unknown): LoginHeroConfig | null {
  if (typeof input !== "object" || input === null) return null;
  const str = (v: unknown, max: number): string | undefined => {
    if (typeof v !== "string") return undefined;
    const s = v.trim();
    return s && s.length <= max ? s : undefined;
  };
  let any = false;
  const out: LoginHeroConfig = {};
  for (const [locale, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (typeof rawValue !== "object" || rawValue === null) continue;
    const raw = rawValue as Record<string, unknown>;
    const entry: LoginHeroEntry = {};
    const title = str(raw.title, 120);
    const subtitle = str(raw.subtitle, 200);
    const imageUrl = str(raw.imageUrl, 500);
    if (title) entry.title = title;
    if (subtitle) entry.subtitle = subtitle;
    if (imageUrl && /^https?:\/\//.test(imageUrl)) entry.imageUrl = imageUrl;
    const rawPoints: unknown[] = Array.isArray(raw.points) ? raw.points : [];
    const points = rawPoints
      .map((p) => str(p, 120))
      .filter((p): p is string => Boolean(p))
      .slice(0, 4);
    if (points.length) entry.points = points;
    const rawLinks: unknown[] = Array.isArray(raw.links) ? raw.links : [];
    const links = rawLinks
      .map((l): LoginHeroLink | null => {
        if (typeof l !== "object" || l === null) return null;
        const label = str((l as Record<string, unknown>).label, 40);
        const url = str((l as Record<string, unknown>).url, 500);
        if (!label || !url || !/^https?:\/\//.test(url)) return null;
        return { label, url };
      })
      .filter((l): l is LoginHeroLink => l !== null)
      .slice(0, 4);
    if (links.length) entry.links = links;
    if (Object.keys(entry).length) {
      out[locale] = entry;
      any = true;
    }
  }
  return any ? out : null;
}

// Resolution chain (design D2): the current locale's entry, else `en`'s, else
// nothing. One entry wins as a whole — fields are never mixed across locales.
export function resolveLoginHero(config: LoginHeroConfig | null, locale: string): ResolvedLoginHero {
  const entry = config?.[locale] ?? config?.en ?? null;
  if (!entry) return { hero: null, links: null };
  const hasContent = Boolean(entry.title || entry.subtitle || entry.points?.length || entry.imageUrl);
  const hero = hasContent
    ? {
        title: entry.title ?? "",
        subtitle: entry.subtitle ?? "",
        points: entry.points ?? [],
        imageUrl: entry.imageUrl ?? null,
      }
    : null;
  return { hero, links: entry.links?.length ? entry.links : null };
}
