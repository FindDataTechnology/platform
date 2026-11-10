// ── Board adapters (add-line-boards-and-action-gate, task 8) ────────────────
//
// Interface for line boards: each board is a set of blocks that render the
// state of a product line. Data comes from server-side REST calls (no model).
// Each block can fail independently without breaking the whole page.
//
// Block types: metrics (single value), list (rows), timeline (events).
//
// Usage: GET /api/boards/:line returns { blocks: [...] } where each block
// has { id, type, title, data?, error? }.

import * as lineCredentials from "../line-credentials.js";
import * as facetMarketCredentials from "../facet-market-credentials.js";
import { connectPathForRef } from "../credential-refs.js";

// Deployment switch for every board surface (add-wire-line-board D8). Default
// OFF: the sister change's migration plan promised this lever; the server
// route, /api/config projection and the web entry points all read it.
export function lineBoardsEnabled(env = process.env) {
  return env.LINE_BOARDS_ENABLED === "1";
}

// Kill switch for the copilot dock (add-line-boards-and-action-gate task 8.3).
// Default ON — the dock shipped before the lever existed, so the lever must
// not hide it on deployments that never set the variable; "0" is the only
// value that turns it off. Read per request like the boards switch.
export function copilotEnabled(env = process.env) {
  return env.COPILOT_ENABLED !== "0";
}

/**
 * Board adapter interface. Implementations return an array of blocks.
 */
export class BoardAdapter {
  constructor({ id, title, originUrl }) {
    this.id = id;
    this.title = title;
    this.originUrl = originUrl;
  }

  /**
   * Fetch all blocks for this board. Returns { blocks: [...] } or throws.
   * Each block may have an error field if it failed to load.
   */
  async fetchBlocks(_ctx) {
    throw new Error("Not implemented");
  }
}

/**
 * The tab set a board renders, derived from the blocks the adapter returned
 * (unify-line-board-tabs D1). De-duplicated, first-appearance order — the
 * adapter's own declaration order is the only ordering authority, so a line
 * cannot end up with a tab the adapter never fills, or miss one it does.
 *
 * Tab-less blocks (older adapters) contribute nothing: the page keeps its
 * normalized-id fallback for them, and inventing a tab named after a block id
 * would introduce a second vocabulary for the same thing.
 */
export function tabsOfBlocks(blocks = []) {
  const tabs = [];
  for (const block of blocks) {
    const tab = typeof block?.tab === "string" ? block.tab.trim() : "";
    if (tab && !tabs.includes(tab)) tabs.push(tab);
  }
  return tabs;
}

/**
 * Facet board adapter (task 8.1; real data per fix-line-boards-ux D4).
 *
 * Reads the facet market with the USER's own facet-market credential — the
 * same lane the install surface uses (facet-market-credentials). No token →
 * the not-connected card (wire's pattern), never private data.
 *
 * What is real and what is honestly under construction:
 *   my_packs        GET /api/packs?author=me          (real)
 *   publish_history GET /api/packs/:id/versions ×N    (real, bounded fan-out)
 *   recent_events   derived from the same version rows (real)
 *   overview_metrics NO user-readable install/active
 *                    endpoint exists on the market →
 *                    `under_construction` sentinel, never a fake zero
 *                    (the historical camelCase placeholder pair was removed
 *                    in the 2026-11-02 audit — the spec forbids fabricated
 *                    data).
 * Every block carries a `tab` field (the page's tab contract, D2) and metric
 * blocks use stable snake_case data keys the renderer localizes via
 * board.metric.<key> (D3) — so the page never guesses block ownership by id
 * substring and never prints a raw key as a label.
 */
export const FACET_ORIGIN = "https://facet.finddatatech.cloud";
export const FACET_MARKET_CREDENTIAL = facetMarketCredentials.FACET_MARKET_CREDENTIAL_REF;
// Bounded versions fan-out: five recent packs answer the history/timeline
// blocks; a deeper console stays one deep link away (原站深链 doctrine).
const FACET_HISTORY_PACK_LIMIT = 5;

