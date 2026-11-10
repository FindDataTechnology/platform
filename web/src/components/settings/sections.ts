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
  Cable,
  LayoutPanelLeft,
  MonitorSmartphone,
  Scale,
  Paintbrush,
  ShieldCheck,
  Inbox,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Users,
  type LucideIcon,
} from "lucide-react";

const GeneralSection = lazy(() =>
  import("@/components/settings/GeneralSection").then((m) => ({ default: m.GeneralSection })),
);
const DelegationSection = lazy(() =>
  import("@/components/settings/DelegationSection").then((m) => ({ default: m.DelegationSection })),
);
const MandateSection = lazy(() =>
  import("@/components/settings/MandateSection").then((m) => ({ default: m.MandateSection })),
);
const MandateIntakeSection = lazy(() =>
  import("@/components/settings/MandateIntakeSection").then((m) => ({ default: m.MandateIntakeSection })),
);
const AccountSection = lazy(() =>
  import("@/components/settings/AccountSection").then((m) => ({ default: m.AccountSection })),
);
const PairingSection = lazy(() =>
  import("@/components/settings/PairingSection").then((m) => ({ default: m.PairingSection })),
);
const StatusSection = lazy(() =>
  import("@/components/settings/StatusSection").then((m) => ({ default: m.StatusSection })),
);
const BrandingSection = lazy(() =>
  import("@/components/settings/BrandingSection").then((m) => ({ default: m.BrandingSection })),
);
const ModelsPage = lazy(() => import("@/pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const ConnectionsSection = lazy(() =>
  import("@/components/settings/ConnectionsSection").then((m) => ({ default: m.ConnectionsSection })),
);
const RolesSection = lazy(() =>
  import("@/components/settings/RolesSection").then((m) => ({ default: m.RolesSection })),
);
const LayoutSection = lazy(() =>
  import("@/components/settings/LayoutSection").then((m) => ({ default: m.LayoutSection })),
);

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
    // 配对与绑定 (restructure-yizuo-ia): `devices` + `wechat-app` merged — both
    // mint from the SAME single-use 5-minute code pool, so one section with
    // three tabs (小程序 / 桌面应用 / 机器) is one concept. The two old slugs stay
    // addressable and preselect their tab, because the QR codes already scanned
    // on users' phones encode those paths.
    slug: "pairing",
    aliases: ["devices", "wechat-app"],
    aliasProps: { devices: { tab: "app" }, "wechat-app": { tab: "wechat" } },
    group: "basics",
    labelKey: "settings.sections.pairing",
    testId: "settings-section-pairing",
    icon: MonitorSmartphone,
    Component: PairingSection as SettingsSectionComponent,
    props: { tab: "wechat" },
  },
  // ── Capabilities（能力）──────────────────────────────────────────────────
  {
    // Connections (settings-connect-center): the single home for user-level
    // credential connect cards and the search wiring — everything that lets a
    // capability work. First in the group: connecting precedes using.
    slug: "connections",
    group: "capabilities",
    labelKey: "settings.sections.connections",
    testId: "settings-section-connections",
    icon: Cable,
    Component: ConnectionsSection as SettingsSectionComponent,
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
    // Business roles (role-system): the user list with primary/secondary role
    // reassignment and the orthogonal admin flag. Admin-only when auth is on
    // (the REST routes are gated the same way).
    slug: "roles",
    group: "management",
    labelKey: "settings.sections.roles",
    testId: "settings-section-roles",
    icon: Users,
    Component: RolesSection as SettingsSectionComponent,
    adminOnly: true,
  },
  {
    // Workbench layout (layout-configuration): the deployment default preset,
    // per-role presets, and terminal per-surface hiding. Admin-only when auth
    // is on (the REST routes are gated the same way).
    slug: "layout",
    group: "management",
    labelKey: "settings.sections.layout",
    testId: "settings-section-layout",
    icon: LayoutPanelLeft,
    Component: LayoutSection as SettingsSectionComponent,
    adminOnly: true,
  },
  {
    // 委托策略 (add-deputy-decision-delegate): cell-level default for category
    // routing, severity ceiling and daily budget. It sat in this array from the
    // start but was MISSING from the surface registry, and the modal renders
    // only registry-resolved slugs — so it never rendered. Both lists now agree
    // (scripts/test-layout-registry-agreement.mjs pins it).
    slug: "delegation",
    group: "management",
    labelKey: "settings.sections.delegation",
    testId: "settings-section-delegation",
    icon: Scale,
    Component: DelegationSection as SettingsSectionComponent,
  },
  {
    // 委托状 (add-personal-mandate 6.1): the authority matrix — per-domain mode,
    // quota, expiry, revoke window, and the two independent scopes. Sits right
    // after `delegation` because it answers the next question: delegation says
    // *who* rules, the mandate says *how far* the agent may act.
    slug: "mandate",
    group: "management",
    labelKey: "settings.sections.mandate",
    testId: "settings-section-mandate",
    icon: ShieldCheck,
    Component: MandateSection as SettingsSectionComponent,
  },
  {
    // 事项接入与证据面 (widen-deputy-to-personal-domains 6.1/6.2): which matters
    // enter which domain, plus the consistency evidence for raising a domain's
    // autonomy. Separate slug from `mandate` on purpose — one is "how far may
    // it act", the other is "what reaches it", and conflating them is how a
    // routing switch gets mistaken for a permission switch.
    slug: "mandate-intake",
    group: "management",
    labelKey: "settings.sections.mandateIntake",
    testId: "settings-section-mandate-intake",
    icon: Inbox,
    Component: MandateIntakeSection as SettingsSectionComponent,
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
  {
    // 运行状态 (restructure-yizuo-ia): system health and the per-turn trace are
    // one question ("what is happening right now"), so `diagnostics` folded in
    // as a tab. `/trace` and `/settings/diagnostics` both open that tab.
    slug: "status",
    aliases: ["diagnostics"],
    aliasProps: { diagnostics: { tab: "trace" } },
    group: "management",
    labelKey: "settings.sections.status",
    testId: "settings-section-status",
    icon: Activity,
    Component: StatusSection as SettingsSectionComponent,
    props: { tab: "health" },
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
