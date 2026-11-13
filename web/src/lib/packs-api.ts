// packs-api.ts — typed client for the pack marketplace's two API planes
// (add-pack-marketplace):
//   - the GATEWAY's marketplace (/api/packs...): browse, detail, publish,
//     subscribe records — same-origin through the deployment's ingress;
//   - the CELL's local state (/api/mypacks..., /api/pack-drafts...): installed
//     packs, materialization, and creator drafts.
// The subscribe flow records on the market, then hands {packId, version} to
// the cell; the cell fetches the manifest server-side
// (pack-install-server-side-manifest — the browser never carries manifest
// bodies, which the edge WAF rejects).

import i18n from "@/i18n";

// Display locale for market/installed reads (add-pack-locale-tracks B): the
// server owns resolution and the zh fallback; the client only states its UI
// locale — no component ever picks fields or falls back on its own.
function localeQuery(): string {
  const lang = i18n?.language;
  return lang ? `?locale=${encodeURIComponent(lang)}` : "";
}

function withLocale(q: URLSearchParams): URLSearchParams {
  const lang = i18n?.language;
  if (lang) q.set("locale", lang);
  return q;
}

/** The optional structured display surface (specs/pack-display-format):
 *  identity seal override, one-line promise, audience/domain slugs, outcomes
 *  and actionable examples — all independently optional. */
export interface PackDisplayV2 {
  promise?: string;
  identity?: { mark?: { kind: string; value: string }; accent?: string };
  audience?: string[];
  outcomes?: { title: string; detail?: string }[];
  examples?: { title: string; prompt: string }[];
}

export interface PackSummary {
  id: string;
  authorEmail: string;
  createdAt: number;
  version: number;
  name: string;
  description: string;
  tags: string[];
  publishedAt: number;
  subscriberCount?: number;
  visibility?: "public" | "private";
  unlisted?: boolean;
  category?: string;
  /** 归位展示线词 (add-legacy-pack-rebrand 2.x): the browse facet groups by this,
   *  NOT by `category` (the stored slug stays the write/install identity, zero-migrated).
   *  Absent on pre-upgrade servers → the view falls back to category (pass-through). */
  line?: string;
  /** Locale-projected chip label for `line` (overhaul-market-catalog-presentation
   *  P0): zh requests project it identical to `line`; the canonical word above
   *  stays the filter identity the server expands back to slugs. Absent on
   *  pre-upgrade servers → the view falls back to `line` verbatim. */
  lineLabel?: string;
  /** Declared domain-axis slugs (overhaul-market-catalog-presentation P1). Present
   *  only when the pack declares a set; an undeclared pack omits the key. */
  domains?: string[];
  /** Structured display fields v2 (overhaul-market-catalog-presentation P3):
   *  the market projection carries them VERBATIM (locale-projected on the
   *  secondary track, 4.3) and only when the manifest declares them — a
   *  legacy pack omits the key entirely and the card's degradation chain
   *  behaves exactly as pre-P3. */
  display?: PackDisplayV2;
  featured?: boolean;
  /** Agents in the latest version's manifest (marketplace agent-size filter). */
  agentCount?: number;
  /** Skills / MCP references in the latest version's manifest — the card's
   *  obtainable-signals slot (overhaul-market-catalog-presentation P2). Same
   *  absent-means-unknown discipline as agentCount: a row whose SQL didn't
   *  project it keeps its pre-change shape, and the renderer omits the
   *  segment rather than showing zero. */
  skillCount?: number;
  mcpCount?: number;
  /** Facade flag (add-principal-facade): the latest version carries a facade
   *  block — the pack is a principal's conversational front door. */
  facade?: boolean;
  /** Official badge (add-official-pack-showcase): derived server-side from
   *  the deployment's author roster — never author-declared. Absent on
   *  pre-upgrade servers (pass-through, unfiltered). */
  official?: boolean;
  /** Adopted flag (add-official-adopted-agents): the latest version's manifest
   *  carries an adopted-provenance record. List rows project this in SQL the
   *  same way `facade` is projected; detail rows carry the full `provenance`
   *  object below. Combine with `official` to render 官方精选·已审校 — an
   *  adopted record alone never grants official status. */
  adopted?: boolean;
  /** Adopted provenance (add-official-adopted-agents): the SOURCE axis, kept
   *  orthogonal to `official` (roster) and `badge` (structure). Present only
   *  when the server's one projection says the pack reads as an adopted
   *  official asset or carries an adopted record; `source` names which kind.
   *  `community` never ships a key, so legacy payloads stay byte-identical. */
  provenance?: {
    source: "official-original" | "official-adopted" | "community";
    adopted?: {
      kind: "official-adopted";
      upstreamUrl: string;
      upstreamName: string;
      license: string;
      revision: string;
      adoptedBy: string;
      reviewedBy: string;
      reviewedAt: string;
    };
  };
  /** Structure-derived type badge (add-ai-native-lexicon): blueprint =
   *  fleet/cluster organization block; facade = facade block or a serving
   *  agent; assistant = agents only; toolkit = no agents. Computed by the
   *  registry at read time — authors cannot set or override it. */
  badge?: "blueprint" | "facade" | "assistant" | "toolkit";
  /** Vendor supply-open: server-projected attribution (present ONLY when the
   *  publisher declared a verified vendor binding; value comes from the live
   *  profile, never pack content). */
  vendor?: { slug: string; name: string };
  /** Market revenue share: 版本级价格声明(免费=无键, 与落地前逐字节). */
  pricing?: { priceUsd: number; kind: "once" | "period"; periodDays?: number };
}