class FacetUpstreamError extends Error {
  constructor(status, path, detail) {
    super(`facet ${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

export class FacetBoardAdapter extends BoardAdapter {
  constructor({ id = "facet", title = "谦面", originUrl = FACET_ORIGIN, apiBase = null, deps = {} } = {}) {
    super({ id, title, originUrl });
    this.apiBase = String(apiBase || facetMarketCredentials.facetMarketUrl()).replace(/\/+$/, "");
    this.deps = {
      fetch: (...a) => globalThis.fetch(...a),
      liveToken: facetMarketCredentials.liveToken,
      markInvalid: facetMarketCredentials.markInvalid,
      timeoutMs: 20_000,
      ...deps,
    };
  }

  consoleUrl(view) {
    // facet web is hash-addressed (#/mine is the creator console).
    return `${this.originUrl}/#/${view}`;
  }

  unconnected(reason) {
    const expired = reason === "expired";
    return {
      connected: false,
      reason,
      connectPath: connectPathForRef(FACET_MARKET_CREDENTIAL),
      blocks: [
        {
          id: "connection",
          type: "metrics",
          tab: "overview",
          title: "连接状态",
          data: { connected: false },
          error: expired ? "谦面登录已过期：重新进入连接页即可重新授权" : "未连接谦面：请先在设置 → 连接中授权",
        },
      ],
    };
  }

  async fetchBlocks(ctx) {
    const email = String(ctx?.email || "").trim();
    const token = this.deps.liveToken(email);
    if (!token) return this.unconnected("not_connected");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const get = async (path) => {
      let res;
      try {
        res = await this.deps.fetch(`${this.apiBase}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new FacetUpstreamError(0, path, "aborted");
        throw new FacetUpstreamError(0, path, err?.message || "unreachable");
      }
      if (res.status === 401) {
        controller.abort();
        throw new FacetUpstreamError(401, path);
      }
      if (!res.ok) throw new FacetUpstreamError(res.status, path, await safeText(res));
      return res.json();
    };

    let packs = [];
    let packsError = null;
    try {
      const mine = await get(`/api/packs?author=me&pageSize=50`);
      packs = Array.isArray(mine?.packs) ? mine.packs : [];
    } catch (err) {
      if (err instanceof FacetUpstreamError && err.status === 401) {
        clearTimeout(timer);
        this.deps.markInvalid(email);
        return this.unconnected("expired");
      }
      packsError = err;
    }

    // Bounded versions fan-out for the history + events blocks (only when the
    // pack list landed — per-block degradation otherwise). The abort timer
    // stays armed across the whole fan-out.
    const versionRows = [];
    if (!packsError) {
      const settled = await Promise.allSettled(
        packs.slice(0, FACET_HISTORY_PACK_LIMIT).map(async (p) => {
          const v = await get(`/api/packs/${encodeURIComponent(p.id)}/versions`);
          return (Array.isArray(v?.versions) ? v.versions : []).map((row) => ({
            ...row,
            packId: p.id,
            packName: p.name ?? p.id,
          }));
        }),
      );
      for (const s of settled) if (s.status === "fulfilled") versionRows.push(...s.value);
    }
    clearTimeout(timer);
    versionRows.sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));

    const overviewHref = this.consoleUrl("mine");
    const blocks = [
      {
        id: "overview_metrics",
        type: "metrics",
        tab: "overview",
        title: "概览",
        // Real counts derived from the market's existing read face. The
        // historical weekly-active/total-installs metrics had NO endpoint
        // behind them (2026-11-02 probe, design D4 open question resolved) —
        // they are gone rather than faked; what renders is counted from data
        // this session actually fetched.
        data: packsError ? undefined : { my_packs: packs.length, published_versions: versionRows.length },
        href: overviewHref,
        ...(packsError ? { error: facetBlockError(packsError) } : {}),
      },
      packsError
        ? { id: "my_packs", type: "list", tab: "my-packs", title: "我的包", error: facetBlockError(packsError), href: overviewHref }
        : {
            id: "my_packs",
            type: "list",
            tab: "my-packs",
            title: "我的包",
            href: overviewHref,
            data: packs.map((p) => ({
              id: p.id,
              title: p.name ?? p.id,
              subtitle: p.description ?? "",
              badges: [`v${p.version ?? 1}`, p.visibility === "private" ? "私有" : "公开"].filter(Boolean),
              href: `${this.originUrl}/#/packs?q=${encodeURIComponent(p.name ?? p.id)}`,
            })),
            actions: [
              { id: "facet.pack.publish", label: "发布新包", args: {} },
              { id: "facet.pack.visibility", label: "管理可见性", args: {} },
            ],
          },
      {
        id: "recent_events",
        type: "timeline",
        tab: "overview",
        title: "最近事件",
        href: overviewHref,
        data: versionRows.slice(0, 5).map((v) => ({
          id: `${v.packId}:${v.version}`,
          text: `${v.packName} · v${v.version}${v.notes ? ` · ${v.notes}` : ""}`,
          created_at: v.publishedAt,
          href: overviewHref,
        })),
      },
      packsError
        ? { id: "publish_history", type: "timeline", tab: "publish-history", title: "发布记录", error: facetBlockError(packsError), href: overviewHref }
        : versionRows.length === 0
          ? { id: "publish_history", type: "timeline", tab: "publish-history", title: "发布记录", data: [], href: overviewHref }
          : {
              id: "publish_history",
              type: "timeline",
              tab: "publish-history",
              title: "发布记录",
              href: overviewHref,
              data: versionRows.map((v) => ({
                id: `${v.packId}:${v.version}`,
                text: `${v.packName} · v${v.version}${v.notes ? ` · ${v.notes}` : ""}`,
                created_at: v.publishedAt,
                href: overviewHref,
              })),
            },
    ];

