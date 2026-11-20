// App Center single source (openspec: add-app-center → app-center-unified-grid).
//
// Brand facts for the five lines live here (project-federation decision,
// docs/yizuo-platform-roadmap.md): introductions stay on each line's own
// site; the platform carries a one-liner + link only. `early` lines keep
// their link but wear an honest badge — never hide, never fake availability.
//
// The unified grid (app-center-unified-grid) merges these brand cards with
// the server catalog's products into ONE ordered list and derives each
// card's connection badge from /api/connections. Everything below is plain
// data + pure functions so scripts/test-app-center.mjs can import it under
// node --test — no React, no DOM.

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
    // add-lex-line-board: the line has a real board now — the "early" badge
    // would misstate availability (same rule as wire below; Q3 章程拍板=徽标随看板机制).
    status: "live",
  },
  {
    id: "wire",
    nameKey: "appCenter.line.wire.name",
    taglineKey: "appCenter.line.wire.tagline",
    url: "https://wire.finddatatech.cloud",
    // add-wire-line-board: the line has a real board now — the "early" badge
    // would misstate availability.
    status: "live",
  },
];

// A product as served by GET /api/catalog (`apps[]`). These are the product
// kinds a user can open — nango-connect joined with simplify-chat-and-agents-ia
// (the retired Agents-page Apps tab's entries all live here now); everything
// else in the catalog is an agent.
export interface CatalogApp {
  id: string;
  kind?: string;
  name?: string;
  url?: string;
  description?: string;
  embedded?: boolean;
  line?: string; // optional explicit brand attribution (GitOps-authored)
}

export const PRODUCT_KINDS = ["external-service", "link", "nango-connect"] as const;

export function isProductApp(app: CatalogApp): boolean {
  return (PRODUCT_KINDS as readonly string[]).includes(app.kind ?? "");
}

// Connection ids as projected by GET /api/connections (connection-center).
export type ConnectionId =
  | "registry"
  | "facet-market"
  | "connector"
  | "line-wire-customer"
  | "line-lex"
  | "ciyuan-account"
  | "paper-trading"
  | "search";

// Which connections each card needs, keyed by card id (brand or product).
// Attribution follows the HOST the connection is minted against, not the
// brand grouping of the settings connections section: `registry` mints at
// MARKET_REGISTRY_URL = mcp.finddatatech.cloud, which is the 壹座·智能体基础设施 card's
// url, so its badge lives there (design.md D3). Cards absent here show no
// badge. `search` is a platform service, not a product — never mapped.
export const APP_CONNECTIONS: Record<string, ConnectionId[]> = {
  "yizuo-packs": ["registry"],
  facet: ["facet-market"],
  "wanxing-token": ["ciyuan-account"],
  "wanxing-connector": ["connector"],
  lex: ["line-lex"],
  wire: ["line-wire-customer", "paper-trading"],
};

export interface BrandEntry {
  kind: "brand";
  id: string;
  brand: string; // the brand card belongs to itself
  nameKey: string;
  taglineKey: string;
  url: string | null;
  status: AppLineStatus;
  self: boolean;
  embedded: false;
  connections: ConnectionId[];
}

export interface ProductEntry {
  kind: "product";
  id: string;
  brand: string | null; // APP_LINES id this card belongs to; null → sorted last
  name: string; // authored in the catalog (id as fallback)
  description?: string;
  url: string | null;
  status: "live"; // the catalog carries no early flag
  self: false;
  embedded: boolean; // external-service with embedding allowed → in-app route
  connections: ConnectionId[];
  catalogKind?: string; // raw catalog kind — "nango-connect" drives the Connect action
}

export type AppGridEntry = BrandEntry | ProductEntry;

// Explicit `line` wins when it names a known brand; otherwise infer from the
// `<brand>-` id prefix; otherwise unattributed (sorted last).
export function brandOf(app: CatalogApp, lines: AppLine[] = APP_LINES): string | null {
  if (app.line && lines.some((l) => l.id === app.line)) return app.line;
  const hit = lines.find((l) => app.id.startsWith(`${l.id}-`));
  return hit ? hit.id : null;
}