export interface PackManifestSkill {
  name: string;
  description: string;
  content: string;
  // Skill package shape (add-packaged-skills): authoring surfaces carry the
  // inline map (relative path → text); the market DETAIL projection carries
  // the path inventory (string[]) — contents fetch per-file on demand.
  files?: Record<string, string> | string[];
  frontmatter?: Record<string, unknown>;
}

export interface PackManifestMcp {
  registryName: string;
  requiredGroup?: string;
  // Display description (add-mcp-annotation-overlay): the zh MAIN track text
  // for what this referenced server is for; the manifest i18n overlay covers
  // it per registryName, so what arrives here is already locale-projected
  // when the read face projected. Display only — never runtime config.
  description?: string;
  // Tool allowlist (add-mcp-tool-scoping): leaf names narrowing this
  // reference; absent = the server's full tool surface.
  allowTools?: string[];
  // Explicit full-surface marker (pack-tool-declaration-gate): mutually
  // exclusive with allowTools; the detail view discloses the reason.
  fullSurface?: boolean;
  fullSurfaceReason?: string;
}

export interface PackManifestAgent {
  id: string;
  name: string;
  persona: string;
  /** Short role blurb (catalog rows and cluster composer show it). */
  description?: string;
  // Optional serving contract (add-a2a-agent-serving): present ⇒ the role is
  // deployable as an Agent Service over A2A. model/modelWhitelist/budget are
  // the contract's declarations (ADR-0019 / add-serving-budgets) — the deploy
  // form surfaces them as the empty-input placeholder and the model picker's
  // narrowing domain.
  serving?: {
    protocol: string;
    card?: Record<string, unknown>;
    rhythm?: { every?: string; daily?: string; do?: string }[];
    model?: string;
    modelWhitelist?: string[];
    budget?: { turnMinutes: number };
  };
  tags?: string[];
  icon?: string;
  // Optional per-role resource declaration (add-persona-resource-sets): a
  // subset of the draft's OWN skills / MCP references. Absent dimension =
  // whole-pack set for it; present-but-empty = none.
  resources?: { skills?: string[]; mcpServers?: string[] };
}

// Usage guide (add-pack-tutorials-and-wizard): exactly three authored steps
// in the creator's own language; publish validates the shape server-side.
export interface PackGuideStep {
  title: string;
  body: string;
}

export interface PackGuide {
  steps: [PackGuideStep, PackGuideStep, PackGuideStep];
}