    return { connected: true, blocks };
  }
}

function facetBlockError(err) {
  if (err instanceof FacetUpstreamError) {
    if (err.status === 0) return "谦面服务不可达";
    return `谦面返回 HTTP ${err.status}`;
  }
  return err?.message || "加载失败";
}

/**
 * Wanxing board adapter (task 9).
 * Blocks organized by tab:
 *   - fleet-summary: deployment count, active agents, recent turns/cost
 *   - missions: mission list with status/cost/progress
 *   - deployments: agent deployment list
 */
export class WanxingBoardAdapter extends BoardAdapter {
  async fetchBlocks(_ctx) {
    // The wanxing facade has no credential lane wired into this adapter yet;
    // until it is, every block says so honestly (fix-line-boards-ux: the
    // board's own spec forbids fabricated data — the historical placeholder
    // zeros are removed the same way facet's were).
    return {
      blocks: [
        {
          id: "fleet_summary_metrics",
          type: "metrics",
          tab: "fleet-summary",
          title: "集群概况",
          error: "under_construction",
        },
        {
          id: "missions",
          type: "list",
          tab: "missions",
          title: "任务",
          error: "under_construction",
        },
        {
          id: "deployments",
          type: "list",
          tab: "deployments",
          title: "部署",
          error: "under_construction",
          actions: [
            { id: "wanxing.agent.deploy", label: "部署新 agent", args: {} },
            { id: "wanxing.agent.pause", label: "暂停 agent", args: {} },
          ],
        },
      ],
    };
  }
}

/**
 * Wire (柏讯) board adapter (add-wire-line-board, design D1) — the first
 * adapter that reads real upstream data.
 *
 * Connection truth is the user's wire-customer ID token (liveToken), not the
 * presence of an email. Every block is fetched from the customer-facing REST
 * with that bearer; blocks fail independently. A 401 from any block means the
 * token is dead: the credential cache is cleared (the browser re-mints on the
 * next visit), the remaining requests are aborted, and the whole board reports
 * "not connected / re-authorize" — never a stale-key "paste again" prompt.
 *
 * Blocks (ids carry the tab name the page filters on):
 *   overview_metrics   datasets / artifacts / demands counts (+ free-tier quota)
 *   datasets_list      GET /api/v1/datasets
 *   artifacts_list     GET /api/v1/artifacts   (row actions: publish / archive)
 *   demands_timeline   GET /api/v1/demands     (newest first)
 */
export const WIRE_ORIGIN = "https://wire.finddatatech.cloud";
export const WIRE_LINE_CREDENTIAL = lineCredentials.WIRE_CUSTOMER_CREDENTIAL_REF;

