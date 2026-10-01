// The Settings section registry — the single source of truth for what the
// modal contains. Both the modal chrome (the section list) and the router read
// this, so a section cannot exist in one and not the other.
//
// Slugs are public API: they appear in `/settings/:section` URLs that users
// bookmark and that legacy routes redirect to. Do not rename them.
//
// Components are lazy so opening the modal mounts only the active section.

import { lazy } from "react";
import {
  SlidersHorizontal,
  Sparkles,
  Plug,
  TerminalSquare,
  Activity,
  UserRound,
  UserRoundPlus,
  Smartphone,
  Paintbrush,
  Package,
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
const BrandingSection = lazy(() =>
  import("@/components/settings/BrandingSection").then((m) => ({ default: m.BrandingSection })),
);
const ModelsPage = lazy(() => import("@/pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const ExtensionsPage = lazy(() =>
  import("@/pages/ExtensionsPage").then((m) => ({ default: m.ExtensionsPage })),
);
const DashboardPage = lazy(() =>
  import("@/pages/DashboardPage").then((m) => ({ default: m.DashboardPage })),
);
const PacksPage = lazy(() => import("@/pages/PacksPage").then((m) => ({ default: m.PacksPage })));
const CustomPresetsPage = lazy(() =>
  import("@/pages/CustomPresetsPage").then((m) => ({ default: m.CustomPresetsPage })),
);

export interface SettingsSection {
  slug: string;
  labelKey: string;
  testId: string;
  icon: LucideIcon;
  Component: React.LazyExoticComponent<React.ComponentType<any>>;
  // Props the section's component needs. ExtensionsPage serves two sections
  // and distinguishes them by this prop.
  props?: Record<string, unknown>;
  // Admin-only when auth is on (the `admin` group); visible to everyone when
  // auth is off. Matches the server-side gate on the section's routes.
  adminOnly?: boolean;
  // Pack marketplace (add-pack-marketplace): hidden unless /api/config
  // reports packMarketplace (gateway-fronted deployments only — design D15).
  requiresPackMarketplace?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  {
    slug: "general",
    labelKey: "settings.sections.general",
    testId: "settings-section-general",
    icon: SlidersHorizontal,
    Component: GeneralSection as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "account",
    labelKey: "settings.sections.account",
    testId: "settings-section-account",
    icon: UserRound,
    Component: AccountSection as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "models",
    labelKey: "settings.sections.models",
    testId: "settings-section-models",
    icon: Sparkles,
    Component: ModelsPage as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "mcp",
    labelKey: "settings.sections.mcp",
    testId: "settings-section-mcp",
    icon: Plug,
    Component: ExtensionsPage as React.LazyExoticComponent<React.ComponentType<any>>,
    props: { type: "mcp" },
  },
  {
    slug: "skills",
    labelKey: "settings.sections.skills",
    testId: "settings-section-skills",
    icon: TerminalSquare,
    Component: ExtensionsPage as React.LazyExoticComponent<React.ComponentType<any>>,
    props: { type: "skills" },
  },
  {
    slug: "packs",
    labelKey: "settings.sections.packs",
    testId: "settings-section-packs",
    icon: Package,
    Component: PacksPage as React.LazyExoticComponent<React.ComponentType<any>>,
    requiresPackMarketplace: true,
  },
  {
    // Custom presets (add-custom-presets): the cell's user-composed focused
    // roles. Roster-level management — visible to every authenticated user
    // (the roster is deployment-global), never gated on the pack marketplace.
    slug: "presets",
    labelKey: "settings.sections.presets",
    testId: "settings-section-presets",
    icon: UserRoundPlus,
    Component: CustomPresetsPage as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "wechat-app",
    labelKey: "settings.sections.wechat-app",
    testId: "settings-section-wechat-app",
    icon: Smartphone,
    Component: WeChatAppSection as React.LazyExoticComponent<React.ComponentType<any>>,
  },
  {
    slug: "branding",
    labelKey: "settings.sections.branding",
    testId: "settings-section-branding",
    icon: Paintbrush,
    Component: BrandingSection as React.LazyExoticComponent<React.ComponentType<any>>,
    adminOnly: true,
  },
  {
    slug: "status",
    labelKey: "settings.sections.status",
    testId: "settings-section-status",
    icon: Activity,
    Component: DashboardPage as React.LazyExoticComponent<React.ComponentType<any>>,
  },
];

export const DEFAULT_SECTION = "general";

export const settingsPath = (slug: string) => `/settings/${slug}`;

// An unrecognized slug resolves to General rather than rendering an empty
// modal — see the settings-surface spec.
export function resolveSection(slug: string | undefined): SettingsSection {
  return (
    SETTINGS_SECTIONS.find((s) => s.slug === slug) ??
    SETTINGS_SECTIONS.find((s) => s.slug === DEFAULT_SECTION)!
  );
}