// Locale overlay (add-pack-locale-tracks): the base display fields ARE the zh
// main track; this block carries secondary-language overrides. The MARKET
// projects it server-side and answers in the requested locale — clients only
// send their UI locale and never resolve fields themselves.
export interface PackLocaleOverrides {
  name?: string;
  description?: string;
  notes?: string;
  guide?: PackGuide;
  skills?: Record<string, { description?: string }>;
  agents?: Record<
    string,
    {
      name?: string;
      serving?: {
        card?: {
          name?: string;
          description?: string;
          skills?: Record<string, { name?: string; description?: string }>;
        };
      };
    }
  >;
  bots?: Record<string, { name?: string; description?: string }>;
  cluster?: { name?: string; description?: string };
}

// Fleet template display overlay (same change, D5): display fields only —
// structure (members/cadence/kpiSlots keys/edges) is never localized.
export interface FleetLocaleOverrides {
  name?: string;
  members?: Record<string, { title?: string; kpiSlots?: Record<string, { label?: string }> }>;
}

export interface PackManifest {
  name: string;
  visibility?: "public" | "private";
  description?: string;
  // Version note (add-facet-version-history): optional human-readable note,
  // ≤500 chars, immutable with the published version that carries it.
  notes?: string;
  tags?: string[];
  guide?: PackGuide;
  skills?: PackManifestSkill[];
  mcpServers?: PackManifestMcp[];
  agents?: PackManifestAgent[];
  // Bot units (pack-bot-units): generic bot type references with an optional
  // single mounted skill. No credentials, endpoints or platform parameters
  // ever ride the manifest; the cell's operator configures the channel after
  // install.
  bots?: PackManifestBot[];
  // Cluster declaration (agent-cluster-platform): present when the pack
  // composes its agents into a shareable cluster — default vs optional
  // membership and an optional scheduling policy.
  cluster?: {
    name: string;
    description: string;
    defaultAgents: string[];
    optionalAgents?: string[];
    schedulingPolicy?: { maxConcurrentRuns?: number; preferredRunner?: string };
  };
  // Facade profile (add-principal-facade): present when the pack declares
  // itself a principal's conversational front door. The reception role must
  // be one of this pack's serving agents; the corpus names this pack's own
  // skills (versioned with the manifest — the as-of rides the publish time).
  // No identity claims ever ride the manifest: attribution is the platform's
  // author stamp (PackSummary.authorEmail).
  facade?: {
    reception: string;
    corpus: string[];
    delegation?: { kind: "in-pack" | "a2a"; ref: string }[];
    stance?: "hosted";
  };
  // Secondary-language display overrides (add-pack-locale-tracks): absent on
  // every pre-change manifest. Base fields above are the zh main track; the
  // server overlays this block when a locale is requested (the block itself
  // rides along untouched, so author tools can render the multi-locale source).
  i18n?: Record<string, PackLocaleOverrides>;
  // Fleet template section (agent-fleet-templates): display names + the
  // template's own display overlay; structure is validated server-side.
  fleet?: {
    name?: string;
    nameKey?: string;
    members?: { ref: string; title?: string; titleKey?: string }[];
    i18n?: Record<string, FleetLocaleOverrides>;
  };
  // Adopted provenance (add-official-adopted-agents D1): present only on a pack
  // whose content was adopted from an upstream third-party skill. A SOURCE
  // annotation, not an authority claim — it never grants official status (the
  // deployment roster does), and the server validator owns the shape.
  provenance?:
    | {
        kind: "official-adopted";
        upstreamUrl: string;
        upstreamName: string;
        license: string;
        revision: string;
        adoptedBy: string;
        reviewedBy: string;
        reviewedAt: string;
        // Fork lineage may ride an adopted record too (optional either way).
        forkOf?: { packId: string; version: number };
      }
    // Lineage-only block (add-agent-fork-lineage D1): a fork stamps WHERE it
    // came from with no kind — never a fabricated adopted record.
    | { forkOf: { packId: string; version: number }; license?: string };
}

// Bot units (pack-bot-units): the pack's third content primitive — a generic
// bot type reference (v1: "channel") with an optional mounted skill from the
// pack's own skills section.
export interface PackManifestBot {
  id: string;
  name: string;
  generic: string;
  description: string;
  skill?: string;
}