class UpstreamError extends Error {
  constructor(status, path, detail) {
    super(`wire ${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

export class WireBoardAdapter extends BoardAdapter {
  constructor({ id = "wire", title = "柏讯", originUrl = WIRE_ORIGIN, apiBase = null, deps = {} } = {}) {
    super({ id, title, originUrl });
    this.apiBase = String(apiBase || process.env.WIRE_API_BASE_URL || originUrl).replace(/\/+$/, "");
    this.deps = {
      fetch: (...a) => globalThis.fetch(...a),
      liveToken: lineCredentials.liveToken,
      markInvalid: lineCredentials.markInvalid,
      timeoutMs: 20_000,
      ...deps,
    };
  }

  consoleUrl(section) {
    return `${this.originUrl}/#/console/${section}`;
  }

  unconnected(reason) {
    const expired = reason === "expired";
    return {
      connected: false,
      reason,
      connectPath: connectPathForRef(WIRE_LINE_CREDENTIAL),
      blocks: [
        {
          id: "connection",
          type: "metrics",
          tab: "overview",
          title: "连接状态",
          data: { connected: false },
          error: expired ? "柏讯登录已过期：重新进入连接页即可重新授权" : "未连接柏讯：请先在设置 → 连接中授权",
        },
      ],
    };
  }

  async fetchBlocks(ctx) {
    const email = String(ctx?.email || "").trim();
    const token = this.deps.liveToken(email, WIRE_LINE_CREDENTIAL);
    if (!token) return this.unconnected("not_connected");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const get = async (path) => {
      let res;
      try {
        res = await this.deps.fetch(`${this.apiBase}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new UpstreamError(0, path, "aborted");
        throw new UpstreamError(0, path, err?.message || "unreachable");
      }
      if (res.status === 401) {
        // Token rejected upstream: nothing else on this board can succeed.
        controller.abort();
        throw new UpstreamError(401, path);
      }
      if (!res.ok) throw new UpstreamError(res.status, path, await safeText(res));
      return res.json();
    };

    const [datasets, artifacts, demands, quota] = await Promise.allSettled([
      get("/api/v1/datasets"),
      get("/api/v1/artifacts"),
      get("/api/v1/demands"),
      get("/api/v1/datasets/quota"),
    ]);
    clearTimeout(timer);

    if ([datasets, artifacts, demands, quota].some((r) => r.status === "rejected" && r.reason?.status === 401)) {
      this.deps.markInvalid(email, WIRE_LINE_CREDENTIAL);
      return this.unconnected("expired");
    }

    const rows = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value : null);
    const dsRows = rows(datasets);
    const artRows = rows(artifacts);
    const dmRows = rows(demands);
    const quotaVal = quota.status === "fulfilled" && quota.value && typeof quota.value === "object" ? quota.value : null;

    const blocks = [];

    // Overview: counts from whatever list succeeded; name the ones that failed.
    // Metric keys are stable snake_case identifiers — the renderer localizes
    // them via board.metric.<key> (fix-line-boards-ux D3: raw keys must never
    // reach the page as labels; the old Chinese data keys could not localize).
    const missing = [
      dsRows === null ? "数据集" : null,
      artRows === null ? "产物" : null,
      dmRows === null ? "需求单" : null,
    ].filter(Boolean);
    if (missing.length === 3) {
      blocks.push({ id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", error: blockError(datasets) });
    } else {
      const data = {};
      if (dsRows) data.datasets = dsRows.length;
      if (artRows) data.artifacts = artRows.length;
      if (dmRows) data.demands = dmRows.length;
      if (quotaVal && quotaVal.max_datasets !== null && quotaVal.max_datasets !== undefined) {
        data.quota = `${quotaVal.used_datasets ?? 0}/${quotaVal.max_datasets}`;
      }
      blocks.push({
        id: "overview_metrics",
        type: "metrics",
        tab: "overview",
        title: "概览",
        data,
        href: this.consoleUrl("datasets"),
        ...(missing.length ? { partial: missing } : {}),
      });
    }

    blocks.push(
      dsRows
        ? {
            id: "datasets_list",
            type: "list",
            tab: "datasets",
            title: "我的数据",
            href: this.consoleUrl("datasets"),
            data: dsRows.map((d) => ({
              id: d.id,
              title: d.name ?? d.key ?? String(d.id),
              subtitle: [d.source_name || d.source_kind, d.connector_id ? `connector ${d.connector_id}` : null].filter(Boolean).join(" · "),
              badges: [d.storage_tier === "api" ? "免费档" : "引擎", `${d.row_count ?? 0} 行`],
              href: this.consoleUrl("datasets"),
            })),
            actions: [{ id: "wire.dataset.create", label: "新建数据集", args: {} }],
          }
        : { id: "datasets_list", type: "list", tab: "datasets", title: "我的数据", error: blockError(datasets), href: this.consoleUrl("datasets") },
    );

    blocks.push(
      artRows
        ? {
            id: "artifacts_list",
            type: "list",
            tab: "artifacts",
            title: "产物",
            href: this.consoleUrl("artifacts"),
            data: artRows.map((a) => ({
              id: a.id,
              title: a.title ?? `#${a.id}`,
              subtitle: a.kind ?? "",
              badges: [a.status ?? "", `v${a.version ?? 1}`].filter(Boolean),
              href: this.consoleUrl("artifacts"),
              rowActions: artifactRowActions(a),
            })),
          }
        : { id: "artifacts_list", type: "list", tab: "artifacts", title: "产物", error: blockError(artifacts), href: this.consoleUrl("artifacts") },
    );