export function buildAppGrid(lines: AppLine[], catalogApps: CatalogApp[] | null | undefined): AppGridEntry[] {
  const products: ProductEntry[] = (catalogApps ?? [])
    .filter(isProductApp)
    .map((app) => ({
      id: app.id,
      kind: "product" as const,
      brand: brandOf(app, lines),
      name: app.name || app.id,
      description: app.description || undefined,
      url: app.url ?? null,
      status: "live" as const,
      self: false as const,
      embedded: app.kind === "external-service" && app.embedded !== false,
      connections: APP_CONNECTIONS[app.id] ?? [],
      catalogKind: app.kind,
    }));

  const grid: AppGridEntry[] = [];
  for (const line of lines) {
    grid.push({
      id: line.id,
      kind: "brand" as const,
      brand: line.id,
      nameKey: line.nameKey,
      taglineKey: line.taglineKey,
      url: line.url,
      status: line.status,
      self: Boolean(line.self),
      embedded: false as const,
      connections: APP_CONNECTIONS[line.id] ?? [],
    });
    for (const p of products) if (p.brand === line.id) grid.push(p);
  }
  for (const p of products) if (p.brand === null) grid.push(p);
  return grid;
}

export type ConnectionState = "connected" | "stale" | "disconnected" | "not-configured";
export type AggregateState = "connected" | "partial" | "stale" | "disconnected";

// Fold a card's required connections into one badge state. `stale` wins over
// `partial` because re-connecting is the thing the user must act on now; an
// id the endpoint did not report counts as disconnected.
export function aggregateConnectionState(
  ids: readonly string[],
  statesById: Record<string, string | undefined>,
): AggregateState | null {
  if (ids.length === 0) return null;
  const states = ids.map((id) => statesById[id] ?? "disconnected");
  if (states.every((s) => s === "connected")) return "connected";
  if (states.some((s) => s === "stale")) return "stale";
  if (states.some((s) => s === "connected")) return "partial";
  return "disconnected";
}

// The connection the "connect" action should land on: the first one that is
// not connected, in declaration order. Null when everything is connected.
export function connectTargetFor(
  ids: readonly string[],
  statesById: Record<string, string | undefined>,
): string | null {
  return ids.find((id) => statesById[id] !== "connected") ?? null;
}

export function connectPathFor(connectionId: string): string {
  return `/settings/connections?panel=${encodeURIComponent(connectionId)}`;
}

// Lines that have a board, and the ONE connection that board itself needs
// (add-wire-line-board D7). Null = the board needs no credential. This is
// deliberately not the card's aggregate badge state: the wire card aggregates
// `paper-trading` too, which has nothing to do with the wire board.
export const BOARD_CREDENTIAL: Record<string, ConnectionId | null> = {
  facet: "facet-market",
  wanxing: null,
  wire: "line-wire-customer",
  // lex was the fourth adapter with a spec, a live walk-through and no way in:
  // the card never offered 看板, so /boards/lex was reachable only by typing
  // the URL (unify-line-board-tabs). Same credential the settings panel and
  // ActionCard already use for 识律.
  lex: "line-lex",
};

export function hasBoard(lineId: string): boolean {
  return Object.hasOwn(BOARD_CREDENTIAL, lineId);
}

// Whether the card should offer "看板" as its primary action: the deployment
// switch is on, the line has a board, and the board's own credential (if any)
// is connected. A missing/failed /api/connections projection counts as
// "not connected" for credential-bearing boards.
export function boardAvailable(
  lineId: string,
  statesById: Record<string, string | undefined> | null,
  lineBoardsEnabled: boolean,
): boolean {
  if (!lineBoardsEnabled || !hasBoard(lineId)) return false;
  const cred = BOARD_CREDENTIAL[lineId];
  if (cred === undefined) return false;
  if (cred === null) return true;
  return (statesById?.[cred] ?? "disconnected") === "connected";
}

export function boardPathFor(lineId: string): string {
  return `/boards/${encodeURIComponent(lineId)}`;
}