/** Server-side honest coverage of the ORG SURFACE for a secondary-track
 *  request (overhaul-market-catalog-presentation 4.11): same denominator as
 *  the publish gate (lib/pack-locale-coverage). Absent on zh requests — the
 *  main track IS the zh text. */
export interface PackLocaleCoverage {
  locale: string;
  total: number;
  covered: number;
  missing: string[];
}

export interface PackDetail extends PackSummary {
  manifest: PackManifest;
  coverage?: PackLocaleCoverage;
  /** Market revenue share: 登录调用者对当前版本的购买权益(付费条目才有键)。 */
  purchased?: boolean;
}

export type PackPartStatus =
  | "installed"
  | "reused"
  | "replaced"
  | "skipped"
  | "unavailable"
  // Local MCP binding (add-mcp-tool-scoping): the reference resolved to a
  // user-deployed server of the same name, or awaits one — neither is a
  // failure and neither blocks the rest of the pack.
  | "bound"
  | "awaiting-local-binding";

export interface PackReport {
  // add-packaged-skills (task 5.2): tree skills disclose their file count and
  // script file names; legacy single-document rows carry neither.
  skills: { name: string; status: PackPartStatus; reason?: string; fileCount?: number; scriptFiles?: string[] }[];
  mcpServers: { name: string; status: PackPartStatus; reason?: string; code?: string }[];
  agents: { id: string; name: string; status: PackPartStatus; reason?: string }[];
  // Bot units (pack-bot-units): optional because reports persisted before the
  // primitive carry no bots array — render `report.bots ?? []`.
  bots?: { id: string; name: string; status: PackPartStatus; reason?: string; awaitingCredential?: boolean }[];
}

export interface InstalledPack {
  packId: string;
  name: string;
  version: number;
  manifest: PackManifest;
  report: PackReport;
  installedAt: string;
  updatedAt: string;
  /** Where it came from: market | bundle (offline import / preinstalled
   *  starter). Absent on rows written before the column existed — read it as
   *  "market" and never block on it. */
  source?: string;
}

export interface PackDraft {
  id: string;
  name: string;
  description: string;
  tags: string[];
  entries: {
    skills?: PackManifestSkill[];
    mcpServers?: PackManifestMcp[];
    agents?: PackManifestAgent[];
    // Usage guide draft (add-pack-tutorials-and-wizard): rides the entries
    // JSON. Loose shape pre-validation (steps as authored, partial allowed);
    // the publish path lifts only a COMPLETE guide into the manifest, where
    // the strict three-tuple applies.
    guide?: { steps: { title: string; body: string }[] };
    // Adopted provenance draft (add-official-adopted-agents 1.4): an adoption
    // draft carries its audit trail here so the publish path lifts it into the
    // manifest. Plain authoring drafts never set it → byte-identical manifests.
    provenance?: PackManifest["provenance"];
    // Locale overlay draft (overhaul-market-catalog-presentation 4.7): the
    // workbench saves its en track here; the compiler lifts it verbatim.
    // Absent for plain drafts — byte-identical manifests.
    i18n?: Record<string, Record<string, unknown>>;
    // Domain/audience picks (4.8): vocabulary slugs as authored; out-of-table
    // legacy values ride untouched (保存零静默改写) and are blocked at publish.
    domain?: string[];
    audience?: string[];
  };
  publishedPackId: string | null;
  createdAt: string;
  updatedAt: string;
}