    blocks.push(
      dmRows
        ? {
            id: "demands_timeline",
            type: "timeline",
            tab: "demands",
            title: "需求单",
            href: this.consoleUrl("demands"),
            data: [...dmRows]
              .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
              .map((d) => ({
                id: d.id,
                code: d.code,
                status: d.status,
                text: `${d.code ?? `#${d.id}`} · ${d.status ?? ""} · ${d.title ?? d.intent ?? ""}`,
                created_at: d.created_at,
                href: this.consoleUrl("demands"),
              })),
            // A demand needs a title/intent the board cannot invent; the
            // compliance fields are user-typed at confirmation (userFilledArgs).
            links: [{ label: "去柏讯新建需求单", href: this.consoleUrl("demands/new") }],
          }
        : { id: "demands_timeline", type: "timeline", tab: "demands", title: "需求单", error: blockError(demands), href: this.consoleUrl("demands") },
    );

    return { connected: true, blocks };
  }
}

function artifactRowActions(a) {
  const id = a?.id;
  if (id === undefined || id === null) return [];
  const status = String(a.status ?? "");
  const out = [];
  if (status === "draft") out.push({ id: "wire.artifact.publish", label: "发布", args: { artifact_id: id } });
  if (status !== "archived") out.push({ id: "wire.artifact.archive", label: "归档", args: { artifact_id: id } });
  return out;
}

