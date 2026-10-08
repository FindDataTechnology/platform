// ── Icon component (lucide-react wrapper) ────────────────────────────────
//
// Lightweight wrapper that maps a stable icon-name string to a lucide-react
// icon. Keeps call sites declarative (data-driven names from catalog, etc.)
// without importing the full lucide icon set at every site. Icons render as
// inline SVG; props pass through to the underlying lucide component.
//
// Usage: <Icon name="database" size={20} className="text-muted-foreground" />
// Unknown names fall back to a neutral dot so the UI never crashes on a typo
// in catalog data (icons come from server-side config — not trusted input, but
// defensive anyway since a missing icon shouldn't break a whole card).

import { memo } from "react";
import {
  Database,
  BookOpen,
  LayoutDashboard,
  Upload,
  FileText,
  Search,
  CloudUpload,
  Folder,
  MessageSquare,
  AlertCircle,
  CheckCircle,
  Trash2,
  Plus,
  Pencil,
  X,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ExternalLink,
  Settings,
  Bot,
  Wrench,
  Code,
  Sparkles,
  Cpu,
  Shield,
  type LucideProps,
} from "lucide-react";

const ICONS: Record<string, React.ComponentType<LucideProps>> = {
  database: Database,
  "book-open": BookOpen,
  "layout-dashboard": LayoutDashboard,
  upload: Upload,
  "file-text": FileText,
  search: Search,
  "cloud-upload": CloudUpload,
  folder: Folder,
  "message-square": MessageSquare,
  "alert-circle": AlertCircle,
  "check-circle": CheckCircle,
  trash: Trash2,
  "trash-2": Trash2,
  plus: Plus,
  pencil: Pencil,
  x: X,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  "chevron-up": ChevronUp,
  "external-link": ExternalLink,
  settings: Settings,
  bot: Bot,
  wrench: Wrench,
  // Agent/app catalog icons — add more lucide names here as the catalog grows.
  // These map the `icon` field values in agents.json to rendered glyphs.
  code: Code,
  sparkles: Sparkles,
  cpu: Cpu,
  shield: Shield,
  // nango-connect / external-service kind icon
  plug: Wrench,
  app: LayoutDashboard,
};

interface IconProps extends LucideProps {
  name: string;
}

function IconBase({ name, ...rest }: IconProps) {
  const Cmp = ICONS[name];
  if (!Cmp) {
    // Defensive fallback: a tiny dot so a bad name never blanks a card.
    return <span className="inline-block h-4 w-4 rounded-full bg-current opacity-40" aria-hidden />;
  }
  return <Cmp {...rest} />;
}

export const Icon = memo(IconBase);