async function json(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.details?.[0]?.error || body?.error || `${res.status}`;
    const err = new Error(detail) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// ── Gateway (marketplace) ────────────────────────────────────────────────────

export function listPacks(
  params: {
    search?: string;
    tag?: string;
    category?: string;
    /** Domain-axis slug (overhaul-market-catalog-presentation P1). */
    domain?: string;
    author?: "me";
    page?: number;
    pageSize?: number;
    /** Admin-only widening (overhaul-facet-shell-ia-and-space): the curation
     *  board must reach unlisted packs too — the server ignores the flag for
     *  non-admins, so a caller cannot widen its own visibility. */
    includeUnlisted?: boolean;
  } = {},
) {
  const q = new URLSearchParams();
  if (params.search) q.set("search", params.search);
  if (params.tag) q.set("tag", params.tag);
  if (params.includeUnlisted) q.set("includeUnlisted", "1");
  if (params.category) q.set("category", params.category);
  if (params.domain) q.set("domain", params.domain);
  if (params.author) q.set("author", params.author);
  if (params.page) q.set("page", String(params.page));
  if (params.pageSize) q.set("pageSize", String(params.pageSize));
  return fetch(`/api/packs?${withLocale(q)}`).then(json) as Promise<{
    total: number;
    page: number;
    pageSize: number;
    packs: PackSummary[];
  }>;
}

/** Browse facets (P1 2.4): the DECLARED taxonomy with per-value counts — the
 *  facet chip set is never derived from whatever strings a page of rows carried.
 *  Lines are always the full declared set in declared order (zero-count lines
 *  included); domains list only non-zero values. */
export interface PackFacets {
  lines: { slug: string; word: string; label: string; count: number }[];
  domains: { slug: string; label: string; count: number }[];
  /** The full selectable vocabulary (including zero-count values) — the
   *  curation surface's picker source. Browse renders `domains` only. */
  vocabulary?: { slug: string; label: string }[];
}

// Workbench coverage read (4.7): the SAME server-side denominator as the
// publish gate and the audit — the client never re-derives what "covered"
// means. Pure read; shape-tolerant for half-authored drafts.
export function getPackCoverage(manifest: unknown, locale = "en"): Promise<{ coverage: PackLocaleCoverage }> {
  return fetch(`/api/packs/coverage${localeQuery()}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ manifest, locale }),
  }).then(json) as Promise<{ coverage: PackLocaleCoverage }>;
}

// 5.4 覆盖度看板：运营巡检面（鉴权读——含私有/下架条目的名字，策展板同姿势）。
export interface PackCoverageRow {
  id: string;
  name: string;
  total: number;
  covered: number;
  missing: string[];
}
export function getPackCoverageBoard(locale = "en"): Promise<{ packs: PackCoverageRow[] }> {
  return fetch(`/api/packs/curation/coverage?locale=${encodeURIComponent(locale)}`).then(json) as Promise<{
    packs: PackCoverageRow[];
  }>;
}

export function getPackFacets() {
  return fetch(`/api/packs/facets${localeQuery()}`).then(json) as Promise<PackFacets>;
}

export function getPack(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}${localeQuery()}`).then(json) as Promise<PackDetail>;
}

// Deploy the version's serving-contract roles as Agent Services
// (add-a2a-agent-serving 3.2): skills + one a2a agent entry land in the
// registry; the runner picks the bundle up by polling (≤ effectiveWithinSecs).
export interface DeployResult {
  deployed: { agentId: string; agentPath: string; skills: string[] }[];
  effectiveWithinSecs: number;
  // Connector bindings the deploy carried (add-deployment-binding-grant):
  // names and keys only — the token never leaves the platform side. `failed`
  // carries the reason code the deploy surface explains, and `revoked` counts
  // the tokens this deploy retired because the pack stopped declaring them.
  deploymentBindings?: DeployBindingReport;
}

export interface DeployBindingReport {
  granted: { agentId: string; bindingKey: string }[];
  failed: { agentId: string; bindingKey: string; code: string }[];
  revoked?: number;
}

export interface PackDeployment {
  agentId: string;
  version: number;
  agentPath: string;
  skills: string[];
  deployedBy: string;
  deployedAt: number;
  paused?: boolean;
}

// Billing reads (add-agent-platform-ops D3; revised by
// revise-billing-key-acquisition): the deploy surface's three-state readout —
// accountState "none" = no sub2api account yet (SSO at panelUrl creates it),
// "ok" = resolved (balance meaningful), null = billing unlinked (degraded).
export interface MyBillingState {
  linked: boolean;
  balance: number | null;
  accountState: "none" | "ok" | null;
  panelUrl?: string;
}

export function myBillingState(): Promise<MyBillingState> {
  return fetch("/api/packs/billing/me").then(json) as Promise<MyBillingState>;
}

// Facade matters (add-matter-threads): the principal's escalation queue —
// rows the reception's matter_open tool created, owner-visible only (the
// server filters to the caller's own deployments; strangers get an empty
// list, existence never disclosed). Timeline entries are
// {kind: open|reply|close, by: reception|owner, text, at}.
export interface FacadeMatter {
  id: string;
  packId: string;
  agentId: string;
  deployer: string;
  summary: string;
  visitorHint: string;
  status: "open" | "responded" | "closed";
  timeline: { kind: string; by: string; text: string; at: number }[];
  createdAt: number;
  updatedAt: number;
}

export function getFacadeMatters(id: string): Promise<{ matters: FacadeMatter[] }> {
  return fetch(`/api/packs/${encodeURIComponent(id)}/matters`).then(json) as Promise<{ matters: FacadeMatter[] }>;
}

export function replyFacadeMatter(id: string, matterId: string, text: string): Promise<{ matter: FacadeMatter }> {
  return fetch(`/api/packs/${encodeURIComponent(id)}/matters/${encodeURIComponent(matterId)}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then(json) as Promise<{ matter: FacadeMatter }>;
}

export function closeFacadeMatter(id: string, matterId: string, note?: string): Promise<{ matter: FacadeMatter }> {
  return fetch(`/api/packs/${encodeURIComponent(id)}/matters/${encodeURIComponent(matterId)}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(note ? { note } : {}) }),
  }).then(json) as Promise<{ matter: FacadeMatter }>;
}

