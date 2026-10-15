// The Settings section registry — the single source of truth for what the
// modal contains. Both the modal chrome (the section list) and the router read
// this, so a section cannot exist in one and not the other.
//
// Slugs are public API: they appear in `/settings/:section` URLs that users
// bookmark and that legacy routes redirect to. Do not rename them. Retired
// slugs are kept resolving via `aliases` (same section, own sub-view) or via
// router redirects in App.tsx (`/settings/presets|packs` → the agents page).
//
// Sections render grouped (simplify-ia-non-technical): Basics — everyday
// preferences and paired surfaces; Capabilities — what the agent can use;
// Management — operational surfaces (channels, diagnostics, status, brand).
// The group is display metadata only; slugs, deep links, and lazy loading
// are unchanged.
//
// Components are lazy so opening the modal mounts only the active section.

import { lazy } from "react";
import {
  Activity,
  Bot,
  Globe,
  MonitorSmartphone,
  Paintbrush,
  Plug,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  UserRound,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

const GeneralSection = lazy(() =>
  import("@/components/settings/GeneralSection").then((m) => ({ default: m.GeneralSection })),
);
const AccountSection = lazy(() =>
  import("@/components/settings/AccountSection").then((m) => ({ default: m.AccountSection })),
);
const WeChatAppSection = lazy(() =>
  import("@/components/settings/WeChatAppSection").then((m) => ({ default: m.WeChatAppSection })),
);
const DevicesSection = lazy(() =>
  import("@/components/settings/DevicesSection").then((m) => ({ default: m.DevicesSection })),
);
const BrandingSection = lazy(() =>
  import("@/components/settings/BrandingSection").then((m) => ({ default: m.BrandingSection })),
);
const ModelsPage = lazy(() => import("@/pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const WebSearchSection = lazy(() =>
  import("@/components/settings/WebSearchSection").then((m) => ({ default: m.WebSearchSection })),
);
const ExtensionsPage = lazy(() =>
  import("@/pages/ExtensionsPage").then((m) => ({ default: m.ExtensionsPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const BotsPage = lazy(() => import("@/pages/BotsPage").then((m) => ({ default: m.BotsPage })));
const TracePage = lazy(() => import("@/pages/TracePage").then((m) => ({ default: m.TracePage })));

export type SettingsGroup = "basics" | "capabilities" | "management";

export interface SettingsSection {
  slug: string;
  // Alternate deep-link slugs that open this section. The merged Tools &
  // Skills section answers both `mcp` and the legacy `skills`, each slug
  // opening with its own sub-view active (aliasProps). Aliases keep retired
  // URLs resolving without changing the canonical slug.
  aliases?: string[];
  // Props applied when the section is opened via a given alias slug.
  aliasProps?: Record<string, Record<string, unknown>>;
  // Display group; the modal renders a heading when the group changes.
  group: SettingsGroup;
  labelKey: string;
  testId: string;
  icon: LucideIcon;
  Component: SettingsSectionComponent;
  // Props the section's component needs. ExtensionsPage serves the merged
  // Tools & Skills section and distinguishes its sub-view by this prop.
  props?: Record<string, unknown>;
  // Admin-only when auth is on (the `admin` group); visible to everyone when
  // auth is off. Matches the server-side gate on the section's routes.
  adminOnly?: boolean;
}

// Lazy settings sections carry heterogeneous prop shapes (each section owns
// its own); one escape hatch instead of scattered `any`s at every cast.
// biome-ignore lint/suspicious/noExplicitAny: section props are per-component and intentionally opaque here
type SettingsSectionComponent = React.LazyExoticComponent<React.ComponentType<any>>;

export const SETTINGS_SECTIONS: SettingsSection[] = [
  // ── Basics（常规）────────────────────────────────────────────────────────
  {
    slug: "general",
    group: "basics",
    labelKey: "settings.sections.general",
    testId: "settings-section-general",
    icon: SlidersHorizontal,
    Component: GeneralSection as SettingsSectionComponent,
  },
  {
    slug: "account",
    group: "basics",
    labelKey: "settings.sections.account",
    testId: "settings-section-account",
    icon: UserRound,
    Component: AccountSection as SettingsSectionComponent,
  },
  {
    slug: "wechat-app",
    group: "basics",
    labelKey: "settings.sections.wechat-app",
    testId: "settings-section-wechat-app",
    icon: Smartphone,
    Component: WeChatAppSection as SettingsSectionComponent,
  },
  {
    // Paired app devices (add-device-pairing-auth): pairing mint (digits +
    // QR carrying the instance origin) and the revocable device list.
    slug: "devices",
    group: "basics",
    labelKey: "settings.sections.devices",
    testId: "settings-section-devices",
    icon: MonitorSmartphone,
    Component: DevicesSection as SettingsSectionComponent,
  },
  // ── Capabilities（能力）──────────────────────────────────────────────────
  {
    // Merged Tools & Skills section: one surface, two sub-views. The
    // canonical `mcp` slug opens the tools view; the legacy `skills` slug
    // opens the skills view. Both keep every existing deep link alive.
    slug: "mcp",
    aliases: ["skills"],
    aliasProps: { skills: { type: "skills" } },
    group: "capabilities",
    labelKey: "settings.sections.mcp",
    testId: "settings-section-mcp",
    icon: Plug,
    Component: ExtensionsPage as SettingsSectionComponent,
    props: { type: "mcp" },
  },
  {
    // Network search (add-websearch-settings, per-user BYOK via
    // add-search-byok): every user manages their own search key; the shared
    // service zone renders only for admins (the server gates those endpoints
    // the same way), so the section itself is NOT adminOnly.
    slug: "websearch",
    group: "capabilities",
    labelKey: "settings.sections.websearch",
    testId: "settings-section-websearch",
    icon: Globe,
    Component: WebSearchSection as SettingsSectionComponent,
  },
  {
    slug: "models",
    group: "capabilities",
    labelKey: "settings.sections.models",
    testId: "settings-section-models",
    icon: Sparkles,
    Component: ModelsPage as SettingsSectionComponent,
  },
  // ── Management（管理）────────────────────────────────────────────────────
  {
    // Bot channels (企业微信/飞书/Telegram/微信公众号) — the former /bots
    // page, demoted from the sidebar nav. Ungated like its REST routes.
    slug: "channels",
    group: "management",
    labelKey: "settings.sections.channels",
    testId: "settings-section-channels",
    icon: Bot,
    Component: BotsPage as SettingsSectionComponent,
  },
  {
    // Per-turn trace list — the former /trace page. The /trace/:turnId
    // detail stays a top-level route (chat deep links land on it directly).
    slug: "diagnostics",
    group: "management",
    labelKey: "settings.sections.diagnostics",
    testId: "settings-section-diagnostics",
    icon: Waypoints,
    Component: TracePage as SettingsSectionComponent,
  },
  {
    slug: "status",
    group: "management",
    labelKey: "settings.sections.status",
    testId: "settings-section-status",
    icon: Activity,
    Component: DashboardPage as SettingsSectionComponent,
  },
  {
    slug: "branding",
    group: "management",
    labelKey: "settings.sections.branding",
    testId: "settings-section-branding",
    icon: Paintbrush,
    Component: BrandingSection as SettingsSectionComponent,
    adminOnly: true,
  },
];

export const DEFAULT_SECTION = "general";

export const settingsPath = (slug: string) => `/settings/${slug}`;

function sectionForSlug(slug: string | undefined): SettingsSection | undefined {
  if (!slug) return undefined;
  return SETTINGS_SECTIONS.find((s) => s.slug === slug || s.aliases?.includes(slug));
}

// True when `slug` addresses `section` — canonically or via an alias.
export function sectionMatchesSlug(section: SettingsSection, slug: string | undefined): boolean {
  if (!slug) return false;
  return section.slug === slug || section.aliases?.includes(slug) === true;
}

// Props for the slug the section was opened with: an alias may carry its own
// sub-view props (skills → the skills view of the merged section).
export function propsForSlug(section: SettingsSection, slug: string | undefined) {
  if (slug && section.slug !== slug && section.aliases?.includes(slug)) {
    return section.aliasProps?.[slug] ?? section.props;
  }
  return section.props;
}

// An unrecognized slug resolves to General rather than rendering an empty
// modal — see the settings-surface spec. Aliases resolve to their section.
export function resolveSection(slug: string | undefined): SettingsSection {
  return (
    sectionForSlug(slug) ??
    SETTINGS_SECTIONS.find((s) => s.slug === DEFAULT_SECTION)!
  );
}
