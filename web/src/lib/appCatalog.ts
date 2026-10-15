// The five product lines (寻数五线) rendered by the App Center — brand facts,
// single-sourced here. Introductions live on each line's own site; the
// platform carries a one-liner + link only (project-federation decision,
// docs/yizuo-platform-roadmap.md). `early` lines keep their link but wear an
// honest badge — never hide, never fake availability.

export type AppLineStatus = "live" | "early";

export interface AppLine {
  id: string;
  nameKey: string;
  taglineKey: string;
  url: string | null; // null = the platform itself; no outbound link
  status: AppLineStatus;
  self?: boolean;
}

export const APP_LINES: AppLine[] = [
  {
    id: "yizuo",
    nameKey: "appCenter.line.yizuo.name",
    taglineKey: "appCenter.line.yizuo.tagline",
    url: null,
    status: "live",
    self: true,
  },
  {
    id: "facet",
    nameKey: "appCenter.line.facet.name",
    taglineKey: "appCenter.line.facet.tagline",
    url: "https://facet.finddatatech.cloud",
    status: "live",
  },
  {
    id: "wanxing",
    nameKey: "appCenter.line.wanxing.name",
    taglineKey: "appCenter.line.wanxing.tagline",
    url: "https://wanxing.finddatatech.cloud",
    status: "live",
  },
  {
    id: "lex",
    nameKey: "appCenter.line.lex.name",
    taglineKey: "appCenter.line.lex.tagline",
    url: "https://lex.finddatatech.cloud",
    status: "early",
  },
  {
    id: "wire",
    nameKey: "appCenter.line.wire.name",
    taglineKey: "appCenter.line.wire.tagline",
    url: "https://wire.finddatatech.cloud",
    status: "early",
  },
];