// Per-pack key binding state: serving agentId → whether a key is bound.
// Booleans only — key values never leave the platform.
export function getBillingBindings(id: string): Promise<Record<string, boolean>> {
  return fetch(`/api/packs/${encodeURIComponent(id)}/billing-bindings`).then(json) as Promise<Record<string, boolean>>;
}

// Serving capability probe (add-selfhost-funnel-guidance, F3.1): false on a
// self-hosted instance without agent serving — the deploy surface renders the
// official-market guidance panel instead of the deploy form.
export function getServingStatus(): Promise<{ configured: boolean }> {
  return fetch("/api/packs/serving-status").then(json) as Promise<{ configured: boolean }>;
}

// Deploy with optional per-agent rhythm overrides (add-agent-residency D7):
// rhythms maps agentId → entry list; the descriptor records the override as
// the effective rhythm, the manifest default otherwise. billingKeys maps
// serving agentId → a pasted panel key ("sk-…"); omitting the field keeps
// existing bindings (the platform never echoes key values back).
// models/budgets (add-deploy-form-model-budget): the deploy-time model choice
// and per-turn budget ceiling per serving agent. Absent = the dimension is
// untouched — the deployment follows its preserved override when redeploying,
// else the contract declaration, else the platform default. The form never
// sends null: clearing an existing override is the serving config surface's
// act, not the deploy form's.
export function deployPack(
  id: string,

  version: number,
  rhythms?: Record<string, unknown>,
  billingKeys?: Record<string, string | null>,
  models?: Record<string, string>,
  budgets?: Record<string, number>,
) {
  const body: Record<string, unknown> = {};
  if (rhythms && Object.keys(rhythms).length > 0) body.rhythms = rhythms;
  if (billingKeys && Object.keys(billingKeys).length > 0) body.billingKeys = billingKeys;
  if (models && Object.keys(models).length > 0) body.models = models;
  if (budgets && Object.keys(budgets).length > 0) body.budgets = budgets;
  return fetch(`/api/packs/${encodeURIComponent(id)}/versions/${version}/deploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<DeployResult>;
}

// Pause/resume a deployed agent (add-agent-residency D5): the registry flag
// the runner polls; effective within the same five-minute window as deploy.
export function pauseDeployment(packId: string, agentId: string, paused: boolean) {
  return fetch(
    `/api/packs/${encodeURIComponent(packId)}/deployments/${encodeURIComponent(agentId)}/${paused ? "pause" : "resume"}`,
    { method: "POST" },
  ).then(json) as Promise<{ agentPath: string; paused: boolean; effectiveWithinSecs: number }>;
}

export function getPackDeployments(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/deployments`).then(json) as Promise<{
    deployments: PackDeployment[];
  }>;
}