function blockError(settled) {
  if (settled.status !== "rejected") return "上游返回了非列表数据";
  const r = settled.reason;
  if (r instanceof UpstreamError) {
    if (r.status === 0) return "柏讯服务不可达";
    return `柏讯返回 HTTP ${r.status}`;
  }
  return r?.message || "加载失败";
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * Lex (识律) board adapter (add-lex-line-board) — fourth real-data adapter.
 * Same connection doctrine as wire: the user's lex ID token (PKCE minted,
 * server-side renewal) is the connection truth; blocks fail independently;
 * any 401 clears the cached token and the board reports re-authorize.
 *
 * Data source: lex customer-facing console API (lex.finddatatech.cloud
 * /api/console/*) — same origin the lex-ops-mcp forwards to, read directly
 * here without any model turn (line-boards spec hard rule). Endpoint shapes
 * verified against fd-lex server routes 2026-11-07: me/usage/quota/billing
 * take `period=YYYY-MM` where required; billing returns {entries, totals}
 * ledger rows (real metering flow, so the billing block renders real data —
 * the design D3/Q1 "under construction" fallback stays only for upstream
 * failure); credentials come from the registry patch-keys list (metadata
 * only, no plaintext/hash).
 *
 * Blocks (ids carry the tab name the page filters on):
 *   overview_metrics   me + usage totals + quota waterline (period = current month)
 *   credentials_list   GET /api/console/credentials (name/status/last_used)
 *   suites_list        static six-suite matrix from the lex_surface_overview
 *                      caliber (no upstream call — facts, not fabrication)
 *   billing_timeline   GET /api/console/billing (entries newest first + totals)
 */
export const LEX_ORIGIN = "https://lex.finddatatech.cloud";
export const LEX_LINE_CREDENTIAL = lineCredentials.LEX_CREDENTIAL_REF;

class LexUpstreamError extends Error {
  constructor(status, path, detail) {
    super(`lex ${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

function lexPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export class LexBoardAdapter extends BoardAdapter {
  constructor({ id = "lex", title = "识律", originUrl = LEX_ORIGIN, apiBase = null, deps = {} } = {}) {
    super({ id, title, originUrl });
    this.apiBase = String(apiBase || originUrl).replace(/\/+$/, "");
    this.deps = {
      fetch: (...a) => globalThis.fetch(...a),
      liveToken: lineCredentials.liveToken,
      markInvalid: lineCredentials.markInvalid,
      timeoutMs: 20_000,
      ...deps,
    };
  }

  consoleUrl(section) {
    return `${this.originUrl}/#/console/${section}`;
  }

  unconnected(reason) {
    const expired = reason === "expired";
    return {
      connected: false,
      reason,
      connectPath: connectPathForRef(LEX_LINE_CREDENTIAL),
      blocks: [
        {
          id: "connection",
          type: "metrics",
          tab: "overview",
          title: "连接状态",
          data: { connected: false },
          error: expired ? "识律登录已过期：重新进入连接页即可重新授权" : "未连接识律：请先在设置 → 连接中授权",
        },
      ],
    };
  }

  async fetchBlocks(ctx) {
    const email = String(ctx?.email || "").trim();
    const token = this.deps.liveToken(email, LEX_LINE_CREDENTIAL);
    if (!token) return this.unconnected("not_connected");

    const period = lexPeriod();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs);
    const get = async (path) => {
      let res;
      try {
        res = await this.deps.fetch(`${this.apiBase}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) throw new LexUpstreamError(0, path, "aborted");
        throw new LexUpstreamError(0, path, err?.message || "unreachable");
      }
      if (res.status === 401) {
        controller.abort();
        throw new LexUpstreamError(401, path);
      }
      if (!res.ok) throw new LexUpstreamError(res.status, path, await safeText(res));
      return res.json();
    };

    const [me, usage, quota, credentials, billing] = await Promise.allSettled([
      get("/api/console/me"),
      get(`/api/console/usage?period=${period}`),
      get(`/api/console/quota?period=${period}`),
      get("/api/console/credentials"),
      get(`/api/console/billing?period=${period}`),
    ]);
    clearTimeout(timer);

    if ([me, usage, quota, credentials, billing].some((r) => r.status === "rejected" && r.reason?.status === 401)) {
      this.deps.markInvalid(email, LEX_LINE_CREDENTIAL);
      return this.unconnected("expired");
    }

    const ok = (r) => (r.status === "fulfilled" ? r.value : null);
    const meVal = ok(me);
    const usageVal = ok(usage);
    const quotaVal = ok(quota);
    const credVal = ok(credentials);
    const billVal = ok(billing);

    const blocks = [];

    // Overview: identity + usage calls + quota waterline, each independent.
    const overviewData = {};
    const overviewMissing = [];
    if (meVal?.email) overviewData.identity = meVal.email;
    else overviewMissing.push("身份");
    if (usageVal?.totals && Number.isFinite(usageVal.totals.calls)) overviewData.usage_calls = usageVal.totals.calls;
    else overviewMissing.push("用量");
    const hardStop = quotaVal?.hard_stop ?? quotaVal?.denial_reason ?? null;
    if (quotaVal && typeof quotaVal === "object" && ("hard_stop" in quotaVal || "denial_reason" in quotaVal)) {
      overviewData.quota_state = hardStop === true || hardStop ? "stopped" : "ok";
    } else {
      overviewMissing.push("配额");
    }
    blocks.push(
      overviewMissing.length === 3
        ? { id: "overview_metrics", type: "metrics", tab: "overview", title: "概览", error: blockError(me) }
        : {
            id: "overview_metrics",
            type: "metrics",
            tab: "overview",
            title: "概览",
            data: overviewData,
            href: this.consoleUrl("usage"),
            ...(overviewMissing.length ? { partial: overviewMissing } : {}),
          },
    );

    // Credentials: registry patch-keys metadata (no plaintext ever returned).
    const credItems = credVal && Array.isArray(credVal.items) ? credVal.items : null;
    blocks.push(
      credItems
        ? {
            id: "credentials_list",
            type: "list",
            tab: "credentials",
            title: "我的凭据",
            href: this.consoleUrl("credentials"),
            data: credItems.map((k) => ({
              id: k.key_id,
              title: k.name ?? k.key_id,
              subtitle: k.key_prefix ? `${k.key_prefix} · ${k.provider ?? ""}` : (k.provider ?? ""),
              badges: [k.status ?? "active", k.last_used_at ? `最近使用 ${String(k.last_used_at).slice(0, 10)}` : "未使用"].filter(Boolean),
              href: this.consoleUrl("credentials"),
            })),
          }
        : { id: "credentials_list", type: "list", tab: "credentials", title: "我的凭据", error: blockError(credentials), href: this.consoleUrl("credentials") },
    );

    // Suites: static matrix (lex_surface_overview caliber — facts, no call).
    blocks.push({
      id: "suites_list",
      type: "list",
      tab: "suites",
      title: "识律套件",
      href: `${this.originUrl}/`,
      data: [
        { id: "suite-civil", title: "民事九步工作流", subtitle: "民事诉讼全流程", badges: ["市场在架"], href: `${this.originUrl}/` },
        { id: "suite-contract", title: "合同审查", subtitle: "contract-review-cn", badges: ["市场在架"], href: `${this.originUrl}/` },
        { id: "suite-criminal", title: "刑事辩护", subtitle: "criminal-defense-workflow 系", badges: ["市场在架"], href: `${this.originUrl}/` },
        { id: "suite-labor", title: "劳动法", subtitle: "劳动仲裁全流程+双计算器", badges: ["市场在架"], href: `${this.originUrl}/` },
        { id: "suite-research", title: "法律检索", subtitle: "legal-research 系", badges: ["市场在架"], href: `${this.originUrl}/` },
        { id: "suite-drafting", title: "文书起草", subtitle: "litigation-drafting 系", badges: ["市场在架"], href: `${this.originUrl}/` },
      ],
    });

    // Billing: real ledger flow (period rows + totals). Empty customer =
    // genuine empty state, never fabricated numbers.
    const billEntries = billVal && Array.isArray(billVal.entries) ? billVal.entries : null;
    blocks.push(
      billEntries
        ? {
            id: "billing_timeline",
            type: "timeline",
            tab: "billing",
            title: "账单",
            href: this.consoleUrl("billing"),
            data: billEntries
              .slice()
              .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
              .map((e) => ({
                id: e.id,
                text: `${e.kind ?? "entry"} · ${e.quantity ?? ""} ${e.unit ?? ""} · ¥${e.amount_yuan ?? "0"}`,
                created_at: e.created_at,
                href: this.consoleUrl("billing"),
              })),
          }
        : { id: "billing_timeline", type: "timeline", tab: "billing", title: "账单", error: blockError(billing), href: this.consoleUrl("billing") },
    );

    return { connected: true, blocks };
  }
}

/**
 * Registry of adapters by line id.
 */
const ADAPTERS = new Map([
  ["facet", new FacetBoardAdapter({ id: "facet", title: "谦面", originUrl: "https://facet.finddatatech.cloud" })],
  ["wanxing", new WanxingBoardAdapter({ id: "wanxing", title: "萬星", originUrl: "https://wanxing.finddatatech.cloud" })],
  ["wire", new WireBoardAdapter()],
  ["lex", new LexBoardAdapter()],
]);

/**
 * Get an adapter by line id.
 */
export function getBoardAdapter(line) {
  return ADAPTERS.get(line) ?? null;
}

/**
 * List all available lines.
 */
export function listBoardLines() {
  return Array.from(ADAPTERS.keys());
}

// ── Shared per-line usage readers (add-owner-cross-line-view 1.1) ────────────
//
// The cross-line cost view reads the SAME upstream lanes the boards read, so
// the read path lives here too — one source of truth, no drift (B2 reconciliation
// taught: duplicated read paths drift apart shape-first). Both helpers follow
// the adapter credential contract exactly:
//   · no live token → { status: "unconnected", reason: "not_connected" };
//   · any 401 → markInvalid flips the credential, returns "expired" unconnected;
//   · upstream failure / timeout → { status: "degraded", error };
//   · otherwise → { status: "ok", data }.
// Pure reads; nothing here writes credentials or bills anyone.

class SharedUpstreamError extends Error {
  constructor(status, path, detail) {
    super(`${path} → HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.path = path;
  }
}

async function sharedGet({ apiBase, path, token, label, fetchImpl, signal }) {
  let res;
  try {
    res = await fetchImpl(`${apiBase}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw new SharedUpstreamError(0, path, "aborted");
    throw new SharedUpstreamError(0, path, `${label} ${err?.message || "unreachable"}`);
  }
  if (res.status === 401) throw new SharedUpstreamError(401, path);
  if (!res.ok) throw new SharedUpstreamError(res.status, path, await safeText(res));
  return res.json();
}

/**
 * Lex usage read for the cross-line view: period usage totals (calls) from the
 * console usage endpoint — the same lane LexBoardAdapter's overview reads.
 */
export async function fetchLexUsageFor(email, { apiBase = null, deps = {} } = {}) {
  const base = String(apiBase || LEX_ORIGIN).replace(/\/+$/, "");
  const token = lineCredentials.liveToken(String(email || "").trim(), LEX_LINE_CREDENTIAL);
  if (!token) return { status: "unconnected", reason: "not_connected" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  try {
    const usage = await sharedGet({
      apiBase: base,
      path: `/api/console/usage?period=${lexPeriod()}`,
      token,
      label: "lex",
      fetchImpl: deps.fetch ?? ((...a) => globalThis.fetch(...a)),
      signal: controller.signal,
      timeoutMs: deps.timeoutMs ?? 20_000,
    });
    const calls = Number(usage?.totals?.calls);
    return {
      status: "ok",
      data: Number.isFinite(calls)
        ? { usage_calls: calls }
        : null,
    };
  } catch (err) {
    if (err?.status === 401) {
      lineCredentials.markInvalid(String(email || "").trim(), LEX_LINE_CREDENTIAL);
      return { status: "unconnected", reason: "expired" };
    }
    return { status: "degraded", error: err?.message || "lex usage read failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire consumption read for the cross-line view: dataset/artifact/demand
 * counts + free-tier quota — the same lane WireBoardAdapter's overview reads.
 */
export async function fetchWireUsageFor(email, { apiBase = null, deps = {} } = {}) {
  const base = String(apiBase || process.env.WIRE_API_BASE_URL || WIRE_ORIGIN).replace(/\/+$/, "");
  const token = lineCredentials.liveToken(String(email || "").trim(), WIRE_LINE_CREDENTIAL);
  if (!token) return { status: "unconnected", reason: "not_connected" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  try {
    const [datasets, artifacts, demands, quota] = await Promise.allSettled([
      sharedGet({ apiBase: base, path: "/api/v1/datasets", token, label: "wire", fetchImpl: deps.fetch ?? ((...a) => globalThis.fetch(...a)), signal: controller.signal }),
      sharedGet({ apiBase: base, path: "/api/v1/artifacts", token, label: "wire", fetchImpl: deps.fetch ?? ((...a) => globalThis.fetch(...a)), signal: controller.signal }),
      sharedGet({ apiBase: base, path: "/api/v1/demands", token, label: "wire", fetchImpl: deps.fetch ?? ((...a) => globalThis.fetch(...a)), signal: controller.signal }),
      sharedGet({ apiBase: base, path: "/api/v1/datasets/quota", token, label: "wire", fetchImpl: deps.fetch ?? ((...a) => globalThis.fetch(...a)), signal: controller.signal }),
    ]);
    if ([datasets, artifacts, demands, quota].some((r) => r.status === "rejected" && r.reason?.status === 401)) {
      lineCredentials.markInvalid(String(email || "").trim(), WIRE_LINE_CREDENTIAL);
      return { status: "unconnected", reason: "expired" };
    }
    const rows = (r) => (r.status === "fulfilled" && Array.isArray(r.value) ? r.value.length : null);
    const ds = rows(datasets);
    const art = rows(artifacts);
    const dm = rows(demands);
    const quotaVal = quota.status === "fulfilled" && quota.value && typeof quota.value === "object" ? quota.value : null;
    if (ds === null && art === null && dm === null) {
      const first = [datasets, artifacts, demands].find((r) => r.status === "rejected");
      return { status: "degraded", error: first?.reason?.message || "wire usage read failed" };
    }
    const data = {};
    if (ds !== null) data.datasets = ds;
    if (art !== null) data.artifacts = art;
    if (dm !== null) data.demands = dm;
    if (quotaVal && quotaVal.max_datasets !== null && quotaVal.max_datasets !== undefined) {
      data.quota = `${quotaVal.used_datasets ?? 0}/${quotaVal.max_datasets}`;
    }
    return { status: "ok", data: Object.keys(data).length ? data : null };
  } catch (err) {
    return { status: "degraded", error: err?.message || "wire usage read failed" };
  } finally {
    clearTimeout(timer);
  }
}