export function publishPack(body: { packId?: string | null; manifest: PackManifest }) {
  return fetch("/api/packs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ id: string; version: number }>;
}

// ── Creator console + curation (add-facet-content-management) ────────────────

// Offline authoring (add-offline-pack-authoring): a draft exits as a
// `.yizpack` (base64 in JSON — the client turns it into a download), and a
// bundle comes back as a NEW editable draft. Export is NOT publish: no packId,
// no version freeze, no creator gate.
export function exportPackDraft(
  id: string,
  body: { manifest: PackManifest; packId?: string; version?: number },
): Promise<{ bundle: string; fileName: string; meta: { packId: string; version: number } }> {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}/export-bundle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ bundle: string; fileName: string; meta: { packId: string; version: number } }>;
}

export function importPackDraftBundle(body: { bundle: string }): Promise<{
  draft: PackDraft;
  bundle: { packId: string; version: number; origin: string | null };
}> {
  return fetch("/api/pack-drafts/import-bundle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ draft: PackDraft; bundle: { packId: string; version: number; origin: string | null } }>;
}

export function unpublishPack(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/unpublish`, { method: "POST" }).then(json);
}

export function setPackVisibility(id: string, visibility: "public" | "private") {
  return fetch(`/api/packs/${encodeURIComponent(id)}/visibility`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ visibility }),
  }).then(json);
}

export function setPackCuration(id: string, body: { category?: string; featured?: boolean; domains?: string[] }) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/curation`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json);
}

export interface PackVersionRow {
  version: number;
  publishedAt: number;
  authorEmail: string;
  // The version's note when its manifest carries one (the backend extracts
  // it inline so the list stays one round trip — add-facet-version-history).
  notes?: string;
}

export function listPackVersions(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/versions`).then(json) as Promise<{
    versions: PackVersionRow[];
  }>;
}

// A stored version is always retrievable under the listing's visibility —
// the row-expansion fetch for that version's skill bodies.
export function getPackVersion(id: string, version: number | string) {
  return fetch(
    `/api/packs/${encodeURIComponent(id)}/versions/${encodeURIComponent(String(version))}`,
  ).then(json) as Promise<{ version: number; manifest: PackManifest }>;
}

export function getPackUsageBoard(days = 7) {
  return fetch(`/api/ops/pack-usage?days=${days}`).then(json) as Promise<{
    windowDays: number;
    cellsSeen: number;
    rows: { packId: string | null; turns: number; activeUsers: number; lastUsedAt: number }[];
  }>;
}

export function subscribePack(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/subscribe`, { method: "POST" }).then(
    json,
  ) as Promise<{ packId: string; version: number; manifest: PackManifest }>;
}

export function unsubscribePackRecord(id: string) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/subscribe`, { method: "DELETE" }).then(json);
}

// ── Cell (installed state + materialization) ─────────────────────────────────

export function listInstalledPacks() {
  return fetch(`/api/mypacks${localeQuery()}`).then(json) as Promise<{ packs: InstalledPack[] }>;
}

// Install = materialize the version into this cell. Only {packId, version}
// crosses the wire (pack-install-server-side-manifest): the server retrieves
// the manifest from the market under the caller's identity. Manifest bodies
// must not ride browser POSTs — pack skills legally embed code/SQL and the
// deployment edge WAF resets such requests.
// add-packaged-skills: `confirm` is the script acknowledgment — a pack whose
// skills carry script files installs only with it (server-enforced 400 with
// code "script-confirm-required" otherwise; the dialog maps that to the
// one-time confirm and retries).
export function installPack(packId: string, version: number, confirm = false) {
  return fetch("/api/mypacks/install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId, version, ...(confirm ? { confirm: true } : {}) }),
  }).then(json) as Promise<{ report: PackReport; installed: InstalledPack }>;
}

export function uninstallPreview(packId: string) {
  return fetch(`/api/mypacks/${encodeURIComponent(packId)}/uninstall-preview`).then(json) as Promise<{
    packId: string;
    name: string;
    version: number;
    skills: string[];
    modifiedSkills: string[];
    agents: { id: string; name: string }[];
    mcpServersKept: string[];
  }>;
}

export function uninstallPack(packId: string, force: boolean) {
  return fetch(`/api/mypacks/${encodeURIComponent(packId)}?force=${force ? "1" : "0"}`, {
    method: "DELETE",
  }).then(json);
}

// ── Drafts (creator side, cell-local) ────────────────────────────────────────

export function listPackDrafts() {
  return fetch("/api/pack-drafts").then(json) as Promise<{ drafts: PackDraft[] }>;
}

export function createPackDraft(body: Partial<PackDraft>) {
  return fetch("/api/pack-drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(json) as Promise<{ draft: PackDraft }>;
}

export function updatePackDraft(id: string, patch: Partial<PackDraft>) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).then(json) as Promise<{ draft: PackDraft }>;
}

export function deletePackDraft(id: string) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}`, { method: "DELETE" }).then(json);
}

export function markDraftPublished(id: string, packId: string) {
  return fetch(`/api/pack-drafts/${encodeURIComponent(id)}/published`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ packId }),
  }).then(json) as Promise<{ draft: PackDraft }>;
}

// Dynamic cluster creation (agent-cluster-platform)
export interface CreateDynamicClusterRequest {
  name: string;
  description?: string;
  agents: Array<{
    packId: string;
    agentId: string;
    version?: string;
  }>;
  activateAll?: boolean;
  bindToSession?: boolean;
  /** The session to attach the cluster to (server-side binding key). */
  sessionId?: string;
}

export interface CreateDynamicClusterResponse {
  clusterId: string;
  status: "creating" | "ready" | "loading";
  name?: string;
  agents: Array<{
    packId: string;
    agentId: string;
    status: "active" | "installing";
  }>;
}

export function createDynamicCluster(
  request: CreateDynamicClusterRequest
): Promise<CreateDynamicClusterResponse> {
  return fetch("/api/clusters/dynamic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  }).then(json) as Promise<CreateDynamicClusterResponse>;
}

// ── Market revenue share (add-market-revenue-share) ──────────────────────────
// 价格与成交是版本级/服务端字段：免费条目无 pricing 键（落地前 payload
// 逐字节）。purchased 只在详情面（登录调用者）出现。

export interface PackPricing {
  priceUsd: number;
  kind: "once" | "period";
  periodDays?: number;
}

export interface MarketPurchase {
  id: string;
  packId: string;
  version: number;
  kind: "once" | "period";
  periodDays?: number | null;
  priceUsd: number;
  vendorSlug: string | null;
  vendorEarnedUsd: number;
  chargeUsd: number;
  creditUsd: number;
  direction: "purchase" | "refund";
  status: "pending" | "settled" | "failed";
  createdAt: number;
  note: string | null;
}

export interface VendorEarnings {
  earnings: { settledUsd: number; pendingUsd: number; creditSpentUsd: number; availableCreditUsd: number };
  purchases: MarketPurchase[];
}

export function purchasePack(id: string, useCredit = true) {
  return fetch(`/api/packs/${encodeURIComponent(id)}/purchase`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ useCredit }),
  }).then(json) as Promise<{ purchase: MarketPurchase; note?: string }>;
}

export function myMarketPurchases() {
  return fetch("/api/market/purchases/mine").then(json) as Promise<{
    purchases: MarketPurchase[];
    creditPools: { slug: string; settledUsd: number; availableCreditUsd: number }[];
  }>;
}

export function vendorEarnings(slug: string) {
  return fetch(`/api/vendors/${encodeURIComponent(slug)}/earnings`).then(json) as Promise<VendorEarnings>;
}

export function whoamiVendors() {
  return fetch("/api/whoami").then(json) as Promise<{ vendors: { slug: string; displayName: string; role: string }[] }>;
}
