// ── Pack registry (openspec: add-pack-marketplace) ───────────────────────────
//
// The gateway's persistence + validation layer for the pack marketplace:
// identity-gated creators publish versioned, immutable capability packs
// (inline skill bodies + registry-name MCP references + persona-only agent
// entries), and every authenticated user can browse them and subscribe.
// Rows live in a dedicated SQLite file at the gateway data root — the same
// isolation rule as the share registry, for the same reason: a pack must
// outlive and cross cells, so it cannot live inside any one of them.
//
// Version immutability is structural: publishing appends a (pack_id, version)
// row and nothing ever updates one; "unpublish" only sets an unlisted flag.
// Pack ids are gateway-minted random (128 bits) — they carry no author or
// name structure, and display names are not unique, so there is no global
// namespace to contend for.
//
// Publishing is the only mutation gated beyond identity: the route layer
// checks the creator group, this module's validateManifest() enforces the v1
// content boundary (MCP entries are registry-name references only — no
// endpoints; agent entries are persona-only — no baseUrl/model/credentials),
// and createPublishRateLimiter() caps the publish rate per author.

import Database from "better-sqlite3";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import express from "express";
import { PACK_LIMITS, packLimits, validatePackManifest as validateManifest, validateRhythm, budgetMinutesError, modelIdError } from "../lib/pack-manifest.js";
import { collectPublishVerdict, CREATOR_GROUP_REQUIRED } from "./pack-publish-gates.js";
import * as connectorBindingsModule from "../connector-bindings.js";
import { mintDeploymentBindings, mintableBindings, pruneDeploymentBindings } from "../deployment-bindings.js";
import { fetchWithTimeout } from "../lib/fetch-with-timeout.js";
import { resolveLocale, projectManifestForLocale, applyLocaleToSummary } from "../lib/pack-locale.js";
import { safePackagePath } from "../lib/skill-files.js";
import { deriveBadge, badgeFromFlags } from "../lib/pack-badge.js";
import { describeProvenance, PROVENANCE_SOURCE } from "../lib/pack-provenance.js";
import { localeCoverage } from "../lib/pack-locale-coverage.js";
import { lineOf, slugsForLine, isLineWord } from "../lib/pack-category-lines.js";
import { lineLabelOf, lineSlugs, lineWordOf, isDomainSlug, domainLabelOf, domainVocabulary } from "../lib/pack-taxonomy.js";
import { deployToRegistry, setAgentPaused, modelChoiceError, resolveServiceConfig, resolveAgentPort, NOTIFY_CHANNEL_RE, SECRET_NAME_RE, SECRET_LIMITS, maskSecretRef } from "../lib/agent-serving.js";
import { createFleetScheduler } from "./fleet-scheduler.js";
import { installVendorTables, createVendorStore } from "./vendors.js";
import { createOnboardingStore } from "./vendor-onboarding.js";
import { installMarketTables, createMarketStore, parsePricing } from "./market.js";
import { createSub2apiClient } from "../lib/sub2api-admin.js";
import { registerInternalPackRoutes, createInternalAuth } from "./packs-internal-routes.js";

// Re-exported for the gateway's own consumers (tests import from here).
export { PACK_LIMITS, packLimits, validateManifest };
// Re-exported: the gate collector moved to its own module (N-9) but stays part
// of this module's public surface — gateway consumers import it from here.
export { collectPublishVerdict };

// Read projection for the DETAIL view (add-packaged-skills D4): browsing
// carries a file inventory (sorted relative paths), never the tree's contents
// — every file's body is fetched on demand through the per-file endpoint. The
// stored-VERSION read stays the full manifest (it is the install channel);
// frontmatter is tiny and part of what gets installed, so it rides untouched.
function projectManifestForDetail(manifest) {
  if (!manifest || !Array.isArray(manifest.skills)) return manifest;
  return {
    ...manifest,
    skills: manifest.skills.map((s) =>
      s && s.files && typeof s.files === "object" && !Array.isArray(s.files)
        ? { ...s, files: Object.keys(s.files).sort() }
        : s,
    ),
  };
}

export function createPackRegistry({ file }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS packs (
    id TEXT PRIMARY KEY,
    author_email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    unlisted INTEGER NOT NULL DEFAULT 0,
    visibility TEXT NOT NULL DEFAULT 'public',
    category TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0
  )`);
  // add-agent-platform-ops: visibility on pre-existing databases.
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`);
  } catch { /* column already present */ }
  // add-facet-content-management: curation columns on pre-existing databases.
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN category TEXT NOT NULL DEFAULT ''`);
  } catch { /* column already present */ }
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN featured INTEGER NOT NULL DEFAULT 0`);
  } catch { /* column already present */ }
  // Domain axis storage (overhaul-market-catalog-presentation P1 2.3): the
  // declared domain set is a JSON slug array on the pack row — the ONE stored
  // truth. Publish stamps it from the manifest, curation retargets it; the
  // read face never derives domains from `category` at runtime (the backfill
  // migration is the only place that derivation runs). `category` itself is
  // zero-migrated.
  try {
    db.exec(`ALTER TABLE packs ADD COLUMN domains TEXT`);
  } catch { /* column already present */ }
  db.exec(`CREATE TABLE IF NOT EXISTS pack_versions (
    pack_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    manifest TEXT NOT NULL,
    author_email TEXT NOT NULL,
    published_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, version)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    pack_id TEXT NOT NULL,
    email TEXT NOT NULL,
    version INTEGER NOT NULL,
    subscribed_at INTEGER NOT NULL,
    unsubscribed_at INTEGER,
    PRIMARY KEY (pack_id, email)
  )`);
  // Agent-service deployments (add-a2a-agent-serving 3.3): bookkeeping only —
  // the runner pulls the bundle from the registry; this table answers "which
  // of this pack's roles are deployed" for the unpublish warning and the
  // deploy button's status. Deploy tenancy (add-deploy-tenancy): one row per
  // (pack, agent, DEPLOYER) — a deployment is the deployer's asset; upgrades
  // by the same deployer upsert, other deployers get their own rows.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_deployments (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    agent_path TEXT NOT NULL,
    skill_paths TEXT NOT NULL DEFAULT '[]',
    deployed_by TEXT NOT NULL,
    deployed_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id, deployed_by)
  )`);

  // Platform billing (add-agent-platform-ops D1/D2; revised by
  // revise-billing-key-acquisition): the deployer→sub2api account mapping is
  // identity + account id only — the legacy password column is kept for
  // schema compatibility but never written or read. Per-agent metered keys
  // store the value ONCE (sub2api keeps only a hash); the runner fetches
  // values by reference.
  db.exec(`CREATE TABLE IF NOT EXISTS sub2api_accounts (
    email TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    password TEXT,
    created_at INTEGER NOT NULL
  )`);
  // Fleet runners (add-runner-fleet-sharding D2): the machines serving agents.
  // The legacy single runner is SEEDED from env at boot (id aligned with its
  // FLEET_ID) so the default deploy target and its URLs hold byte-for-byte;
  // more rows = more shards, each deploy naming its runner by id.
  db.exec(`CREATE TABLE IF NOT EXISTS agent_runners (
    id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    port_base INTEGER NOT NULL DEFAULT 8791,
    port_span INTEGER NOT NULL DEFAULT 32,
    note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`);
  if (!db.prepare(`SELECT 1 FROM agent_runners LIMIT 1`).get() && process.env.AGENT_SERVING_RUNNER_URL) {
    db.prepare(`INSERT INTO agent_runners (id, base_url, port_base, port_span, note, created_at) VALUES (?, ?, 8791, 32, ?, ?)`)
      .run(
        process.env.AGENT_SERVING_DEFAULT_RUNNER_ID || "default-runner",
        process.env.AGENT_SERVING_RUNNER_URL,
        "seeded from AGENT_SERVING_RUNNER_URL (legacy single runner)",
        Date.now(),
      );
  }
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_keys (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    key_ref TEXT NOT NULL,
    key_value TEXT NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id, deployer)
  )`);
  // Deploy tenancy (add-deploy-tenancy D2): pre-existing tables carry the old
  // (pack, agent) primary key — deployed_by is a plain column there. SQLite
  // cannot alter a PK, so rebuild when deployed_by is not yet a PK member;
  // legacy rows move over with their deployed_by as ownership (paths stay
  // untouched — the compat promise).
  for (const [table, basePk] of [["pack_deployments", ["pack_id", "agent_id"]], ["deployment_keys", ["pack_id", "agent_id"]]]) {
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const deployedBy = info.find((c) => c.name === "deployed_by");
    if (!deployedBy || deployedBy.pk > 0) continue; // fresh (new PK) or unknown shape
    const colSql = info.map((c) => `${c.name} ${c.type}${c.notnull ? " NOT NULL" : ""}`).join(", ");
    const newPk = [...basePk, "deployed_by"].join(", ");
    db.exec(`CREATE TABLE ${table}__tenancy (${colSql}, PRIMARY KEY (${newPk}))`);
    db.exec(`INSERT INTO ${table}__tenancy SELECT ${info.map((c) => c.name).join(", ")} FROM ${table}`);
    db.exec(`DROP TABLE ${table}`);
    db.exec(`ALTER TABLE ${table}__tenancy RENAME TO ${table}`);
    console.log(`[packs] deploy tenancy: ${table} rebuilt with (pack, agent, deployer) key — ${db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c} row(s) preserved`);
  }
  // Deployment secrets (add-deployment-secrets D2): the deployment_keys trust
  // model generalized to arbitrary named values — the value is stored once,
  // the descriptor carries only the opaque ws_ reference, and the runner
  // fetches values over the authenticated internal route. One row per
  // (pack, agent, name); a re-paste replaces the row under a fresh reference.
  db.exec(`CREATE TABLE IF NOT EXISTS deployment_secrets (
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_ref TEXT NOT NULL,
    secret_value TEXT NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pack_id, agent_id, name)
  )`);
  // Host-allowance settlements (wanxing add-agent-chat-lane D5): one row per
  // settled chat usage id — the packs-side idempotency record so a replayed
  // host-settle call never deducts twice. The deduction itself is also
  // idempotency-keyed upstream (sub2api); this row is the local fast-path
  // check and the audit of what was charged for whom.
  db.exec(`CREATE TABLE IF NOT EXISTS pack_host_settlements (
    usage_id TEXT PRIMARY KEY,
    agent_path TEXT NOT NULL,
    minutes INTEGER NOT NULL,
    amount_usd REAL NOT NULL,
    deployer TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // Matters (add-matter-threads D1): a facade deployment's escalation
  // objects — the durable anchor a reception opens when a visitor's question
  // must reach the principal (price/contract/booking). Timeline entries are
  // {kind: open|reply|close, by: reception|owner, text, at}; content never
  // enters logs — the same no-content law the notify relay enforces.
  db.exec(`CREATE TABLE IF NOT EXISTS matters (
    id TEXT PRIMARY KEY,
    pack_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    deployer TEXT NOT NULL,
    summary TEXT NOT NULL,
    visitor_hint TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    timeline TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  // Visitor scope (add-matter-visitor-scope D4): the opaque session-derived
  // boundary an opened matter binds to. NULL = unscoped (the v1 rows, which
  // stay visible to every visitor by compatibility promise; the owner can
  // close them out). Added by try/catch ALTER — the table already exists on
  // live deployments.
  try {
    db.exec("ALTER TABLE matters ADD COLUMN scope_key TEXT");
  } catch { /* column already present */ }

  // Vendor supply-open (add-vendor-supply-open): vendor profiles/bindings/
  // onboarding rows live in THIS file — they are marketplace-plane data and
  // must outlive and cross cells by the same isolation argument as packs.
  installVendorTables(db);
  // Vendor attribution stamp on published versions (pack-marketplace delta):
  // the SLUG is immutable with the version; the display name is always
  // projected from the live profile at read time (design D4).
  try {
    db.exec("ALTER TABLE pack_versions ADD COLUMN vendor TEXT");
  } catch { /* column already present */ }
  const vendors = createVendorStore(db);
  const onboarding = createOnboardingStore(db);

  // Market revenue share (add-market-revenue-share): append-only成交记, same
  // isolation argument as packs (a purchase must outlive and cross cells).
  installMarketTables(db);
  // 版本级价格声明（服务端字段, manifest 不承载）: NULL=免费为默认, 加列
  // 后旧版行天然免费 — 与「落地前行为逐字节」同构。
  try {
    db.exec("ALTER TABLE pack_versions ADD COLUMN price_usd REAL");
    db.exec("ALTER TABLE pack_versions ADD COLUMN price_kind TEXT");
    db.exec("ALTER TABLE pack_versions ADD COLUMN period_days INTEGER");
  } catch { /* columns already present */ }
  const market = createMarketStore(db);

  // Billing snapshots (fleet-owner-surface 花销(c) 粗粒度金额): 账户级
  // sub2api 余额周期快照。粒度=账户 (deployer), 不是集群 — 读面带口径文案,
  // 与既有 billing/* 读面同一 db 生命周期单元。
  db.exec(`CREATE TABLE IF NOT EXISTS billing_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    balance_usd REAL NOT NULL,
    sampled_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS billing_snapshots_email ON billing_snapshots(email, sampled_at)`);

  const now = () => Date.now();
  const mintId = () => randomBytes(16).toString("base64url");

  // Domain declarations (overhaul-market-catalog-presentation P1 2.3): at most
  // three vocabulary slugs, deduped. Out-of-vocabulary entries are dropped here
  // — pre-P3 publish has no authoring surface for `domain`, and the curation
  // endpoint rejects them at the route. P3's manifest validator turns a
  // declared-but-unknown slug into a hard publish error instead.
  const DOMAIN_MAX = 3;
  function sanitizeDomains(value) {
    if (!Array.isArray(value)) return [];
    const out = [];
    for (const v of value) {
      if (typeof v !== "string") continue;
      const slug = v.trim();
      if (!slug || out.includes(slug) || !isDomainSlug(slug)) continue;
      out.push(slug);
      if (out.length >= DOMAIN_MAX) break;
    }
    return out;
  }

  // Stored domain set of a pack row (NULL = none declared → 未归类档). The read
  // face never derives domains from `category`; the backfill migration is the
  // only place that derivation runs.
  function storedDomains(pack) {
    if (!pack.domains) return [];
    try {
      const parsed = JSON.parse(pack.domains);
      return Array.isArray(parsed) ? parsed.filter((d) => typeof d === "string") : [];
    } catch {
      return [];
    }
  }

  const versionRow = (packId, version) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? AND version = ?`).get(packId, version) ?? null;

  const latestVersionRow = (packId) =>
    db.prepare(`SELECT * FROM pack_versions WHERE pack_id = ? ORDER BY version DESC LIMIT 1`).get(packId) ?? null;

  const packRow = (packId) => db.prepare(`SELECT * FROM packs WHERE id = ?`).get(packId) ?? null;

  // Column↔camel mapping for matter rows (timeline parsed once, here).
  const matterRowOut = (r) => ({
    id: r.id,
    packId: r.pack_id,
    agentId: r.agent_id,
    deployer: r.deployer,
    summary: r.summary,
    visitorHint: r.visitor_hint,
    status: r.status,
    timeline: JSON.parse(r.timeline),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.scope_key != null ? { scopeKey: r.scope_key } : {}),
  });

  // Vendor attribution projection (pack-marketplace delta "市场条目承载供应商署名"):
  // the version carries an immutable slug stamp; the display name is resolved
  // from the LIVE profile so a rename updates every surface at once — the
  // stamp itself never rewrites, and manifests carry no author-written
  // attribution claims. Absent slug ⇒ no `vendor` key at all (无归属不署名).
  const vendorAttribution = (version) => {
    const slug = typeof version?.vendor === "string" && version.vendor ? version.vendor : null;
    if (!slug) return null;
    return { slug, name: vendors.attributionName(slug) ?? slug };
  };

  // Display format v2 passthrough (overhaul-market-catalog-presentation 4.5):
  // the summary carries the structured display fields VERBATIM — the market
  // projection never rewrites them. Every key rides the SQL json_extract
  // convention (absent in the manifest → NULL → key omitted → a legacy row is
  // byte-identical to the pre-change projection, specs/pack-display-format
  // 兼容不变量); rows read without the list projection (get/versions callers)
  // simply carry no display block — the detail face has the manifest itself.
  const DISPLAY_KEYS = ["identity", "promise", "audience", "outcomes", "examples"];
  function displayFromObject(source) {
    if (!source || typeof source !== "object") return null;
    const d = {};
    let any = false;
    for (const key of DISPLAY_KEYS) {
      if (source[key] !== undefined && source[key] !== null) {
        d[key] = source[key];
        any = true;
      }
    }
    return any ? d : null;
  }
  function displayFromRow(version) {
    const raw = {};
    for (const key of DISPLAY_KEYS) {
      const alias = version[`display_${key}`];
      if (alias === undefined || alias === null) continue;
      if (key === "promise") raw.promise = alias;
      else {
        try {
          raw[key] = JSON.parse(alias);
        } catch {
          /* malformed stored JSON — omit the segment (read face never invents) */
        }
      }
    }
    return displayFromObject(raw);
  }

  function summaryOf(pack, version) {
    const display = displayFromRow(version);
    return {
      id: pack.id,
      authorEmail: pack.author_email,
      ...(vendorAttribution(version) ? { vendor: vendorAttribution(version) } : {}),
      // 价格呈现（market-revenue-share）：版本级服务端字段，免费=无 key（与
      // 落地前 payload 逐字节一致），订阅期形态带期长。
      ...(version.price_usd != null && version.price_usd > 0
        ? {
            pricing: {
              priceUsd: version.price_usd,
              kind: version.price_kind === "period" ? "period" : "once",
              ...(version.price_kind === "period" ? { periodDays: version.period_days } : {}),
            },
          }
        : {}),
      createdAt: pack.created_at,
      version: version.version,
      name: version.name,
      description: version.description,
      tags: JSON.parse(version.tags || "[]"),
      publishedAt: version.published_at,
      unlisted: Boolean(pack.unlisted),
      visibility: pack.visibility === "private" ? "private" : "public",
      // Curation state (add-facet-content-management): presentation-level.
      // `category` is the STORED slug (zero-migrated — write/install read it);
      // `line` is its归位 display word for the browse facet (add-legacy-pack-
      // rebrand 2.x) and stays the zh canonical word — it doubles as the
      // facet-selection identity the server expands back to slugs. `lineLabel`
      // is the locale-projected chip label (overhaul-market-catalog-presentation
      // P0): zh requests project it identical to `line`; a localized row carries
      // both so the client renders the label and sends the canonical word back.
      // Unmapped slugs show as themselves; company → "" (the facade badge
      // carries the 分身 entries, not a category chip).
      category: pack.category ?? "",
      line: lineOf(pack.category),
      lineLabel: lineLabelOf(lineOf(pack.category), "zh"),
      // Domain axis (P1): the stored set, present only when declared — an
      // undeclared pack omits the key (byte-identical to the pre-change row).
      ...(pack.domains ? { domains: storedDomains(pack) } : {}),
      ...(display ? { display } : {}),
      featured: Boolean(pack.featured),
      // Agent count of the latest version's manifest (agent-cluster-platform
      // marketplace views): computed in SQL by the list query via
      // json_array_length — absent when the caller's row didn't select it.
      ...(version.agent_count !== undefined && version.agent_count !== null
        ? { agentCount: Number(version.agent_count) }
        : {}),
      // Skill/MCP counts (overhaul-market-catalog-presentation P2 3.2): the
      // card's obtainable-signals slot — same SQL-projection convention as
      // agent_count (absent when the caller's row didn't select it, unknown ≠
      // zero; the renderer omits the segment rather than showing 0).
      ...(version.skill_count !== undefined && version.skill_count !== null
        ? { skillCount: Number(version.skill_count) }
        : {}),
      ...(version.mcp_count !== undefined && version.mcp_count !== null
        ? { mcpCount: Number(version.mcp_count) }
        : {}),
      // Facade flag (add-principal-facade): the latest version carries a
      // `facade` block — the pack is a principal's conversational front door.
      // Same SQL-select convention as agent_count: absent when the caller's
      // row didn't select it, so non-list callers keep their exact shape.
      ...(version.is_facade !== undefined && version.is_facade !== null
        ? { facade: Boolean(version.is_facade) }
        : {}),
      // Type badge (add-ai-native-lexicon): structure-derived at read time —
      // authors neither set nor override it. Present on list rows whose SQL
      // projected the structure flags; the detail read attaches its own from
      // the parsed manifest, both through lib/pack-badge's one precedence.
      ...(version.has_fleet !== undefined && version.has_fleet !== null
        ? { badge: badgeFromFlags(version) }
        : {}),
      // Adopted flag (add-official-adopted-agents): the SOURCE axis, projected
      // in SQL exactly like is_facade so a list row can render 官方精选·已审校
      // without parsing the manifest. Same absent-when-not-selected convention:
      // callers whose query didn't project it keep their exact previous shape.
      // An adopted record ALONE never means official — the roster still decides.
      ...(version.is_adopted !== undefined && version.is_adopted !== null
        ? { adopted: Boolean(version.is_adopted) }
        : {}),
    };
  }

  // Locale-tinted list row (add-pack-locale-tracks D3): the denormalized
  // columns stay the zh main track (search semantics unchanged), so a non-zh
  // request overlays the version's i18n block onto name/description here, at
  // read time. A row whose manifest is unreadable falls back to the columns.
  // The line chip label rides the same resolution (P0): `line` stays the zh
  // canonical word (the filter identity), `lineLabel` follows the request.
  function localizedSummary(pack, version, locale) {
    const summary = summaryOf(pack, version);
    summary.lineLabel = lineLabelOf(summary.line, locale);
    if (typeof version.manifest !== "string") return summary;
    let manifest;
    try {
      manifest = JSON.parse(version.manifest);
    } catch {
      return summary;
    }
    const out = applyLocaleToSummary(summary, manifest, locale);
    // v2 display follows the locale too: the SAME projection that localizes
    // name/description (4.3) yields the localized display block — a declared
    // promise/outcomes/examples/identity/audience never rewrites the zh base
    // fields; it is its own surface (specs/pack-display-format 透传规则).
    const localizedDisplay = displayFromObject(projectManifestForLocale(manifest, locale));
    if (localizedDisplay) out.display = localizedDisplay;
    return out;
  }

  // Private packs are owner-scoped (openspec: pack-visibility): invisible to
  // everyone but the author and admins, with the same not-found answer a
  // nonexistent pack gives — probing teaches nothing. Closure-level so the
  // composite read below uses the same definition as everything else.
  function visibleTo(pack, user, { admin = false } = {}) {
    if (!pack) return false;
    if (pack.visibility !== "private") return true;
    return !!user && (pack.author_email === user.email || admin === true);
  }

  // Stored versions are always retrievable — "immutable" includes the unlisted
  // state (spec: every stored version SHALL remain retrievable). Only the
  // listing and latest-version detail hide unlisted packs.
  function getVersion(id, version) {
    const pack = packRow(id);
    if (!pack) return null;
    const row = versionRow(id, Number(version));
    if (!row) return null;
    return { id, version: row.version, manifest: JSON.parse(row.manifest) };
  }

  return {
    packRowPublic: packRow,

    visibleTo,

    // First publish: mint an id and store version 1. `vendor` is the verified
    // attribution slug, `pricing` the validated 版本级价格声明 (both null ⇒
    // 与落地前行为逐字节一致).
    publish({ email, manifest, vendor = null, pricing = null }) {
      const id = mintId();
      const visibility = manifest.visibility === "private" ? "private" : "public";
      // Author-declared category (add-facet-content-management) rides the
      // pack row; admins retarget it later via setCuration.
      const category = typeof manifest.category === "string" ? manifest.category : "";
      // Domain axis (P1 2.3): an author-declared domain set is stamped on the
      // pack row at mint; a manifest without it leaves the column NULL
      // (未归类 until curation or the backfill migration fills it).
      const domains = sanitizeDomains(manifest.domain);
      db.prepare(`INSERT INTO packs (id, author_email, created_at, visibility, category, domains) VALUES (?, ?, ?, ?, ?, ?)`).run(id, email, now(), visibility, category, domains.length > 0 ? JSON.stringify(domains) : null);
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at, vendor, price_usd, price_kind, period_days)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        manifest.name,
        manifest.description || "",
        JSON.stringify(manifest.tags ?? []),
        JSON.stringify(manifest),
        email,
        now(),
        vendor,
        pricing?.priceUsd ?? null,
        pricing?.kind ?? null,
        pricing?.kind === "period" ? pricing?.periodDays ?? null : null,
      );
      return { id, version: 1 };
    },

    // Subsequent publish: author-checked append of the next version. Stored
    // versions are immutable — this is the only write path that touches one.
    publishVersion({ email, id, manifest, vendor = null, pricing = null }) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      if (pack.author_email !== email) return { error: "forbidden" };
      // Visibility is a PACK-level attribute (owner-scoped everywhere); a
      // version cannot flip it — publish a new pack to change exposure.
      // A fresh version restores listing (facetMine.unpublishNote promises
      // exactly this); without it an unlisted pack can never come back —
      // found live 2026-10-28 (C8wx14 stuck unlisted through v2→v3).
      if (pack.unlisted) db.prepare(`UPDATE packs SET unlisted = 0 WHERE id = ?`).run(id);
      const latest = latestVersionRow(id);
      const version = (latest?.version ?? 0) + 1;
      db.prepare(
        `INSERT INTO pack_versions (pack_id, version, name, description, tags, manifest, author_email, published_at, vendor, price_usd, price_kind, period_days)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        version,
        manifest.name,
        manifest.description || "",
        JSON.stringify(manifest.tags ?? []),
        JSON.stringify(manifest),
        email,
        now(),
        vendor,
        pricing?.priceUsd ?? null,
        pricing?.kind ?? null,
        pricing?.kind === "period" ? pricing?.periodDays ?? null : null,
      );
      // A redeclared category updates the pack row; absence keeps the
      // curated value (admin retargets survive version bumps). The domain set
      // follows the same discipline (P1 2.3): a non-empty declaration updates,
      // absence keeps whatever curation/backfill stored.
      if (typeof manifest.category === "string" && manifest.category) {
        db.prepare(`UPDATE packs SET category = ? WHERE id = ?`).run(manifest.category, id);
      }
      const nextDomains = sanitizeDomains(manifest.domain);
      if (nextDomains.length > 0) {
        db.prepare(`UPDATE packs SET domains = ? WHERE id = ?`).run(JSON.stringify(nextDomains), id);
      }
      return { id, version };
    },

    // Curation write (add-facet-content-management): featured is admin-only;
    // category and the domain set are author-or-admin. Returns the fresh
    // curation state or an error the route maps. Presentation-level only —
    // visibility, versions, and installability are never touched.
    setCuration({ id, actor, category, featured, domains }) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      const isAuthor = pack.author_email === actor.email;
      const isAdmin = actor.admin === true;
      if (featured !== undefined && !isAdmin) return { error: "forbidden" };
      if (category !== undefined && !isAuthor && !isAdmin) return { error: "forbidden" };
      if (domains !== undefined && !isAuthor && !isAdmin) return { error: "forbidden" };
      const nextCategory = category !== undefined ? String(category) : pack.category;
      const nextFeatured = featured !== undefined ? (featured ? 1 : 0) : pack.featured;
      let nextDomains = pack.domains;
      if (domains !== undefined) {
        // The domain write is vocabulary-only (spec: curation picks from the
        // term list). An out-of-vocabulary slug or an over-long set is
        // REJECTED — never coerced, never silently dropped. An empty array is
        // an explicit clear (the pack returns to 未归类).
        const valid =
          Array.isArray(domains) &&
          domains.length <= DOMAIN_MAX &&
          domains.every((d) => typeof d === "string" && isDomainSlug(d));
        if (!valid) return { error: "invalid_domains" };
        nextDomains = domains.length > 0 ? JSON.stringify([...new Set(domains)]) : null;
      }
      db.prepare(`UPDATE packs SET category = ?, featured = ?, domains = ? WHERE id = ?`).run(
        nextCategory,
        nextFeatured,
        nextDomains,
        id,
      );
      return {
        id,
        category: nextCategory,
        featured: Boolean(nextFeatured),
        ...(nextDomains ? { domains: storedDomains({ domains: nextDomains }) } : {}),
      };
    },

    // Author-or-admin visibility flip (add-facet-content-management): the
    // creator console's public/private toggle. Pack-level exposure stays a
    // pack attribute (owner-scoped everywhere, openspec: pack-visibility);
    // versions are untouched.
    setVisibility({ id, actor, visibility }) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      if (pack.author_email !== actor.email && actor.admin !== true) return { error: "forbidden" };
      const next = visibility === "private" ? "private" : "public";
      db.prepare(`UPDATE packs SET visibility = ? WHERE id = ?`).run(next, id);
      return { id, visibility: next };
    },

    // Version history (add-facet-content-management; widened by
    // add-facet-version-history): every stored version's number, publish
    // time, publisher, and the version's note when its manifest carries one
    // (manifests stay retrievable via the per-version read). Visibility is
    // the route layer's call — the list itself is pure data.
    versions(id) {
      const pack = packRow(id);
      if (!pack) return { error: "not_found" };
      return db
        .prepare(
          `SELECT version, published_at AS publishedAt, author_email AS authorEmail, manifest FROM pack_versions WHERE pack_id = ? ORDER BY version DESC`,
        )
        .all(id)
        .map((row) => {
          let notes;
          try {
            notes = JSON.parse(row.manifest)?.notes;
          } catch {
            notes = undefined;
          }
          return {
            version: row.version,
            publishedAt: row.publishedAt,
            authorEmail: row.authorEmail,
            ...(typeof notes === "string" ? { notes } : {}),
          };
        });
    },

    // Latest-version detail. `includeUnlisted` is the route's call: an
    // unlisted pack stays visible to its author and active subscribers.
    // 覆盖度看板 (overhaul-market-catalog-presentation 5.4): per-LATEST-version
    // en coverage over the org surface for EVERY stored pack — the operations
    // patrol face. Reads storage truth through the same localeCoverage module
    // the publish gate and the workbench use (one denominator); a manifest
    // that fails to parse reports an honest empty surface, never a crash.
    coverageBoard({ locale = "en" } = {}) {
      const rows = db.prepare(
        `SELECT p.id, v.name, v.manifest
         FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)`,
      ).all();
      return rows.map((r) => {
        let manifest = {};
        try {
          manifest = JSON.parse(r.manifest);
        } catch {
          /* unreadable stored manifest — honest zero surface */
        }
        const cov = localeCoverage(manifest, locale);
        return { id: r.id, name: r.name, total: cov.total, covered: cov.covered, missing: cov.missing };
      });
    },

    get(id, { includeUnlisted = false } = {}) {
      const pack = packRow(id);
      if (!pack) return null;
      if (pack.unlisted && !includeUnlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      const manifest = JSON.parse(version.manifest);
      // The detail read carries the same structure-derived badge the list
      // shows (add-ai-native-lexicon) — one derivation, no drift.
      return { ...summaryOf(pack, version), badge: deriveBadge(manifest), manifest };
    },

    // Stored versions are always retrievable — "immutable" includes the
    // unlisted state (spec: every stored version SHALL remain retrievable).
    // Only the listing and latest-version detail hide unlisted packs.
    getVersion,

    // Visibility-filtered stored-version read: the facet/HTTP route below and
    // the cell-side install fetch (pack-install-server-side-manifest, single-
    // process deployments) both resolve through this — one definition, so the
    // server-side install answers exactly like the market surface (private
    // packs are not-found to everyone but the author and admins).
    getVersionVisible(id, version, user, { admin = false } = {}) {
      const row = getVersion(id, version);
      if (!row) return null;
      if (!visibleTo(packRow(id), user, { admin })) return null;
      return row;
    },

    // Paginated listing of live (not unlisted) packs, newest publish first.
    // `search` matches name/description substrings; `tag` matches a tag
    // exactly (stored as a JSON array, matched textually for v1 volumes).
    // `category` filters the curation column; `author` (the viewer's own
    // email, enforced by the route) widens the unlisted clause so the creator
    // console sees their unpublished packs too.
    list({ search = "", tag = "", category = "", domain = "", author = "", page = 1, pageSize = 50, viewer = null, locale = "zh" } = {}) {
      const size = Math.min(Math.max(1, Number(pageSize) || 50), 100);
      const pageNum = Math.max(1, Number(page) || 1);
      // Locale track (add-pack-locale-tracks D2/D3): a non-zh request overlays
      // the version's i18n block on the denormalized zh columns at READ time —
      // the columns keep the zh main track, so the search clause below is
      // untouched. The manifest blob is only selected when a locale actually
      // needs it (a zh request keeps the pre-change query byte-for-byte).
      const displayLocale = resolveLocale({ locale });
      const wantLocale = displayLocale !== "zh";
      // The unlisted-widening is author-self only (or admin): the route
      // coerces author to the viewer's email, but the registry defends the
      // invariant on its own — a stranger's author filter still hides
      // unlisted packs.
      const widenUnlisted = Boolean(author) && (author === viewer?.email || viewer?.admin === true);
      const where = [widenUnlisted ? "1 = 1" : "p.unlisted = 0"];
      const params = [];
      // Private packs: owner sees their own; nobody else's (admin listing goes
      // through the same clause — pass viewer with admin flag from the route).
      if (viewer?.admin) {
        where.push("1 = 1");
      } else {
        where.push("(p.visibility IS NULL OR p.visibility != 'private' OR p.author_email = ?)");
        params.push(String(viewer?.email ?? ""));
      }
      if (search) {
        const pat = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        if (wantLocale) {
          // Cross-track search (overhaul-market-catalog-presentation P0): a
          // non-zh request matches the zh main track AND the request locale's
          // overlay block, so an English keyword finds a pack whose zh columns
          // never contain it. The resolved tag is path-safe by construction
          // (resolveLocale output is lower-case BCP-47, no quotes); a suffixed
          // tag also tries its primary subtag (an `en-US` request finds the
          // `en` block). A zh request keeps the pre-change clause verbatim —
          // zh overlays are not a legal manifest shape, so there is nothing
          // to search there.
          const tag = displayLocale.replace(/"/g, "");
          const overlayPaths = [...new Set([tag, tag.split("-")[0]])].map((t) => `$.i18n."${t}"`);
          where.push(
            `(v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\' ${overlayPaths
              .map(
                (p) =>
                  `OR json_extract(v.manifest, '${p}.name') LIKE ? ESCAPE '\\' OR json_extract(v.manifest, '${p}.description') LIKE ? ESCAPE '\\'`,
              )
              .join(" ")})`,
          );
          params.push(pat, pat, ...overlayPaths.flatMap(() => [pat, pat]));
        } else {
          where.push(`(v.name LIKE ? ESCAPE '\\' OR v.description LIKE ? ESCAPE '\\')`);
          params.push(pat, pat);
        }
      }
      if (tag) {
        where.push(`v.tags LIKE ? ESCAPE '\\'`);
        params.push(`%"${tag.replace(/[\\%_"]/g, (c) => `\\${c}`)}"%`);
      }
      if (category) {
        // The facet selection now carries the归位 LINE word; expand it to the
        // raw slugs it stands for. A selection that is not a line word (an
        // unmapped category or a direct slug query from an API client) matches
        // exactly — so the read face maps, the storage stays byte-for-byte.
        if (isLineWord(category)) {
          const slugs = slugsForLine(category);
          if (slugs.length > 0) {
            where.push(`p.category IN (${slugs.map(() => "?").join(", ")})`);
            params.push(...slugs);
          } else {
            where.push("1 = 0");
          }
        } else {
          where.push("p.category = ?");
          params.push(String(category));
        }
      }
      if (author) {
        where.push("p.author_email = ?");
        params.push(String(author));
      }
      if (domain) {
        // Domain filter (overhaul-market-catalog-presentation P1 2.4): the
        // stored set is a JSON array on the pack row; a pack matches when any
        // declared slug equals the selection. No derivation from `category`
        // happens here — an undeclared pack simply never matches.
        where.push("EXISTS (SELECT 1 FROM json_each(p.domains) je WHERE je.value = ?)");
        params.push(String(domain));
      }
      const whereSql = where.join(" AND ");
      const total = db.prepare(
        `SELECT COUNT(*) AS n FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}`,
      ).get(...params).n;
      const rows = db.prepare(
        `SELECT p.*, v.version, v.name, v.description, v.tags, v.published_at, v.vendor,
                ${wantLocale ? "v.manifest AS manifest," : ""}
                json_array_length(v.manifest, '$.agents') AS agent_count,
                json_array_length(v.manifest, '$.skills') AS skill_count,
                json_array_length(v.manifest, '$.mcpServers') AS mcp_count,
                json_extract(v.manifest, '$.identity') AS display_identity,
                json_extract(v.manifest, '$.promise') AS display_promise,
                json_extract(v.manifest, '$.audience') AS display_audience,
                json_extract(v.manifest, '$.outcomes') AS display_outcomes,
                json_extract(v.manifest, '$.examples') AS display_examples,
                CAST(json_extract(v.manifest, '$.facade') IS NOT NULL AS INTEGER) AS is_facade,
                CAST(json_extract(v.manifest, '$.fleet') IS NOT NULL AS INTEGER) AS has_fleet,
                CAST(json_extract(v.manifest, '$.cluster') IS NOT NULL AS INTEGER) AS has_cluster,
                CAST(json_extract(v.manifest, '$.provenance.kind') = 'official-adopted' AS INTEGER) AS is_adopted,
                EXISTS(SELECT 1 FROM json_each(v.manifest, '$.agents') je
                       WHERE json_extract(je.value, '$.serving') IS NOT NULL) AS has_serving
         FROM packs p JOIN pack_versions v
           ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
         WHERE ${whereSql}
         ORDER BY v.published_at DESC, p.rowid DESC LIMIT ? OFFSET ?`,
      ).all(...params, size, (pageNum - 1) * size);
      return {
        total,
        page: pageNum,
        pageSize: size,
        packs: rows.map((r) => (wantLocale ? localizedSummary(r, r, displayLocale) : summaryOf(r, r))),
      };
    },

    // Browse facets (overhaul-market-catalog-presentation P1 2.4): the DECLARED
    // taxonomy plus per-value counts — never the set of strings that happened to
    // appear in the current page of rows. Lines are always the full declared set
    // in declared order (a zero-count line still renders: "this line has nothing
    // listed yet" is information); domains list only the values with a non-zero
    // count, in declared order (the vocabulary may be long — empty values are
    // noise). Counts follow the anonymous browse face (public, listed packs).
    facets({ locale = "zh" } = {}) {
      const lines = lineSlugs().map((slug) => ({
        slug,
        word: lineWordOf(slug),
        label: lineLabelOf(lineWordOf(slug), locale),
        count: 0,
      }));
      const lineByWord = new Map(lines.map((l) => [l.word, l]));
      const domains = domainVocabulary().map((d) => ({
        slug: d.slug,
        label: domainLabelOf(d.slug, locale),
        count: 0,
      }));
      const domainBySlug = new Map(domains.map((d) => [d.slug, d]));
      const rows = db
        .prepare(
          `SELECT p.category, p.domains, COUNT(*) AS n FROM packs p
             JOIN pack_versions v ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
            WHERE p.unlisted = 0 AND (p.visibility IS NULL OR p.visibility != 'private')
            GROUP BY p.category, p.domains`,
        )
        .all();
      for (const r of rows) {
        const line = lineByWord.get(lineOf(r.category));
        if (line) line.count += r.n;
        for (const slug of storedDomains(r)) {
          const d = domainBySlug.get(slug);
          if (d) d.count += r.n;
        }
      }
      return {
        lines,
        domains: domains.filter((d) => d.count > 0),
        // The FULL vocabulary (browse renders only `domains`; the curation
        // surface needs every selectable value — including zero-count ones —
        // and must never fall back to free-text slugs).
        vocabulary: domains.map((d) => ({ slug: d.slug, label: d.label })),
      };
    },

    // Author-checked unlist. Versions and subscriptions are untouched.
    setUnlisted({ email, id }) {
      const pack = packRow(id);
      if (!pack) return false;
      if (pack.author_email !== email) return false;
      db.prepare(`UPDATE packs SET unlisted = 1 WHERE id = ?`).run(id);
      return true;
    },

    // Subscribe records the latest version at subscribe time. Resubscribing
    // (re)records it — the cell's own installed-pack state remains the
    // operational truth for what is materialized there.
    subscribe({ email, id }) {
      const pack = packRow(id);
      if (!pack || pack.unlisted) return null;
      const version = latestVersionRow(id);
      if (!version) return null;
      db.prepare(
        `INSERT INTO subscriptions (pack_id, email, version, subscribed_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (pack_id, email) DO UPDATE SET version = excluded.version, subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL`,
      ).run(id, email, version.version, now());
      return { version: version.version, manifest: JSON.parse(version.manifest) };
    },

    unsubscribe({ email, id }) {
      const r = db.prepare(
        `UPDATE subscriptions SET unsubscribed_at = ? WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).run(now(), id, email);
      return r.changes > 0;
    },

    subscription(email, id) {
      return db.prepare(
        `SELECT * FROM subscriptions WHERE pack_id = ? AND email = ? AND unsubscribed_at IS NULL`,
      ).get(id, email) ?? null;
    },

    // 订阅者跟新读面 (fleet-owner-iteration / pack-marketplace 订阅跟新提示):
    // 订阅有效且最新版最新发布于订阅版本之后的行, 每行携 latest notes(从
    // latest manifest 读字段, 不落第二份副本)。呈现时取 CURRENT 版 — 提示
    // 永远只交通不升级。
    subscriptionsFor(email) {
      return db
        .prepare(
          `SELECT s.pack_id AS packId, s.version AS subscribedVersion, s.subscribed_at AS subscribedAt,
                  p.id AS p_id, v.version AS latestVersion, v.name AS latestName,
                  v.published_at AS latestPublishedAt, v.manifest AS latestManifest
           FROM subscriptions s
           JOIN packs p ON p.id = s.pack_id
           JOIN pack_versions v ON v.pack_id = p.id AND v.version = (SELECT MAX(version) FROM pack_versions WHERE pack_id = p.id)
           WHERE s.email = ? AND s.unsubscribed_at IS NULL
           ORDER BY v.published_at DESC`,
        )
        .all(String(email))
        .map((r) => {
          let notes = null;
          try {
            notes = JSON.parse(r.latestManifest)?.notes ?? null;
          } catch { /* manifest 非 JSON — 旧形态的容错同样一开始就走 */ }
          return {
            packId: r.packId,
            subscribedVersion: r.subscribedVersion,
            latestVersion: r.latestVersion,
            name: r.latestName,
            publishedAt: r.latestPublishedAt,
            notes: typeof notes === "string" && notes.trim() ? notes : null,
          };
        });
    },

    subscriberCount(id) {
      return db.prepare(
        `SELECT COUNT(*) AS n FROM subscriptions WHERE pack_id = ? AND unsubscribed_at IS NULL`,
      ).get(id).n;
    },

    authorEmail(id) {
      return packRow(id)?.author_email ?? null;
    },

    // ── Agent-service deployments (add-a2a-agent-serving 3.3) ────────────────
    // Bookkeeping only: the registry holds the deployed truth (agent entries);
    // these rows answer "which roles of this pack are deployed" for the
    // unpublish warning and the deploy button's status. Upsert keeps one row
    // per (pack, agent) across in-place upgrades.
    recordDeployment({ packId, agentId, version, agentPath, skillPaths, email }) {
      db.prepare(
        `INSERT INTO pack_deployments (pack_id, agent_id, version, agent_path, skill_paths, deployed_by, deployed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (pack_id, agent_id, deployed_by) DO UPDATE SET
           version = excluded.version, agent_path = excluded.agent_path,
           skill_paths = excluded.skill_paths, deployed_at = excluded.deployed_at`,
      ).run(packId, agentId, Number(version), agentPath, JSON.stringify(skillPaths ?? []), email, now());
    },

    deployments(id) {
      return db.prepare(`SELECT * FROM pack_deployments WHERE pack_id = ? ORDER BY agent_id`).all(id)
        .map((r) => ({
          agentId: r.agent_id,
          version: r.version,
          agentPath: r.agent_path,
          skills: JSON.parse(r.skill_paths || "[]"),
          deployedBy: r.deployed_by,
          deployedAt: r.deployed_at,
        }));
    },
    // Every deployment across packs (add-wanxing-serving-api): the facade's
    // agent-slug lookup scans the full set — slug resolution is global, not
    // per-pack.
    allDeployments() {
      return db.prepare(`SELECT * FROM pack_deployments ORDER BY pack_id, agent_id`).all()
        .map((r) => ({
          packId: r.pack_id,
          agentId: r.agent_id,
          version: r.version,
          agentPath: r.agent_path,
          skills: JSON.parse(r.skill_paths || "[]"),
          deployedBy: r.deployed_by,
          deployedAt: r.deployed_at,
        }));
    },
    // ── Platform billing bookkeeping (add-agent-platform-ops) ─────────────
    billingAccount(email) {
      return db.prepare(`SELECT * FROM sub2api_accounts WHERE email = ?`).get(email) ?? null;
    },
    // Billing snapshots (fleet-owner-surface 花销(c)): 快照 = 事实投影的原料,
    // 读取侧节流写下 (≥55min 间隔), 只增多数, 过量行按保留窗修剪。
    recordBillingSnapshot({ email, userId, balanceUsd, at = null }) {
      const t = at ?? Date.now();
      db.prepare(`INSERT INTO billing_snapshots (email, user_id, balance_usd, sampled_at) VALUES (?, ?, ?, ?)`)
        .run(String(email), Number(userId), Number(balanceUsd), t);
      // 保留窗: 单账户 400 行上线 (快照粒度粗放, 远超两年日窗所需)。
      db.prepare(
        `DELETE FROM billing_snapshots WHERE email = ? AND id NOT IN
           (SELECT id FROM billing_snapshots WHERE email = ? ORDER BY sampled_at DESC LIMIT 400)`,
      ).run(String(email), String(email));
    },
    billingSnapshots(email, { limit = 400 } = {}) {
      return db
        .prepare(`SELECT email, user_id AS userId, balance_usd AS balanceUsd, sampled_at AS sampledAt
                  FROM billing_snapshots WHERE email = ? ORDER BY sampled_at DESC LIMIT ?`)
        .all(String(email), Math.min(400, Math.max(1, Number(limit) || 400)));
    },
    // ── Fleet runners (add-runner-fleet-sharding D2) ────────────────────────
    runnerList() {
      return db.prepare(`SELECT id, base_url, port_base, port_span, note, created_at FROM agent_runners ORDER BY created_at, id`).all()
        .map((r) => ({ id: r.id, baseUrl: r.base_url, portBase: r.port_base, portSpan: r.port_span, note: r.note, createdAt: r.created_at }));
    },
    runnerUpsert({ id, baseUrl, portBase, portSpan, note = "" }) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error("runner id must match [a-z0-9][a-z0-9._-]{0,63}");
      if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) throw new Error("baseUrl must be an http(s) URL");
      const base = Number.isInteger(portBase) && portBase > 0 ? portBase : 8791;
      const span = Number.isInteger(portSpan) && portSpan > 0 ? portSpan : 32;
      db.prepare(`INSERT INTO agent_runners (id, base_url, port_base, port_span, note, created_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, port_base = excluded.port_base,
          port_span = excluded.port_span, note = excluded.note`)
        .run(id, baseUrl.replace(/\/+$/, ""), base, span, String(note || ""), Date.now());
      return { id, baseUrl: baseUrl.replace(/\/+$/, ""), portBase: base, portSpan: span };
    },
    saveBillingAccount({ email, userId }) {
      db.prepare(
        `INSERT INTO sub2api_accounts (email, user_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET user_id = excluded.user_id`,
      ).run(email, userId, Date.now());
    },
    recordDeploymentKey({ packId, agentId, keyRef, keyValue, deployer }) {
      // keyRef normalizes to string: sub2api ids arrive as numbers, route
      // params as strings — one canonical form or lookups miss.
      db.prepare(
        `INSERT INTO deployment_keys (pack_id, agent_id, key_ref, key_value, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(pack_id, agent_id, deployer) DO UPDATE SET key_ref = excluded.key_ref,
           key_value = excluded.key_value, created_at = excluded.created_at`,
      ).run(packId, agentId, String(keyRef), keyValue, deployer, Date.now());
    },
    deploymentKeyByRef(keyRef) {
      const r = db.prepare(`SELECT * FROM deployment_keys WHERE key_ref = ?`).get(String(keyRef));
      return r ? { agentId: r.agent_id, packId: r.pack_id, keyValue: r.key_value, deployer: r.deployer } : null;
    },
    // The pack's full binding set (paste-flow lifecycle bookkeeping): the
    // deploy route keeps, replaces, and drops entries against this snapshot.
    deploymentKeysForPack(packId) {
      return db.prepare(`SELECT pack_id, agent_id, key_ref, key_value, deployer FROM deployment_keys WHERE pack_id = ?`).all(packId)
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, keyRef: r.key_ref, keyValue: r.key_value, deployer: r.deployer }));
    },
    deleteDeploymentKey(packId, agentId) {
      db.prepare(`DELETE FROM deployment_keys WHERE pack_id = ? AND agent_id = ?`).run(packId, agentId);
    },
    listDeploymentKeys() {
      return db.prepare(`SELECT pack_id, agent_id, key_ref, deployer, created_at FROM deployment_keys`).all()
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, keyRef: r.key_ref, deployer: r.deployer, createdAt: r.created_at }));
    },
    // Deploy tenancy: a deployer's own key row; absent deployer = the legacy
    // (unsuffixed-path) deployment — the row whose agent_path has no deployer
    // segment, else the oldest (the pre-tenancy shape).
    deploymentKeyForAgent(packId, agentId, deployer = null) {
      if (deployer) {
        const mine = db.prepare(`SELECT * FROM deployment_keys WHERE pack_id = ? AND agent_id = ? AND deployer = ?`).get(packId, agentId, deployer);
        return mine ? { keyRef: mine.key_ref, keyValue: mine.key_value, deployer: mine.deployer } : null;
      }
      const rows = db.prepare(`SELECT * FROM deployment_keys WHERE pack_id = ? AND agent_id = ? ORDER BY created_at ASC`).all(packId, agentId);
      return rows.length ? { keyRef: rows[0].key_ref, keyValue: rows[0].key_value, deployer: rows[0].deployer } : null;
    },
    hostSettlement(usageId) {
      return db.prepare(`SELECT * FROM pack_host_settlements WHERE usage_id = ?`).get(String(usageId)) ?? null;
    },
    recordHostSettlement({ usageId, agentPath, minutes, amountUsd, deployer }) {
      db.prepare(
        `INSERT INTO pack_host_settlements (usage_id, agent_path, minutes, amount_usd, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(String(usageId), agentPath, minutes, amountUsd, deployer, Date.now());
    },

    // ── Matters (add-matter-threads D1/D4) ───────────────────────────────────
    // The mt_ id matches the pk_ mint shape; the timeline is the matter's
    // whole history (open/reply/close append-only, replies after responded
    // keep flowing — closure is the only terminal).
    matterOpen({ packId, agentId, deployer, summary, visitorHint, scopeKey = null }) {
      const id = `mt_${randomBytes(12).toString("hex")}`;
      const at = Date.now();
      db.prepare(
        `INSERT INTO matters (id, pack_id, agent_id, deployer, summary, visitor_hint, status, timeline, created_at, updated_at, scope_key)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(
        id, packId, agentId, deployer, summary, visitorHint,
        JSON.stringify([{ kind: "open", by: "reception", text: summary, at }]),
        at, at, scopeKey,
      );
      return { id, status: "open" };
    },
    // Visitor visibility boundary (add-matter-visitor-scope D3): a tool-face
    // reader with a scope sees ITS OWN matters plus the unscoped v1 rows;
    // the owner routes pass no scope and see everything.
    mattersForDeployment(packId, agentId, scopeKey = null) {
      if (scopeKey == null) {
        return db.prepare(
          `SELECT * FROM matters WHERE pack_id = ? AND agent_id = ?
           ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'responded' THEN 1 ELSE 2 END, updated_at DESC`,
        ).all(packId, agentId).map(matterRowOut);
      }
      return db.prepare(
        `SELECT * FROM matters WHERE pack_id = ? AND agent_id = ? AND (scope_key IS NULL OR scope_key = ?)
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'responded' THEN 1 ELSE 2 END, updated_at DESC`,
      ).all(packId, agentId, scopeKey).map(matterRowOut);
    },
    mattersForPack(packId) {
      return db.prepare(
        `SELECT * FROM matters WHERE pack_id = ?
         ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'responded' THEN 1 ELSE 2 END, updated_at DESC`,
      ).all(packId).map(matterRowOut);
    },
    matterRead(id) {
      const r = db.prepare(`SELECT * FROM matters WHERE id = ?`).get(String(id));
      return r ? matterRowOut(r) : null;
    },
    matterAppend(id, entry, status) {
      const m = db.prepare(`SELECT timeline FROM matters WHERE id = ?`).get(String(id));
      if (!m) return null;
      const timeline = JSON.parse(m.timeline);
      timeline.push(entry);
      db.prepare(`UPDATE matters SET timeline = ?, status = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(timeline), status, Date.now(), String(id),
      );
      return true;
    },

    // ── Deployment secrets (add-deployment-secrets D2/D5) ────────────────────
    // Same discipline as deployment_keys: the value is written once, the
    // descriptor carries only the reference, the runner fetches the value
    // over the authenticated internal route. Re-pasting a name mints a fresh
    // reference (rotating the old one out of the descriptor on redeploy).
    recordDeploymentSecret({ packId, agentId, name, secretRef, secretValue, deployer }) {
      db.prepare(
        `INSERT INTO deployment_secrets (pack_id, agent_id, name, secret_ref, secret_value, deployer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(pack_id, agent_id, name) DO UPDATE SET secret_ref = excluded.secret_ref,
           secret_value = excluded.secret_value, deployer = excluded.deployer`,
      ).run(packId, agentId, name, secretRef, secretValue, deployer, Date.now());
    },
    deleteDeploymentSecret(packId, agentId, name) {
      db.prepare(`DELETE FROM deployment_secrets WHERE pack_id = ? AND agent_id = ? AND name = ?`).run(packId, agentId, name);
    },
    // The pack's full binding set (lifecycle bookkeeping): the deploy route
    // keeps, replaces, and drops entries against this snapshot. Values stay
    // on this side — callers only ever surface names (or design-D6 masks).
    deploymentSecretsForPack(packId) {
      return db.prepare(`SELECT pack_id, agent_id, name, secret_ref, secret_value, deployer FROM deployment_secrets WHERE pack_id = ?`).all(packId)
        .map((r) => ({ packId: r.pack_id, agentId: r.agent_id, name: r.name, secretRef: r.secret_ref, secretValue: r.secret_value, deployer: r.deployer }));
    },
    deploymentSecretByRef(secretRef) {
      const r = db.prepare(`SELECT * FROM deployment_secrets WHERE secret_ref = ?`).get(String(secretRef));
      return r ? { packId: r.pack_id, agentId: r.agent_id, name: r.name, secretRef: r.secret_ref, secretValue: r.secret_value } : null;
    },

    // Vendor supply-open stores (identity + onboarding): same file, same
    // lifecycle unit as the pack registry — handed to the route layers that
    // mount after this registry.
    vendors,
    onboarding,
    // Market revenue share (add-market-revenue-share): append-only成交记 +
    // 收益 projection, same file/lifecycle unit.
    market,

    close() {
      db.close();
    },
  };
}

// Per-author fixed-window publish limiter (share.js createRateLimiter
// pattern, keyed by author email instead of remote address).
export function createPublishRateLimiter({ windowMs = 60 * 60_000, max = 10 } = {}) {
  const buckets = new Map();
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, b] of buckets) if (b.resetAt <= cutoff) buckets.delete(key);
  }, windowMs).unref();

  return function allow(email) {
    const t = Date.now();
    let b = buckets.get(email);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + windowMs };
      buckets.set(email, b);
    }
    b.count += 1;
    return b.count <= max;
  };
}

// ── HTTP surface ─────────────────────────────────────────────────────────────
//
// Every route requires a verified identity (the gateway's resolveUser /
// rejectUnauthenticated — same as the share routes); only publishing adds the
// creator-group gate on top. Registered before the cell-proxy catch-all.

export function registerPackRoutes(app, {
  registry,
  resolveUser,
  rejectUnauthenticated,
  creatorGroups,
  adminGroups = [],
  rateMax = 10,
  rateWindowMs = 60 * 60_000,
  // add-packaged-skills D2: the publish body may carry inline skill packages
  // (≤10 skills × ~2MiB aux ≈ 21MiB manifest + JSON escaping headroom). The
  // facet mount's GLOBAL parser must allow at least this much or the route's
  // own limit is shadowed (see facet/index.js).
  jsonLimit = "24mb",
  deployConfig: deployConfigOpt = null,
  // Facet-open read face (add-facet-platform): when true, the three read
  // routes (browse / detail / stored version) answer anonymous callers with
  // a null-identity viewer — public live packs only; private and unlisted
  // stay invisible (visibleTo/get already enforce exactly that). Write
  // routes (publish/subscribe/deploy/unpublish) keep the hard auth gate.
  // The 壹座-embedded mount leaves this off: behind the Logto session the
  // wall costs nothing and the pre-facet spec posture holds there.
  anonymousRead = false,
  // Vendor supply-open (add-vendor-supply-open): the identity store for the
  // vendor-binding publish lane and attribution stamps. When null (legacy
  // mounts/tests), the contract is byte-identical to the pre-vendor one.
  vendors = null,
  // Market revenue share (add-market-revenue-share): entitlement projection
  // for the detail route's `purchased` flag (install gate reads it). When
  // null, the flag is omitted — behavior byte-identical to pre-market.
  market = null,
  // Official showcase (add-official-pack-showcase): the deployment-side
  // author roster that decides the `official` badge and the three-segment
  // /api/packs/official aggregation. Authors CANNOT self-declare — the
  // roster is the only source. Empty/absent → every row reads official:false
  // and the showcase answers empty segments (honest empty, not an error).
  officialAuthors = null,
}) {
  // Agent-serving wiring (3.2): injected config wins (tests), env falls back
  // to the dedicated AGENT_SERVING_* names, then the market-bridge vars —
  // on single-process deployments the registry is the same host either way.
  const deployConfig = () => {
    if (typeof deployConfigOpt === "function") return deployConfigOpt();
    if (deployConfigOpt && typeof deployConfigOpt === "object") return deployConfigOpt;
    return {
      registryUrl: process.env.AGENT_SERVING_REGISTRY_URL || process.env.REGISTRY_URL || "",
      token: process.env.AGENT_SERVING_REGISTRY_TOKEN || process.env.MARKET_REGISTRY_TOKEN || "",
      runnerBaseUrl: process.env.AGENT_SERVING_RUNNER_URL || "",
      packsPublicBase: process.env.AGENT_SERVING_PACKS_URL || process.env.PAAS_BASE_URL || "",
      // Platform billing (add-agent-platform-ops D1): the admin key rides the
      // platform secret; absent ⇒ the linkage degrades (no gate, no keys).
      ...(process.env.SUB2API_ADMIN_KEY
        ? { sub2api: { baseUrl: process.env.SUB2API_BASE_URL || "http://127.0.0.1:32080", adminKey: process.env.SUB2API_ADMIN_KEY } }
        : { sub2api: null }),
    };
  };
  const publishAllowed = createPublishRateLimiter({ windowMs: rateWindowMs, max: rateMax });
  // Validate's own budget (creator-pack-forge-support D4): deliberately NOT
  // the publish limiter — a dry-run must never exhaust publish allowance —
  // but bounded all the same, because the tool-declaration gate carries one
  // live probe per server and a looping agent must not turn validation into
  // a probing amplifier.
  const validateAllowed = createPublishRateLimiter({
    windowMs: Number(process.env.PACK_VALIDATE_RATE_WINDOW_MS) > 0 ? Number(process.env.PACK_VALIDATE_RATE_WINDOW_MS) : 60 * 60_000,
    max: Number(process.env.PACK_VALIDATE_RATE_MAX) > 0 ? Number(process.env.PACK_VALIDATE_RATE_MAX) : 120,
  });

  // ── Fleet scheduler (add-fleet-scheduler) ─────────────────────────────────
  // Env-gated control loop: failover for stale runners + the placement hint
  // the deploy route's auto-placement reads. Lives here (the facet's packs
  // service) because it is already the fleet's single writer (deploy + fleet
  // table). The board is the fleet observer's runner heartbeats.
  let scheduler = null;
  if (process.env.FLEET_SCHEDULER_ENABLED === "1") {
    const cfg0 = deployConfig();
    const doRegFetch = async (p, init = {}) => {
      const base = String(cfg0.registryUrl || "").replace(/\/+$/, "");
      // Outbound call discipline: registry reads ride the shared deadline
      // wrapper (default env bound) — a stalled registry must not hang the
      // scheduler lane.
      const r = await fetchWithTimeout(base + p, {
        ...init,
        headers: { Accept: "application/json", ...(cfg0.token ? { Authorization: `Bearer ${cfg0.token}` } : {}), ...(init.headers ?? {}) },
      });
      return r;
    };
    let boardCache = { at: 0, board: null };
    const boardFetch = async () => {
      const url = String(process.env.FLEET_BOARD_URL || "").replace(/\/+$/, "");
      const token = process.env.FLEET_BOARD_TOKEN || "";
      if (!url) throw new Error("FLEET_BOARD_URL not configured");
      // Outbound call discipline: shared deadline wrapper (default env bound).
      const r = await fetchWithTimeout(`${url}/api/fleet/v1/board`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) throw new Error(`board HTTP ${r.status}`);
      const board = await r.json();
      boardCache = { at: Date.now(), board };
      return board;
    };
    scheduler = createFleetScheduler({
      config: {
        staleMs: Number(process.env.FLEET_SCHEDULER_STALE_MS) || 90_000,
        intervalMs: Number(process.env.FLEET_SCHEDULER_INTERVAL_MS) || 30_000,
      },
      registry: {
        listAgents: async () => {
          // Paginated read (registry-list-completeness): one page is not the
          // full set; the scheduler reconciles only what it is shown.
          const items = [];
          let offset = 0;
          const PAGE = 500;
          for (let page = 0; page < 100; page += 1) {
            const r = await doRegFetch(`/api/agents?limit=${PAGE}&offset=${offset}`);
            if (!r.ok) throw new Error(`registry list HTTP ${r.status}`);
            const doc = await r.json();
            const rows = Array.isArray(doc) ? doc : (doc?.agents ?? doc?.items ?? []);
            items.push(...rows);
            const total = Number.isFinite(Number(doc?.total_count)) ? Number(doc.total_count) : null;
            const hasNext =
              typeof doc?.has_next === "boolean"
                ? doc.has_next
                : total !== null
                  ? items.length < total
                  : rows.length >= PAGE;
            if (!hasNext || rows.length === 0) break;
            offset += rows.length;
          }
          return items;
        },
        putAgent: async (path, body) => {
          const r = await doRegFetch(`/api/agents${path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          if (!r.ok) throw new Error(`registry put ${path} HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 120)}`);
          return r.json().catch(() => ({}));
        },
      },
      boardFetch,
      fleetRows: () => registry.runnerList(),
      log: { log: (m) => console.log(`[fleet] ${m}`), warn: (m) => console.warn(`[fleet] ${m}`) },
    });
    // Cached board for the deploy route's auto-placement (≤10s stale beats a
    // per-deploy fetch; failover never reads this — it always takes a pass).
    scheduler.boardNow = async () => {
      if (boardCache.board && Date.now() - boardCache.at < 10_000) return boardCache.board;
      return boardFetch();
    };
    scheduler.start();
    console.log("[fleet] scheduler armed (failover + auto-placement)");
  }
  const isCreator = (user) => creatorGroups.some((g) => (user.groups || []).includes(g));
  // Access mode (add-opening-gates): the opening action's switch, built ahead
  // of the action. closed (default, unset included) keeps the creator gate
  // byte-for-byte; open admits any authenticated user to publish/deploy —
  // the billing-key economic gate stays the real abuse bound either way.
  const accessMode = String(process.env.PACK_ACCESS_MODE || "").toLowerCase() === "open" ? "open" : "closed";
  // Publish admission (add-vendor-supply-open, pack-marketplace delta): open
  // mode, creator group, OR an active binding to a complete vendor profile.
  // Store absent ⇒ creator-group gate byte-for-byte as before.
  const mayPublish = (user) =>
    accessMode === "open" || isCreator(user) || Boolean(vendors?.eligibleVendor?.(user.email));
  // Capacity waterline (add-opening-gates): a NEW child is refused when the
  // best target runner's headroom is below the line. Redeploys/upgrades of an
  // in-service pack skip it (capacity pressure must never wedge a live
  // service). Unknowable capacity degrades open, same as the roster gate.
  const waterlineMb = Number(process.env.FLEET_CAPACITY_WATERLINE_MB) > 0 ? Number(process.env.FLEET_CAPACITY_WATERLINE_MB) : 512;
  // The platform emergency stop's gate (add-agent-residency D5): admin groups
  // only — the deployer-facing pause/resume ride the author-or-creator gate.
  const isAdmin = (user) => adminGroups.some((g) => (user.groups || []).includes(g));
  const auth = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      rejectUnauthenticated(req, res);
      return null;
    }
    return user;
  };

  // Read-face auth: identity when present, else the anonymous viewer when
  // the facet-open mount allows it. The viewer shape mirrors what the
  // visibility filters expect from a signed-out browser: no email, no
  // groups — visibleTo() shows such a caller public packs only, and the
  // unlisted guard in get() stays shut (includeUnlisted requires author or
  // subscriber, neither of which an empty email can match).
  const authRead = (req) => {
    const user = resolveUser(req);
    if (user) return user;
    return anonymousRead ? { email: "", groups: [] } : null;
  };

  // ── Official showcase (add-official-pack-showcase) ─────────────────────────
  // Official = the deployment-side author roster, matched case-insensitively.
  // The badge is presentation-level only: it never gates visibility,
  // immutability, installability, or pricing (pack-marketplace delta).
  const officialRoster = (Array.isArray(officialAuthors) ? officialAuthors : [])
    .map((e) => String(e).trim().toLowerCase())
    .filter(Boolean);
  const isOfficial = (email) => officialRoster.includes(String(email ?? "").trim().toLowerCase());
  // The flag rides EVERY row (pack-marketplace delta: listing/detail SHALL
  // carry it) — an empty roster means all-false, not a missing key.
  const withOfficial = (rows) => rows.map((p) => ({ ...p, official: isOfficial(p.authorEmail) }));

  // Publish (first version or next). Body: { packId?, manifest } — packId
  // targets an existing pack (author-checked); omitting it mints a new one.
  app.post("/api/packs", express.json({ limit: jsonLimit }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!mayPublish(user)) return res.status(403).json({ error: CREATOR_GROUP_REQUIRED });
    const manifest = req.body?.manifest;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : null;
    // Vendor attribution (pack-marketplace delta): declared at publish time,
    // verified against the caller's binding server-side — the manifest itself
    // never carries writeable attribution (design D4). The stamp rides the
    // stored VERSION row; display names resolve from the live profile at read.
    let vendorSlug = null;
    const vendorInput = typeof req.body?.vendor === "string" ? req.body.vendor.trim() : "";
    if (vendorInput) {
      if (!vendors) return res.status(400).json({ error: "Vendor attribution is not supported by this deployment", code: "vendor-unsupported" });
      const attr = vendors.attributionFor(user, vendorInput);
      if (attr.error) return res.status(attr.status).json(attr.body);
      vendorSlug = attr.slug;
    }
    // 价格声明（market-revenue-share, 版本级服务端字段）: pricing 块随发布
    // 提交、随版本 immutable 锁定——改价=新版本。合法性与署名同缝校验。
    let pricing = null;
    if (req.body?.pricing != null) {
      const parsed = parsePricing(req.body.pricing);
      if (parsed.error) return res.status(400).json({ error: `Invalid pricing: ${parsed.error}`, code: "invalid-pricing" });
      pricing = parsed.pricing;
    }
    // The gate sequence lives in collectPublishVerdict (creator-pack-forge-
    // support D1): publish answers the FIRST failing gate — status and body
    // byte-identical to the pre-extraction early returns — while the validate
    // route reports every item from the same collector. shortCircuit keeps
    // the pre-existing property that a rejection costs no registry round-trip.
    const verdict = await collectPublishVerdict(manifest, { shortCircuit: true, pricing, officialAuthor: isOfficial(user.email) });
    if (verdict.length > 0) return res.status(verdict[0].status).json(verdict[0].body);
    // Only publishes that pass validation count against the author's budget —
    // iterating on a manifest must not exhaust it. Invalid attempts store
    // nothing and cost only a pure-function validation. Admin groups are
    // exempt: the platform's own maintainers publish the internal catalog and
    // must not ride the public anti-abuse budget (10/h shipped default).
    if (!isAdmin(user) && !publishAllowed(user.email)) return res.status(429).json({ error: "Too many publishes, try again later" });
    const result = packId
      ? registry.publishVersion({ email: user.email, id: packId, manifest, vendor: vendorSlug, pricing })
      : registry.publish({ email: user.email, manifest, vendor: vendorSlug, pricing });
    if (result?.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    if (result?.error === "forbidden") return res.status(403).json({ error: "Only the pack author may publish new versions" });
    res.json(result);
  });

  // Dry-run validation (creator-pack-forge-support): the same gate sequence
  // publishing runs, reported without publishing. Any authenticated caller
  // may validate — creator-group eligibility is a caller finding, never a
  // rejection — and a validation call mints nothing, stores nothing, and
  // does not consume the publish-rate budget. It has its own limiter instead
  // (see validateAllowed), because the tool gate's live probe must not
  // become a probing amplifier.
  app.post("/api/packs/validate", express.json({ limit: jsonLimit }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!validateAllowed(user.email)) return res.status(429).json({ error: "Too many validation requests, try again later" });
    const manifest = req.body?.manifest;
    const packId = typeof req.body?.packId === "string" ? req.body.packId : null;
    const verdict = await collectPublishVerdict(manifest, { officialAuthor: isOfficial(user.email) });
    // Each item is exactly the reject body publishing would return at that
    // gate (wording, code, toolGate markers) — no translation layer.
    const errors = verdict.map((item) => item.body);
    // Continuation target: the read-only half of publishVersion's checks. A
    // bad target appends the same wording publish would return (404/403),
    // and nothing is created or modified for the caller to clean up.
    if (packId) {
      const pack = registry.packRowPublic(packId);
      if (!pack) errors.push({ error: "Pack not found" });
      else if (pack.author_email !== user.email) errors.push({ error: "Only the pack author may publish new versions" });
    }
    res.json({
      valid: errors.length === 0,
      errors,
      caller: mayPublish(user)
        ? { publishEligible: true }
        : { publishEligible: false, reason: CREATOR_GROUP_REQUIRED },
    });
  });

  // 覆盖度核算面 (overhaul-market-catalog-presentation 4.7): the author-side
  // translation workbench asks the SERVER the same question the publish gate
  // and the audit ask — one denominator module (lib/pack-locale-coverage), no
  // client re-derivation. Pure read: validates nothing, stores nothing,
  // mints nothing. Shape-tolerant (a half-authored draft must still get its
  // coverage numbers), so it runs localeCoverage over whatever the caller
  // compiled; a non-object manifest is an honest empty surface.
  app.post("/api/packs/coverage", express.json({ limit: jsonLimit }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const manifest = req.body?.manifest;
    const raw = typeof req.body?.locale === "string" ? req.body.locale : "en";
    const locale = resolveLocale({ locale: raw });
    const safe = manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : {};
    res.json({ coverage: localeCoverage(safe, locale) });
  });

  // Browse: paginated, searchable listing of live packs.
  app.get("/api/packs", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const { search = "", tag = "", category = "", domain = "", author = "", page, pageSize } = req.query;
    const payload = registry.list({
      search: String(search),
      tag: String(tag),
      category: String(category),
      // Domain axis (P1): a vocabulary slug; an unknown value simply matches
      // nothing (same honest-empty posture as any other filter).
      domain: String(domain),
      // `author=me` is the creator console's own-packs listing; any other
      // value is coerced to the viewer's email — you can only ever list
      // your own authorship, and the route's identity is the only source.
      author: author === "" ? "" : user.email,
      page, pageSize,
      viewer: { email: user.email, admin: isAdmin(user) },
      // Display locale (add-pack-locale-tracks B): explicit ?locale= first,
      // then Accept-Language's first tag, then zh. A zh (or absent) request
      // returns exactly the pre-change payload.
      locale: resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] }),
    });
    payload.packs = withOfficial(payload.packs);
    res.json(payload);
  });

  // Curation coverage board (5.4): authenticated read — it exposes every
  // stored pack's name incl. private/unlisted, the curation face's posture.
  // Registration BEFORE /:id like facets. locale defaults to en (the gate's
  // language); ?locale= overrides.
  app.get("/api/packs/curation/coverage", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const locale = resolveLocale({ locale: String(req.query.locale ?? "") });
    res.json({ packs: registry.coverageBoard({ locale }) });
  });

  // Browse facets (overhaul-market-catalog-presentation P1 2.4): the declared
  // taxonomy + per-value counts, anonymous-readable like the listing itself.
  // Registered BEFORE /:id so the literal path wins over the id route.
  app.get("/api/packs/facets", (req, res) => {
    const locale = resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });
    res.json(registry.facets({ locale }));
  });

  // Official showcase (add-official-pack-showcase): three segments aggregated
  // from the PUBLIC listing — team templates (blueprint badge), conversational
  // assistants (facade/assistant badge), and curated featured. Anonymous-
  // readable regardless of the anonymousRead switch: the endpoint exposes
  // public-face fields only, and a missing roster answers empty segments
  // (honest empty, not an error). Registered BEFORE /:id so the literal path
  // wins over the id route.
  app.get("/api/packs/official", (req, res) => {
    const locale = resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });
    const { packs } = registry.list({ pageSize: 100, viewer: { email: "", admin: false }, locale });
    const flagged = withOfficial(packs);
    res.json({
      // Segments are OFFICIAL assets: roster members only. The featured
      // segment keeps roster-external curated packs (D5: "运营推荐 ≠ 官方出品"
      // — they render without the badge, official first).
      templates: flagged.filter((p) => p.official && p.badge === "blueprint"),
      assistants: flagged.filter((p) => p.official && (p.badge === "facade" || p.badge === "assistant")),
      featured: flagged
        .filter((p) => p.featured)
        .sort((a, b) => Number(b.official ?? false) - Number(a.official ?? false)),
    });
  });

  // Curation write (add-facet-content-management): featured is admin-only,
  // category is author-or-admin. Presentation-level — never visibility,
  // versions, or installability.
  app.put("/api/packs/:id/curation", express.json({ limit: "4kb" }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const { category, featured, domains } = req.body ?? {};
    if (category !== undefined && (typeof category !== "string" || !/^[a-z0-9-]{0,32}$/.test(category))) {
      return res.status(400).json({ error: "category must be a slug of 0-32 chars [a-z0-9-]" });
    }
    if (featured !== undefined && typeof featured !== "boolean") {
      return res.status(400).json({ error: "featured must be a boolean" });
    }
    // Domain set (overhaul-market-catalog-presentation P1 2.7): vocabulary
    // slugs only — the curation surface offers a picker, never free text.
    if (domains !== undefined) {
      if (!Array.isArray(domains) || domains.some((d) => typeof d !== "string")) {
        return res.status(400).json({ error: "domains must be an array of vocabulary slugs" });
      }
      const unknown = domains.filter((d) => !isDomainSlug(d));
      if (unknown.length > 0) {
        return res.status(400).json({ error: `unknown domain slug(s): ${unknown.join(", ")}` });
      }
      if (domains.length > 3) {
        return res.status(400).json({ error: "at most 3 domains per pack" });
      }
    }
    const result = registry.setCuration({
      id: req.params.id,
      actor: { email: user.email, admin: isAdmin(user) },
      category,
      featured,
      domains,
    });
    if (result.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    if (result.error === "forbidden") {
      return res.status(403).json({ error: "Only the pack author may set the category or domains; only admins set featured" });
    }
    if (result.error === "invalid_domains") {
      return res.status(400).json({ error: "domains must be at most 3 vocabulary slugs" });
    }
    res.json(result);
  });

  // Visibility flip (add-facet-content-management): author-or-admin.
  app.put("/api/packs/:id/visibility", express.json({ limit: "1kb" }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const visibility = req.body?.visibility;
    if (visibility !== "public" && visibility !== "private") {
      return res.status(400).json({ error: 'visibility must be "public" or "private"' });
    }
    const result = registry.setVisibility({ id: req.params.id, actor: { email: user.email, admin: isAdmin(user) }, visibility });
    if (result.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    if (result.error === "forbidden") return res.status(403).json({ error: "The pack author or an admin is required" });
    res.json(result);
  });

  // Version history (add-facet-content-management; widened by
  // add-facet-version-history): follows the detail view's visibility — public
  // packs answer anyone (the anonymous viewer on the facet mount included),
  // private and unlisted packs stay author-or-admin, answering not-found so
  // probing teaches nothing (openspec: pack-visibility posture).
  app.get("/api/packs/:id/versions", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const pack = registry.packRowPublic(req.params.id);
    if (!pack) return res.status(404).json({ error: "Pack not found" });
    const author = pack.author_email === user.email;
    const admin = isAdmin(user);
    if (!registry.visibleTo(pack, user, { admin }) || (pack.unlisted && !author && !admin)) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const result = registry.versions(req.params.id);
    if (result.error === "not_found") return res.status(404).json({ error: "Pack not found" });
    res.json({ versions: result });
  });

  // Serving capability probe (add-selfhost-funnel-guidance, F3.1): registered
  // BEFORE /api/packs/:id so the literal path never falls into the :id
  // capture. Lets the deploy surface distinguish "this instance runs agent
  // serving" from the self-hosted shape — where the honest answer is the
  // official-market guidance panel, never a raw internal-config error.
  app.get("/api/packs/serving-status", (_req, res) => {
    const cfg = deployConfig();
    res.json({ configured: Boolean(cfg.runnerBaseUrl && cfg.registryUrl) });
  });

  // Latest-version detail. An unlisted pack stays visible to its author and
  // active subscribers; the author additionally sees the subscriber count.
  app.get("/api/packs/:id", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    const isSubscriber = Boolean(registry.subscription(user.email, id));
    const pack = registry.get(id, { includeUnlisted: isAuthor || isSubscriber });
    // Private packs answer not-found to everyone but the owner and admins —
    // indistinguishable from a nonexistent pack (openspec: pack-visibility).
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    // 装前闸数据源（market-revenue-share）：付费条目对调用者诚实呈现其
    // 当前权益——匿名/免费条目不置键；market store 缺席（legacy mount）亦缺省。
    if (pack.pricing && market && user.email) {
      pack.purchased = Boolean(market.activeEntitlement(user.email, id));
    }
    if (isAuthor) pack.subscriberCount = registry.subscriberCount(id);
    // Locale track (add-pack-locale-tracks B/D3): the browsing detail renders
    // in the requested locale — the top-level zh columns and the manifest's
    // display fields are overlaid together so a card and its dialog agree.
    // Stored-version reads below stay untouched: those are the install truth.
    const displayLocale = resolveLocale({ locale: req.query.locale, acceptLanguage: req.headers["accept-language"] });
    if (displayLocale !== "zh") {
      const projected = projectManifestForLocale(pack.manifest, displayLocale);
      if (typeof projected.name === "string" && projected.name.trim()) pack.name = projected.name;
      if (typeof projected.description === "string") pack.description = projected.description;
      // 标签列随 locale（5.3 验证条款）——与 list 面 applyLocaleToSummary 同律。
      if (Array.isArray(projected.tags) && projected.tags !== pack.manifest.tags) pack.tags = projected.tags;
      pack.manifest = projected;
    }
    // Read projection (add-packaged-skills D4): the detail payload carries the
    // file inventory, not the tree's contents — browsing stays cheap; the
    // per-file route below serves each body on demand.
    pack.manifest = projectManifestForDetail(pack.manifest);
    pack.official = isOfficial(pack.authorEmail);
    // Adopted provenance (add-official-adopted-agents D1): the SOURCE axis,
    // synthesized through the one projection so no surface can invent
    // "official-adopted" independently. `official` comes from the roster
    // judgment above — carrying provenance never grants official status, so a
    // non-roster pack with a provenance block stays `community` and the key is
    // simply absent (byte-identical payload for every legacy pack).
    const provenance = describeProvenance(pack.manifest, { official: pack.official });
    if (provenance.source !== PROVENANCE_SOURCE.COMMUNITY) {
      pack.provenance = {
        source: provenance.source,
        ...(provenance.adopted ? { adopted: provenance.adopted } : {}),
      };
    }
    // 覆盖度仪表 (overhaul-market-catalog-presentation 4.11): a secondary-track
    // request sees the honest en/…-coverage of the ORG SURFACE (server-side
    // truth — one module, same denominator as the publish gate and the audit;
    // it informs, it never gates: community entries keep every action usable).
    // zh requests need none — the main track IS the zh text.
    if (displayLocale !== "zh") {
      pack.coverage = localeCoverage(pack.manifest, displayLocale);
    }
    res.json(pack);
  });

  // A stored version is always retrievable, listed or not — but only under
  // the same visibility the listing applies (private ⇒ author/admin only,
  // otherwise not-found).
  app.get("/api/packs/:id/versions/:version", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const v = registry.getVersionVisible(req.params.id, req.params.version, user, { admin: isAdmin(user) });
    if (!v) return res.status(404).json({ error: "Pack version not found" });
    res.json(v);
  });

  // Per-file auxiliary content read (add-packaged-skills D4): the detail view
  // carries the path inventory; this route serves one file's body on demand
  // under the stored-version read's OWN visibility (anonymous callers read
  // public packs — "inspectable before subscribe" extended to the tree). The
  // path is re-validated through the same safePackagePath the publish
  // validator used, so a hostile URL cannot probe outside the file set.
  app.get("/api/packs/:id/versions/:version/skills/:skill/files/*", (req, res) => {
    const user = authRead(req);
    if (!user) return rejectUnauthenticated(req, res);
    const version = registry.getVersionVisible(req.params.id, req.params.version, user, { admin: isAdmin(user) });
    if (!version) return res.status(404).json({ error: "Pack version not found" });
    const wanted = String(req.params.skill).replace(/\.md$/, "");
    const skill = version.manifest?.skills?.find((s) => s.name === wanted);
    if (!skill || !skill.files || typeof skill.files !== "object" || Array.isArray(skill.files)) {
      return res.status(404).type("text/plain").send("file not found");
    }
    const rel = safePackagePath(String(req.params[0] ?? ""));
    if (!rel || skill.files[rel] === undefined) {
      return res.status(404).type("text/plain").send("file not found");
    }
    res.type("text/plain").send(skill.files[rel]);
  });

  // PUBLIC raw SKILL.md per pack skill (add-a2a-agent-serving D3): the
  // registry's skill registration fetches skill_md_url ANONYMOUSLY to
  // validate, so this route serves the body with synthesized frontmatter
  // (name/description from the manifest — pack skills are body-only) to any
  // caller. Pack skill bodies are already shown in full to every market
  // user; anonymous raw-md exposure is the same content, machine-shaped.
  // Registered before the authenticated routes; no auth check by design.
  app.get("/api/packs/:id/versions/:version/skills/:skill", (req, res) => {
    const version = registry.getVersion(req.params.id, req.params.version);
    // The URL always carries .md; normalize so the lookup never sees it (the
    // auth exemption matches on the .md suffix, path-to-regexp keeps it in
    // the param on some versions).
    const wanted = String(req.params.skill).replace(/\.md$/, "");
    const skill = version?.manifest?.skills?.find((s) => s.name === wanted);
    if (!skill) return res.status(404).type("text/plain").send("skill not found");
    // Fail-loud (add-packaged-skills D6): a tree skill must never be served
    // as a body-only twin — registry skill registration validates
    // skill_md_url against this route and would register a degraded copy.
    // The multi-file registry shape is a future change; per-file reads above
    // are the inspection path until then.
    if (skill.files && typeof skill.files === "object" && Object.keys(skill.files).length > 0) {
      return res.status(400)
        .type("text/plain")
        .send("this skill carries auxiliary files and cannot be served as a single document; read its files through the pack's per-file endpoints");
    }
    const fm = [`---`, `name: ${JSON.stringify(skill.name)}`, `description: ${JSON.stringify(skill.description)}`, `---`, ""].join("\n");
    res.type("text/markdown").send(`${fm}${skill.content}`);
  });

  // Deploy a stored version's serving-contract roles as Agent Services
  // (add-a2a-agent-serving 3.2). Idempotent per (pack, agent): the registry
  // entry is upserted in place and the bookkeeping row follows. Gate: the
  // pack's author or a creator-group member (the same population that may
  // publish). Env (`AGENT_SERVING_*`, falling back to the market vars) or an
  // injected `deployConfig` supplies the registry wiring; a missing runner
  // URL answers 503, not a silent success.
  //
  // Deploy-lock (add-funnel-acceptance): the whole write sequence — mint key
  // refs, push the registry descriptor, persist the key rows — must run
  // serialized per pack. Two concurrent deploys of the same pack interleave
  // the registry push and the table write in opposite orders and can leave
  // the registry entry pointing at a rotated-out billing key ref: the runner
  // fetches a dead ref, falls back to the shared key, and the deployer's key
  // silently stops billing (found live in production, hop ④ of the funnel
  // acceptance). A per-pack promise chain closes the window; different packs
  // still deploy in parallel.
  const deployHandler = async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    const isAuthor = registry.authorEmail(id) === user.email;
    // Deploy tenancy (add-deploy-tenancy D1): the author's deploy keeps the
    // legacy unsuffixed service address; any other deployer registers under
    // a stable per-identity segment — second deployers never touch the first
    // deployer's entry, key, or listeners.
    const deployerSeg = isAuthor ? "" : `/d${createHash("sha256").update(user.email).digest("hex").slice(0, 8)}`;
    // Private packs deploy for their owner (and admins) only — creators-group
    // strangers get the same not-found a nonexistent pack gives.
    const packRowRec = registry.packRowPublic(id);
    if (packRowRec?.visibility === "private" && !registry.visibleTo(packRowRec, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    if (!isAuthor && !mayPublish(user)) return res.status(403).json({ error: "Pack author or creator group required" });

    const version = registry.getVersion(id, req.params.version);
    if (!version) return res.status(404).json({ error: "Pack version not found" });

    const cfg = deployConfig();
    if (!cfg.runnerBaseUrl) {
      return res.status(503).json({ error: "Agent serving is not configured on this deployment (AGENT_SERVING_RUNNER_URL)" });
    }
    // Fleet placement (add-runner-fleet-sharding D2): an explicit runnerId
    // resolves against the fleet table (URL from THAT runner's base + port
    // geometry, descriptor tagged with its id); absent = the seeded default
    // row's geometry with an UNTAGGED descriptor — the legacy single-runner
    // contract, byte for byte. An unknown id is a 400 naming the fleet.
    // Multi-runner fleets AUTO-PLACE (add-fleet-scheduler): the untagged
    // default becomes the least-loaded healthy runner, stamped explicitly;
    // health blindness (single row, board unreachable) degrades to legacy.
    let runnerPlacement = {};
    const runnerIdBody = req.body?.runnerId;
    if (runnerIdBody !== undefined && (typeof runnerIdBody !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(runnerIdBody))) {
      return res.status(400).json({ error: "runnerId must be a runner id from the fleet list" });
    }
    // Desktop seat target (add-desktop-fleet-runner ③): seats are NOT fleet
    // rows — they live in the Wanxing facade's device registry. Ownership was
    // verified console-side, and the forwarded body carries the facade-signed
    // seatGrant; the grant is the only thing that authorizes a seat target
    // (public callers, direct or proxied, cannot mint one). A seat entry is
    // distribution-only: the seat's runner polls its slice over the public
    // registry, but the A2A upstream origin is unreachable by design (home
    // NAT) — the placeholder never serves; inbound service is the mailbox
    // protocol's slice (④).
    if (runnerIdBody != null && /^desktop-/i.test(runnerIdBody)) {
      const seatSecret = () => process.env.WANXING_SEAT_DEPLOY_SECRET || "";
      const grant = String(req.body?.seatGrant || "");
      const [expRaw, mac] = grant.split(".");
      const expMs = Number(expRaw);
      const valid = (() => {
        if (!seatSecret() || !mac || !Number.isFinite(expMs) || expMs < Date.now()) return false;
        const expect = createHmac("sha256", seatSecret()).update(`${runnerIdBody}|${user.email}|${expRaw}`).digest("hex");
        return mac === expect;
      })();
      if (!valid) {
        return res.status(403).json({ error: "desktop seat targets require a Wanxing console seat grant (pair the seat, deploy from the console)" });
      }
      runnerPlacement = { runnerId: runnerIdBody, runnerBaseUrl: "http://127.0.0.1:9", portBase: 8791, portSpan: 32, desktopSeat: true };
    }
    const fleetRows = registry.runnerList();
    // (Desktop seat targets were fully resolved above — the fleet lookup
    // below is for cloud fleet rows only.)
    if (runnerIdBody != null && !/^desktop-/i.test(runnerIdBody)) {
      const row = fleetRows.find((r) => r.id === runnerIdBody);
      if (!row) {
        return res.status(400).json({ error: `unknown runnerId '${runnerIdBody}' — the fleet holds: ${fleetRows.map((r) => r.id).join(", ") || "(none)"}` });
      }
      runnerPlacement = { runnerId: row.id, runnerBaseUrl: row.baseUrl, runnerPortBase: row.portBase, runnerPortSpan: row.portSpan };
    } else if (fleetRows.length > 1 && scheduler) {
      try {
        const board = await scheduler.boardNow();
        const target = scheduler.pickPlacement(board);
        if (target) {
          const row = fleetRows.find((r) => r.id === target.id);
          if (row) runnerPlacement = { runnerId: row.id, runnerBaseUrl: row.baseUrl, runnerPortBase: row.portBase, runnerPortSpan: row.portSpan };
        }
      } catch { /* health blindness → legacy default below */ }
    }
    if (runnerIdBody == null && Object.keys(runnerPlacement).length === 0 && fleetRows.length > 0) {
      const row = fleetRows[0];
      runnerPlacement = { runnerBaseUrl: row.baseUrl, runnerPortBase: row.portBase, runnerPortSpan: row.portSpan };
    }
    // Rhythm overrides (add-agent-residency D7): { "<agentId>": entries | null }
    // — deployer-set effective rhythm, validated under the same rules the
    // manifest enforces (one shape definition, two enforcement points).
    const rhythms = req.body?.rhythms;
    if (rhythms !== undefined) {
      if (!rhythms || typeof rhythms !== "object" || Array.isArray(rhythms)) {
        return res.status(400).json({ error: "rhythms must be an object of { agentId: rhythm entries }" });
      }
      for (const [agentId, entries] of Object.entries(rhythms)) {
        if (entries === null) continue; // explicit clear back to none
        const errs = validateRhythm(entries);
        if (errs.length > 0) {
          return res.status(400).json({ error: `rhythm override for '${agentId}' is invalid: ${errs[0].error}` });
        }
      }
    }
    // Turn-budget overrides (add-serving-budgets D2): { "<agentId>": minutes }
    // — the deployer's per-agent ceiling, validated under the same rule the
    // contract declares with. null = clear back to the contract declaration
    // (else absent → the runner's deployment default).
    const budgets = req.body?.budgets;
    if (budgets !== undefined) {
      if (!budgets || typeof budgets !== "object" || Array.isArray(budgets)) {
        return res.status(400).json({ error: "budgets must be an object of { agentId: minutes }" });
      }
      for (const [agentId, minutes] of Object.entries(budgets)) {
        if (minutes === null) continue; // explicit clear back to the contract
        const err = budgetMinutesError(minutes);
        if (err) {
          return res.status(400).json({ error: `budget override for '${agentId}' is invalid: ${err}` });
        }
      }
    }
    // Notification channel bindings (add-agent-notifications D2): { "<agentId>":
    // channel | null } — one admin-pre-bound channel name per serving agent.
    // Shape-validated here (a name the channel table can hold); existence is
    // NOT checked at deploy time — the channel table is live platform data and
    // an unknown/removed channel is refused structurally at send time by the
    // relay. null unbinds explicitly; an omitted agent keeps its live binding
    // (resolved against the registry entry inside deployToRegistry).
    const notifyChannel = req.body?.notifyChannel;
    if (notifyChannel !== undefined) {
      if (!notifyChannel || typeof notifyChannel !== "object" || Array.isArray(notifyChannel)) {
        return res.status(400).json({ error: "notifyChannel must be an object of { agentId: channel | null }" });
      }
      for (const [agentId, channel] of Object.entries(notifyChannel)) {
        if (channel === null) continue; // explicit unbind
        if (typeof channel !== "string" || !NOTIFY_CHANNEL_RE.test(channel)) {
          return res.status(400).json({
            error: `notifyChannel for '${agentId}' is invalid: a channel name matches [a-z0-9][a-z0-9._-]{0,63}`,
          });
        }
      }
    }
    const servingIds = new Set((version.manifest.agents ?? []).filter((a) => a?.serving).map((a) => a.id));
    // Agent subset selection (add-deploy-agent-selection / M4①): `agents`
    // names the serving agents THIS deploy composes — absent = every serving
    // agent, byte-identical to the pre-selection contract. A bad selection
    // refuses naming the entry before anything is touched.
    let deployIds = servingIds;
    const agentsBody = req.body?.agents;
    if (agentsBody !== undefined) {
      if (!Array.isArray(agentsBody) || agentsBody.length === 0) {
        return res.status(400).json({ error: "agents must be a non-empty array of serving agent ids" });
      }
      const picked = new Set();
      for (const id of agentsBody) {
        if (typeof id !== "string" || !id) {
          return res.status(400).json({ error: `agents entry ${JSON.stringify(id)} must be a serving agent id string` });
        }
        if (picked.has(id)) {
          return res.status(400).json({ error: `agents lists '${id}' twice — select each agent once` });
        }
        if (!servingIds.has(id)) {
          return res.status(400).json({ error: `agents entry '${id}' is not a serving agent of this pack (serving: ${[...servingIds].join(", ") || "(none)"})` });
        }
        picked.add(id);
      }
      deployIds = picked;
    }
    // Capacity waterline (add-opening-gates): only a deploy that brings NEW
    // children is gated — agents of this pack already in service don't count
    // (their redeploy/upgrade must never be wedged by capacity pressure, and
    // a subset deploy that adds agents is gated for exactly its new ones).
    // The gate reads the same board the placement just read: headroom =
    // budget_mb_limit − budget_mb. The placement target is checked first,
    // then the remaining healthy runners in the scheduler's order — the
    // first at or above the line admits. All below → 503 naming the best
    // candidate. Unknowable capacity (scheduler unarmed, board down)
    // degrades open, the same discipline as the model roster gate.
    {
      const inServiceIds = new Set(registry.deployments(id).map((d) => d.agentId));
      const newChildCount = [...deployIds].filter((aid) => !inServiceIds.has(aid)).length;
      if (newChildCount > 0 && scheduler && waterlineMb > 0) {
        try {
          const board = await scheduler.boardNow();
          const headroomOf = (rid) => {
            const r = board?.runners?.[rid];
            if (!r || !Number.isFinite(r.budget_mb_limit)) return null;
            return r.budget_mb_limit - (r.budget_mb ?? 0);
          };
          const order = [];
          if (runnerPlacement.runnerId) order.push(runnerPlacement.runnerId);
          for (const r of scheduler.healthy(board)) if (!order.includes(r.id)) order.push(r.id);
          let best = null;
          let admitted = false;
          for (const rid of order) {
            const hr = headroomOf(rid);
            if (hr == null) continue;
            if (best == null || hr > best.headroom) best = { id: rid, headroom: hr };
            if (hr >= waterlineMb) {
              admitted = true;
              break;
            }
          }
          if (!admitted && best) {
            return res.status(503).json({
              error: `fleet at capacity — best runner '${best.id}' has ${Math.round(best.headroom)}MB headroom, below the ${waterlineMb}MB waterline; retry after existing agents drain`,
              code: "FLEET_AT_CAPACITY",
            });
          }
        } catch { /* board unreachable → degrade open */ }
      }
    }
    // Model choices (agent-service-config / ADR-0019): { "<agentId>": model |
    // null } — a deploy-time model rides the SAME write-time validation as a
    // later config write (shape here; whitelist + billing lanes below, once
    // the deployment keys resolved). null clears back to the declaration.
    const models = req.body?.models;
    if (models !== undefined) {
      if (!models || typeof models !== "object" || Array.isArray(models)) {
        return res.status(400).json({ error: "models must map agentId to a model identifier or null" });
      }
      for (const [agentId, model] of Object.entries(models)) {
        if (model === null) continue;
        if (!servingIds.has(agentId)) {
          return res.status(400).json({ error: `models.${agentId}: '${agentId}' is not a serving agent of this pack` });
        }
        const err = modelIdError(model);
        if (err) return res.status(400).json({ error: `models.${agentId}: ${err}` });
        const whitelist = (version.manifest.agents ?? []).find((a) => a.id === agentId)?.serving?.modelWhitelist;
        const wlErr = modelChoiceError({ model, whitelist, lanes: null });
        if (wlErr) return res.status(400).json({ error: `models.${agentId}: ${wlErr}` });
      }
    }
    // Harness choices (add-harness-adapter D5): { "<agentId>": harnessName } —
    // deploy-time overrides of the serving declaration's `harness`. Shape and
    // membership only here; the TARGET RUNNER gate below checks the runner can
    // actually host it (the same two-stage shape as model lanes → roster).
    const harnesses = req.body?.harnesses;
    if (harnesses !== undefined) {
      if (!harnesses || typeof harnesses !== "object" || Array.isArray(harnesses)) {
        return res.status(400).json({ error: "harnesses must map agentId to a harness name" });
      }
      for (const [agentId, harnessName] of Object.entries(harnesses)) {
        if (!servingIds.has(agentId)) {
          return res.status(400).json({ error: `harnesses.${agentId}: '${agentId}' is not a serving agent of this pack` });
        }
        if (typeof harnessName !== "string" || !harnessName.trim() || harnessName.length > 64) {
          return res.status(400).json({ error: `harnesses.${agentId}: harness must be a harness name (non-empty string, at most 64 chars)` });
        }
      }
    }
    // ── Platform billing linkage (add-agent-platform-ops D1–D3; revised by
    // revise-billing-key-acquisition) ─────────────────────────────────────
    // Degrades to the pre-③ behavior when no admin key is wired: no gate,
    // no keys — any pasted billingKeys are IGNORED (logged, never silent)
    // and the deploy proceeds on the runner's shared quota.
    // Linked, keys arrive FROM the deployer (paste flow): body.billingKeys
    // maps agentId → "sk-…" (minted by the deployer in their own panel
    // session via Logto SSO) or null (unbind — non-serving agents only).
    // Every serving agent MUST end up bound: no shared-quota fallback. The
    // platform never holds a sub2api password.
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    const panelUrl = process.env.SUB2API_PANEL_URL || "https://your-billing-panel.example";
    let billing = { linked: false };
    let billingKeys = {}; // agentId → pk_ reference (descriptor carries these)
    const billingKeyValues = new Map(); // keyRef → plaintext (never logged)
    const agentKeyValues = new Map(); // agentId → plaintext deployment key (lane checks only)
    const providedKeys = req.body?.billingKeys;
    const keyInvalid = (reason, detail) =>
      res.status(400).json({
        error: `billing key rejected (${reason})${detail ? `: ${detail}` : ""}`,
        code: "BILLING_KEY_INVALID",
        reason,
      });
    if (providedKeys !== undefined && (!providedKeys || typeof providedKeys !== "object" || Array.isArray(providedKeys))) {
      return res.status(400).json({ error: "billingKeys must map agentId to an sk-… key or null" });
    }
    if (sub2api && !sub2api.degraded()) {
      const check = await sub2api.selfCheck();
      if (!check.ok) {
        console.warn(`[packs] sub2api self-check failed — billing degraded: ${check.reason}`);
        if (providedKeys && Object.keys(providedKeys).length > 0) {
          console.warn("[packs] billing degraded — ignoring pasted billingKeys for this deploy");
        }
      } else {
        let account = null;
        try {
          account = await sub2api.findUserByEmail(user.email);
        } catch (err) {
          return res.status(502).json({ error: `billing account check failed: ${err.message}` });
        }
        if (!account) {
          return res.status(402).json({
            error: "no sub2api account for your email yet — sign in once via Logto at the billing panel to create it, then retry",
            code: "NO_SUB2API_ACCOUNT",
            panelUrl,
          });
        }
        registry.saveBillingAccount({ email: user.email, userId: account.userId });
        const floor = Number(process.env.DEPLOY_BALANCE_FLOOR ?? 0.5);
        let balance;
        try {
          balance = (await sub2api.readUser(account.userId)).balance;
        } catch (err) {
          return res.status(502).json({ error: `billing balance read failed: ${err.message}` });
        }
        if (balance <= floor) {
          return res.status(402).json({
            error: `insufficient balance (${balance.toFixed(2)}) — the deploy gate needs more than ${floor}. Recharge path: contact the operator.`,
            code: "INSUFFICIENT_BALANCE",
            balance,
            floor,
          });
        }
        billing = { linked: true, balance, floor };

        // Binding lifecycle (design D3): explicit null unbinds — non-serving
        // agents only, a serving key can only be replaced; omission keeps the
        // existing binding (revalidated below); bindings for agents that no
        // longer serve are dropped with the redeploy.
        const existing = new Map(registry.deploymentKeysForPack(id).map((k) => [k.agentId, k]));
        for (const [agentId, value] of Object.entries(providedKeys ?? {})) {
          if (!servingIds.has(agentId)) {
            if (value === null && existing.has(agentId)) {
              registry.deleteDeploymentKey(id, agentId);
              continue;
            }
            return keyInvalid("unknown-agent", agentId);
          }
          if (!deployIds.has(agentId)) {
            // A key aimed outside the selection would be minted but never
            // ride a descriptor — refuse rather than burn a binding.
            return keyInvalid("outside-selection", `'${agentId}' is not in this deploy's agent selection (${[...deployIds].join(", ")}) — paste keys for the agents being deployed`);
          }
          if (value === null) {
            return res.status(400).json({
              error: `billingKeys.${agentId}: a serving agent's key can only be replaced, not removed`,
              code: "BILLING_KEY_REQUIRED",
            });
          }
        }
        for (const agentId of existing.keys()) {
          if (!servingIds.has(agentId)) registry.deleteDeploymentKey(id, agentId);
        }

        // Kept bindings: deployed agents absent from this request ride their
        // existing reference into the new descriptor — after a liveness
        // revalidation (below, once the cheap layers passed). A dead kept key
        // refuses the deploy with replace guidance (the paste flow cannot
        // re-deliver an old value: the platform never echoes key values back).
        // Unselected serving agents are out of scope: their live entries keep
        // their bindings untouched (not revalidated, not required, not dropped).
        const kept = new Map();
        for (const agentId of deployIds) {
          if (providedKeys && Object.hasOwn(providedKeys, agentId)) continue;
          const k = existing.get(agentId);
          if (k?.keyValue) kept.set(agentId, k);
        }

        // Pasted keys: shape first (cheap), then duplicates — the network
        // layers (liveness → ownership) run last, each a short-circuit
        // (design D2).
        const pasted = new Map();
        for (const [agentId, key] of Object.entries(providedKeys ?? {})) {
          if (!servingIds.has(agentId) || key === null) continue;
          if (typeof key !== "string" || !/^sk-/.test(key) || key.length > 256) {
            return keyInvalid("shape", `billingKeys.${agentId} must be a sub2api key (sk-…)`);
          }
          pasted.set(agentId, key);
        }
        const seenValues = [...kept.values()].map((k) => k.keyValue);
        for (const key of pasted.values()) {
          if (seenValues.includes(key)) {
            return keyInvalid("duplicate", "one key cannot serve two agents of this pack — create one per agent in the panel");
          }
          seenValues.push(key);
        }

        for (const [agentId, k] of kept) {
          const live = await sub2api.probeKeyLiveness(k.keyValue);
          if (!live.ok) {
            return keyInvalid("liveness", `the bound key for ${agentId} is no longer usable (${live.code ?? live.message}) — paste a fresh key from the billing panel to replace it`);
          }
          billingKeys[agentId] = k.keyRef;
          agentKeyValues.set(agentId, k.keyValue);
        }
        for (const [agentId, key] of pasted) {
          const live = await sub2api.probeKeyLiveness(key);
          if (!live.ok) {
            return keyInvalid("liveness", `the key for ${agentId} was refused by the billing panel (${live.code ?? live.message})`);
          }
          const holder = await sub2api.findUserByKey(key);
          if (!holder || holder.userId !== account.userId) {
            return keyInvalid("ownership", `the key for ${agentId} does not belong to your sub2api account`);
          }
        }
        for (const [agentId, key] of pasted) {
          const ref = `pk_${randomBytes(12).toString("hex")}`;
          billingKeys[agentId] = ref;
          billingKeyValues.set(ref, key);
          agentKeyValues.set(agentId, key);
        }

        // Every deployed agent must end up with a key — the paste flow's
        // admission rule, aligned with "the deployer pays for what serves".
        // Unselected serving agents are exempt this round (add-deploy-agent-
        // selection): their absence of a binding changes nothing for a deploy
        // that does not touch their entries.
        for (const agentId of deployIds) {
          if (billingKeys[agentId] == null) {
            return res.status(400).json({
              error: `agent '${agentId}' is a serving agent and needs a sub2api key — create one in your billing panel (Logto sign-in) and paste it here`,
              code: "BILLING_KEY_REQUIRED",
              panelUrl,
            });
          }
        }

        // Deploy-time model choices ride the SAME lane validation as a later
        // config write (agent-service-config D2): the deployment key's live
        // sub2api group lanes ∩ the contract whitelist — a refusal here means
        // no agent entry ever carries an unauthorized lane (no boot-then-404).
        const requestedModels = Object.entries(models ?? {}).filter(([, m]) => m != null);
        if (requestedModels.length > 0) {
          const lanesByAgent = new Map();
          for (const [agentId, model] of requestedModels) {
            if (!lanesByAgent.has(agentId)) {
              let lanes;
              try {
                lanes = await sub2api.listKeyModels(agentKeyValues.get(agentId));
              } catch (err) {
                return res.status(502).json({ error: `billing lane check failed for '${agentId}': ${err.message}` });
              }
              lanesByAgent.set(agentId, lanes);
            }
            const whitelist = (version.manifest.agents ?? []).find((a) => a.id === agentId)?.serving?.modelWhitelist;
            const err = modelChoiceError({ model, whitelist, lanes: lanesByAgent.get(agentId) });
            if (err) return res.status(400).json({ error: `models.${agentId}: ${err}`, code: "MODEL_LANE_REJECTED" });
          }
        }
        // Runner roster gate (add-deploy-roster-gate): lanes authorize the
        // KEY; the roster is what the PLACED runner's dsh tree can resolve —
        // a lane-passing, roster-absent model fails silently in the child
        // (empty answer, billed as a turn). Degrades open when the roster is
        // unknowable (scheduler unarmed, board unreachable, older runner
        // image without the heartbeat field) — observability gaps never
        // block a deploy.
        if (requestedModels.length > 0 && scheduler) {
          try {
            const board = await scheduler.boardNow();
            const rosterRunnerId = runnerPlacement.runnerId ?? registry.runnerList()[0]?.id ?? null;
            const roster = rosterRunnerId ? board?.runners?.[rosterRunnerId]?.models : null;
            if (Array.isArray(roster)) {
              for (const [agentId, model] of requestedModels) {
                const err = modelChoiceError({ model, roster });
                if (err) return res.status(400).json({ error: `models.${agentId}: ${err}`, code: "MODEL_NOT_IN_ROSTER" });
              }
            }
          } catch { /* board unreachable → degrade open */ }
        }
      }
    } else if (providedKeys && Object.keys(providedKeys).length > 0) {
      console.warn("[packs] billing not linked — ignoring pasted billingKeys for this deploy");
    }
    // No billing linkage (unlinked, degraded, or failed self-check) = no
    // deployment key = no lanes to validate model choices against — the
    // allowlist route's stance: the inactive plane refuses, never silently
    // passes unvalidated.
    if (!billing.linked && models && Object.values(models).some((m) => m != null)) {
      return res.status(503).json({ error: "billing plane not configured — model lanes cannot be validated" });
    }

    // ── Runner harness gate (add-harness-adapter D5) ────────────────────────
    // The declared/overridden harness must be one the PLACED runner hosts —
    // the same shape as the model roster gate: the runner's heartbeat reports
    // its adapter set; a harness the runner cannot host would fail every
    // cold start there. Degrades open when the runner's harness set is
    // unknowable (scheduler unarmed, board unreachable, older runner image).
    {
      const requestedHarness = new Map();
      for (const agent of version.manifest.agents ?? []) {
        if (agent?.serving === undefined) continue;
        if (!deployIds.has(agent.id)) continue;
        const overridden = harnesses && Object.hasOwn(harnesses, agent.id) ? harnesses[agent.id] : null;
        const declared = typeof agent.serving?.harness === "string" && agent.serving.harness ? agent.serving.harness : null;
        const effective = overridden ?? declared;
        if (effective) requestedHarness.set(agent.id, effective);
      }
      if (requestedHarness.size > 0 && scheduler) {
        try {
          const board = await scheduler.boardNow();
          const harnessRunnerId = runnerPlacement.runnerId ?? registry.runnerList()[0]?.id ?? null;
          const hosted = harnessRunnerId ? board?.runners?.[harnessRunnerId]?.harness : null;
          if (Array.isArray(hosted)) {
            for (const [agentId, harnessName] of requestedHarness) {
              if (!hosted.includes(harnessName)) {
                return res.status(400).json({
                  error: `harnesses.${agentId}: harness '${harnessName}' is not hosted by runner '${harnessRunnerId}' (hosted: ${hosted.join(", ") || "none"})`,
                  code: "HARNESS_NOT_HOSTED",
                });
              }
            }
          }
        } catch { /* board unreachable → degrade open */ }
      }
    }

    // ── Deployment secrets (add-deployment-secrets D1/D2/D5/D6) ─────────────
    // body.secrets maps agentId → { name: value | null }: arbitrary named
    // values the deployed agent needs at runtime (e.g. a content-repo token).
    // Same pipeline as billing keys — stored ONCE platform-side, an opaque ws_
    // reference rides the descriptor, the runner fetches by reference. Works
    // with or without the billing linkage. Lifecycle: omission keeps, null
    // unbinds one name, non-serving agents' bindings drop with the redeploy.
    const providedSecrets = req.body?.secrets;
    if (providedSecrets !== undefined && (!providedSecrets || typeof providedSecrets !== "object" || Array.isArray(providedSecrets))) {
      return res.status(400).json({ error: "secrets must map agentId to an object of { name: value | null }" });
    }
    const secretInvalid = (reason, detail) =>
      res.status(400).json({
        error: `deployment secret rejected (${reason})${detail ? `: ${detail}` : ""}`,
        code: "SECRET_INVALID",
        reason,
      });
    const secretRefs = {}; // agentId → { name: ref } (descriptor input)
    const secretMinted = []; // rows persisted once the registry push succeeded
    const secretDisplay = {}; // agentId → { name: design-D6 mask } (deploy surface)
    // ── Stale deployment bindings (add-deployment-binding-grant 2.3) ────────
    // A binding this deployment no longer carries must not leave a live token
    // on the connector: the secret row is dropped AND the PAT behind it is
    // revoked. Runs BEFORE the secret reconciliation below, so a pruned name
    // never enters `existing` and therefore never rides the new descriptor.
    let deploymentPrune = null;
    {
      const mintable = mintableBindings({ email: user.email, packId: id });
      try {
        deploymentPrune = await pruneDeploymentBindings({
          email: user.email,
          packId: id,
          agentIds: [...servingIds],
          keepKeys: mintable.map((b) => b.bindingKey),
          secrets: registry.deploymentSecretsForPack(id),
          remove: (agentId, name) => registry.deleteDeploymentSecret(id, agentId, name),
        });
        if (deploymentPrune.failed.length > 0 || deploymentPrune.code) {
          console.warn(
            `[packs] deployment binding prune for ${id}: ${deploymentPrune.code ?? ""} revoked=${deploymentPrune.revoked.length} failed=${deploymentPrune.failed.length}`,
          );
        }
      } catch (e) {
        console.warn(`[packs] deployment binding prune failed for ${id}: ${e?.message || e}`);
      }
    }
    {
      const existing = new Map(); // "agentId\u0000name" → row
      for (const r of registry.deploymentSecretsForPack(id)) existing.set(`${r.agentId}\u0000${r.name}`, r);
      const requested = Object.entries(providedSecrets ?? {});
      for (const [agentId, names] of requested) {
        if (!names || typeof names !== "object" || Array.isArray(names)) {
          return secretInvalid("shape", `secrets.${agentId} must be an object of { name: value | null }`);
        }
        if (servingIds.has(agentId) && !deployIds.has(agentId)) {
          // Its live registry entry is not being replaced this round — an
          // unbind here would strand the running agent off its binding.
          return secretInvalid("outside-selection", `secrets.${agentId}: '${agentId}' is serving but outside this deploy's agent selection — its live entry keeps its current bindings`);
        }
        for (const [name, value] of Object.entries(names)) {
          const where = `secrets.${agentId}.${name}`;
          if (!SECRET_NAME_RE.test(name)) return secretInvalid("name", `${where}: a secret name is [a-z0-9_]{1,32}`);
          if (value === null) {
            // A null aimed at a non-serving agent is cleanup only when a
            // binding exists; anything else aimed at a non-serving agent
            // refuses (the same rule billing keys follow).
            if (!servingIds.has(agentId) && !existing.has(`${agentId}\u0000${name}`)) {
              return secretInvalid("unknown-agent", `${where}: '${agentId}' is not a serving agent and has no such binding`);
            }
            continue;
          }
          if (typeof value !== "string" || value.length === 0) {
            return secretInvalid("shape", `${where} must be a non-empty string or null`);
          }
          if (Buffer.byteLength(value, "utf8") > SECRET_LIMITS.valueBytes) {
            return secretInvalid("size", `${where} exceeds the ${SECRET_LIMITS.valueBytes}-byte bound`);
          }
          if (!servingIds.has(agentId)) return secretInvalid("unknown-agent", `${where}: '${agentId}' is not a serving agent of this pack`);
        }
      }

      // Resulting bindings: kept (serving agents only) − nulled, then values
      // (a re-paste replaces under a fresh reference).
      const bound = new Map(); // agentId → Map(name → { ref, value, minted? })
      const unbound = []; // rows an explicit null takes out of the store
      for (const r of existing.values()) {
        if (!servingIds.has(r.agentId)) continue; // dropped below
        if (!bound.has(r.agentId)) bound.set(r.agentId, new Map());
        bound.get(r.agentId).set(r.name, { ref: r.secretRef, value: r.secretValue });
      }
      for (const [agentId, names] of requested) {
        for (const [name, value] of Object.entries(names)) {
          if (value === null) {
            if (bound.get(agentId)?.delete(name)) unbound.push({ agentId, name });
            continue;
          }
          const ref = `ws_${randomBytes(12).toString("hex")}`;
          if (!bound.has(agentId)) bound.set(agentId, new Map());
          bound.get(agentId).set(name, { ref, value, minted: true });
        }
      }
      // The count bound applies to the RESULTING per-agent set, not the
      // request: four names now and four more later would otherwise slip past.
      for (const [agentId, names] of bound) {
        if (names.size > SECRET_LIMITS.perAgent) {
          return secretInvalid("count", `'${agentId}' would hold ${names.size} secrets — the per-agent bound is ${SECRET_LIMITS.perAgent}`);
        }
      }
      // Store mutations run only once every validation passed. Explicit nulls
      // unbind their names; stale bindings drop with the redeploy (an agent
      // that left the serving set carries no secrets into the new descriptor).
      for (const { agentId, name } of unbound) registry.deleteDeploymentSecret(id, agentId, name);
      for (const r of existing.values()) {
        if (!servingIds.has(r.agentId)) registry.deleteDeploymentSecret(id, r.agentId, r.name);
      }
      for (const [agentId, names] of bound) {
        if (names.size === 0) continue;
        secretRefs[agentId] = {};
        secretDisplay[agentId] = {};
        for (const [name, entry] of names) {
          secretRefs[agentId][name] = entry.ref;
          secretDisplay[agentId][name] = maskSecretRef(entry.ref, entry.value);
          if (entry.minted) secretMinted.push({ agentId, name, ref: entry.ref, value: entry.value });
        }
      }
    }

    // Billing unlinked (or degraded): existing bindings cannot be revalidated,
    // so the descriptors pushed below carry no billing_key_ref for agents that
    // held one — the child silently stops running on its own key. The store
    // rows survive, but nothing else in this request surfaces the loss.
    if (!billing.linked) {
      const orphaned = registry
        .deploymentKeysForPack(id)
        .filter((k) => servingIds.has(k.agentId))
        .map((k) => k.agentId);
      if (orphaned.length > 0) {
        console.warn(
          `[packs] billing unlinked — cannot revalidate key binding(s) for ${orphaned.join(", ")}; this deploy's descriptors carry no billing_key_ref`,
        );
      }
    }

    let out;
    // Declared OUT here because the response body below reports it. While this
    // was declared inside the try, every deploy threw `ReferenceError:
    // deploymentBindings is not defined` while building the response — and
    // because the route swallows handler rejections (withDeployLock), the
    // request never answered at all instead of failing loudly.
    let deploymentBindings = null;
    try {
      // Fleet host map (fix-fleet-host-occupancy): occupancy grouped by
      // physical backend host — legacy untagged agents share the default
      // runner's port space with auto-placed tagged deploys on the same host.
      const fleetHostsByRunnerId = new Map(
        fleetRows
          .filter((r) => !/^desktop-/i.test(r.id))
          .map((r) => {
            try {
              return [r.id, new URL(r.baseUrl).hostname];
            } catch {
              return [r.id, null];
            }
          }),
      );
      const defaultRunnerHost = fleetHostsByRunnerId.get(fleetRows[0]?.id) ?? null;
      // Deployment-scoped connector bindings (add-deployment-binding-grant 3.x):
      // the mint must run BEFORE the descriptors are composed — they carry the
      // reference, not the token. Parent is the DEPLOYER's own account; the
      // token lands in deployment_secrets (value platform-side). A failure never
      // fails the deploy: an unresolved binding is reported, not fatal.
      const connectorBindings = {};
      try {
        const mintTargets = [...servingIds];
        deploymentBindings = await mintDeploymentBindings({
          email: user.email,
          packId: id,
          agentIds: mintTargets,
          record: (row) => registry.recordDeploymentSecret(row),
        });
        const origin = connectorBindingsModule.connectorOrigin();
        if (origin) {
          for (const granted of deploymentBindings.granted) {
            if (!granted.name) continue;
            // The VALUE travels the existing secret channel: the runner only
            // fetches names listed in descriptor.secret_refs, so the binding
            // secret has to be merged into that same map — otherwise the row
            // would point at a name nobody fetches.
            secretRefs[granted.agentId] ??= {};
            secretRefs[granted.agentId][granted.name] = `sec_${id}_${granted.agentId}_${granted.name}`;
            connectorBindings[granted.agentId] ??= [];
            connectorBindings[granted.agentId].push({
              // Same definition that names the cell-side row (mcp-client's
              // serverName alphabet is [A-Za-z0-9_-]{1,32} — see connector-bindings).
              serverName: connectorBindingsModule.bindingServerName(`${id}:${granted.bindingKey}`),
              url: `${origin}/mcp`,
              secretName: granted.name,
            });
          }
        }
      } catch (e) {
        console.warn(`[packs] deployment binding mint failed for ${id}: ${e?.message || e}`);
      }

      out = await deployToRegistry({
        packId: id,
        version: version.version,
        manifest: version.manifest,
        ...(agentsBody !== undefined ? { onlyAgents: [...deployIds] } : {}),
        connectorBindings,
        rhythmOverrides: rhythms ?? {},
        budgetOverrides: budgets ?? {},
        modelOverrides: models ?? {},
        harnessOverrides: harnesses ?? {},
        notifyChannels: notifyChannel ?? {},
        billingKeys,
        secretRefs,
        fleetHostsByRunnerId,
        defaultRunnerHost,
        pathSuffix: deployerSeg,
        ...cfg,
        ...runnerPlacement, // fleet row wins over the env default (sharding D2)
      });
    } catch (err) {
      const status = Number.isInteger(err?.status) && err.status >= 400 ? err.status : 502;
      return res.status(status).json({ error: err.message });
    }
    for (const d of out.deployed) {
      registry.recordDeployment({
        packId: id,
        agentId: d.agentId,
        version: version.version,
        agentPath: d.agentPath,
        skillPaths: d.skills,
        email: user.email,
      });
      // Persist the minted key value once the registry push succeeded. The
      // map was built keyed by agent id; missing entry = degraded minting.
      const keyRef = billingKeys[d.agentId];
      if (keyRef != null && billingKeyValues.has(keyRef)) {
        registry.recordDeploymentKey({
          packId: id, agentId: d.agentId, keyRef,
          keyValue: billingKeyValues.get(keyRef),
          deployer: user.email,
        });
      }
    }
    // Minted secret values persist only after the registry push succeeded —
    // the same rule deployment_keys follow. Kept bindings are already rows.
    const deployedIds = new Set(out.deployed.map((d) => d.agentId));
    for (const s of secretMinted) {
      if (!deployedIds.has(s.agentId)) continue;
      registry.recordDeploymentSecret({
        packId: id, agentId: s.agentId, name: s.name,
        secretRef: s.ref, secretValue: s.value,
        deployer: user.email,
      });
    }
    res.json({
      deployed: out.deployed.map((d) => ({
        agentId: d.agentId, agentPath: d.agentPath, skills: d.skills, card: d.card,
        ...(billingKeys[d.agentId] != null ? { billingKeyRef: billingKeys[d.agentId] } : {}),
        // Which secret names are bound rides the deploy surface; the value
        // and the plain reference never do (design D6 masks at most).
        ...(secretDisplay[d.agentId] ? { secretRefs: secretDisplay[d.agentId] } : {}),
      })),
      billing,
      effectiveWithinSecs: out.effectiveWithinSecs,
      // Which deployment bindings got a token, and which could not — names
      // only; the token itself never leaves the platform side. `revoked` is
      // the other half of the ledger: bindings this deploy stopped carrying
      // had their connector tokens revoked, not just their local rows dropped.
      ...(deploymentBindings
        ? {
            deploymentBindings: {
              granted: deploymentBindings.granted.map((g) => ({ agentId: g.agentId, bindingKey: g.bindingKey })),
              failed: deploymentBindings.failed.map((f) => ({ agentId: f.agentId, bindingKey: f.bindingKey, code: f.code })),
              revoked: deploymentPrune?.revoked?.length ?? 0,
            },
          }
        : {}),
    });
  };

  const deployLocks = new Map(); // packId → tail promise of the pack's deploy chain
  const withDeployLock = (packId, run) => {
    const prev = deployLocks.get(packId) ?? Promise.resolve();
    const next = prev.then(run, run);
    const settled = next.catch(() => {}).then(() => {
      if (deployLocks.get(packId) === settled) deployLocks.delete(packId);
    });
    deployLocks.set(packId, settled);
    return next;
  };
  app.post("/api/packs/:id/versions/:version/deploy", express.json({ limit: "64kb" }), (req, res) => {
    // The handler is async but this route never returns it to express, so an
    // escaping rejection does NOT reach express's error handling — it vanishes,
    // and the caller waits forever on a response nobody is going to send. That
    // is exactly how a one-line `ReferenceError` inside the handler became five
    // tests hanging for 90s each (12% of the unit lane) with no error anywhere.
    // Fail loudly: log the cause and answer 502 if nothing was sent yet.
    void withDeployLock(String(req.params.id), () => deployHandler(req, res)).catch((err) => {
      console.error(`[packs] deploy handler failed for ${req.params.id}:`, err?.stack || err?.message || err);
      if (res.headersSent) return;
      const status = Number.isInteger(err?.status) && err.status >= 400 ? err.status : 502;
      res.status(status).json({ error: err?.message || "deploy failed" });
    });
  });

  // The deployer's own billing state (add-agent-platform-ops D3; revised by
  // revise-billing-key-acquisition): the deploy surface's three-state readout
  // — account unresolved ("none"), resolved with balance ("ok"), or billing
  // unlinked (degraded). The mapping row is a cache: with no row, the
  // directory is consulted live and a hit is persisted for the deploy gate.
  app.get("/api/packs/billing/me", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const cfg = deployConfig();
    const panelUrl = process.env.SUB2API_PANEL_URL || "https://your-billing-panel.example";
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (!sub2api || sub2api.degraded()) return res.json({ linked: false, balance: null, accountState: null, panelUrl });
    let account = registry.billingAccount(user.email);
    if (!account) {
      try {
        const found = await sub2api.findUserByEmail(user.email);
        if (found) {
          registry.saveBillingAccount({ email: user.email, userId: found.userId });
          account = registry.billingAccount(user.email);
        }
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }
    if (!account) return res.json({ linked: true, balance: null, accountState: "none", panelUrl });
    try {
      const u = await sub2api.readUser(account.user_id);
      res.json({ linked: true, balance: u.balance, accountState: "ok", panelUrl });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // 花销读数(c) — 账户级粗粒度金额 (fleet-owner-surface C / design D3):
  // 部署者 sub2api 余额快照的窗口差消费。粒度刻意是账户级 —— 逐集群精算
  // 不属本平台（价格权在 sub2api 侧），口径随读面如实标注。快照读取侧
  // 节流写下 (≥55min), 差值 = 基线余额 − 当前余额 (正=期内消耗)。
  app.get("/api/packs/billing/snapshot", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const cfg = deployConfig();
    const panelUrl = process.env.SUB2API_PANEL_URL || "https://your-billing-panel.example";
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (!sub2api || sub2api.degraded()) {
      return res.status(503).json({ error: "billing snapshot source not configured", code: "billing-unavailable" });
    }
    let account = registry.billingAccount(user.email);
    if (!account) {
      try {
        const found = await sub2api.findUserByEmail(user.email);
        if (found) {
          registry.saveBillingAccount({ email: user.email, userId: found.userId });
          account = registry.billingAccount(user.email);
        }
      } catch (e) {
        return res.status(502).json({ error: e.message });
      }
    }
    if (!account) return res.json({ linked: true, balance: null, accountState: "none", snapshots: [], deltas: null, panelUrl });
    let balance = null;
    try {
      balance = (await sub2api.readUser(account.user_id)).balance;
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }
    const t = Date.now();
    const latest = registry.billingSnapshots(user.email, { limit: 1 })[0] ?? null;
    if (!latest || t - latest.sampledAt >= 55 * 60_000) {
      registry.recordBillingSnapshot({ email: user.email, userId: account.user_id, balanceUsd: balance, at: t });
    }
    const history = registry.billingSnapshots(user.email);
    const latestAt = history[0]?.sampledAt ?? null;
    const deltaFor = (windowMs) => {
      // 基线 = 最后一个早于窗口边界的快照; 无基线则如实 null（窗口未满）。
      const baseline = history.find((s) => s.sampledAt <= t - windowMs);
      if (!baseline) return null;
      return { spentUsd: Math.round((baseline.balanceUsd - balance) * 100) / 100, baselineAt: baseline.sampledAt };
    };
    const day = 24 * 3600_000;
    res.json({
      linked: true,
      balance,
      accountState: "ok",
      basis: "sub2api account ledger delta — 账户级粗粒度, 非集群级精算",
      sampledAt: latestAt,
      deltas: { "24h": deltaFor(day), "7d": deltaFor(7 * day), "30d": deltaFor(30 * day) },
      snapshots: history.slice(0, 30).map((s) => ({ balanceUsd: s.balanceUsd, sampledAt: s.sampledAt })),
      panelUrl,
    });
  });

  // Per-pack key binding state for the deploy surface: which of the pack's
  // currently-serving agents have a bound key. Booleans only — key values
  // and references never leave the platform.
  app.get("/api/packs/:id/billing-bindings", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const pack = registry.get(req.params.id, { includeUnlisted: true });
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const bound = new Set(registry.deploymentKeysForPack(req.params.id).map((k) => k.agentId));
    const out = {};
    for (const a of pack.manifest.agents ?? []) {
      if (a?.serving) out[a.id] = bound.has(a.id);
    }
    res.json(out);
  });

  // Per-pack secret binding state for the deploy surface (spec: bindings are
  // visible, values are not): which names are bound per serving agent. Names
  // ONLY — references, values, and masks never leave this route.
  app.get("/api/packs/:id/secret-bindings", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const pack = registry.get(req.params.id, { includeUnlisted: true });
    if (!pack || !registry.visibleTo({ visibility: pack.visibility, author_email: pack.authorEmail }, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const out = {};
    for (const a of pack.manifest.agents ?? []) {
      if (a?.serving) out[a.id] = [];
    }
    for (const r of registry.deploymentSecretsForPack(req.params.id)) {
      if (out[r.agentId]) out[r.agentId].push(r.name);
    }
    for (const names of Object.values(out)) names.sort();
    res.json(out);
  });

  // Billing board (add-agent-platform-ops D5): one read for the ops console —
  // deployed agents with their key refs, per-deployer balances, and the
  // linkage state. Authenticated like the internal key route (runner service
  // credential) or by an admin user.
  app.get("/api/packs/billing/board", async (req, res) => {
    const cfg = deployConfig();
    const token = cfg?.token || "";
    const asAdmin = (() => {
      const user = resolveUser(req);
      return user && adminGroups.some((g) => (user.groups || []).includes(g));
    })();
    if (!asAdmin && (!token || req.headers.authorization !== `Bearer ${token}`)) {
      return res.status(401).json({ error: "admin or runner service credential required" });
    }
    const keys = registry.listDeploymentKeys();
    let balances = [];
    let degraded = true;
    const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
    if (sub2api && !sub2api.degraded()) {
      try {
        const emails = [...new Set(keys.map((k) => k.deployer))];
        balances = await Promise.all(
          emails.map(async (email) => {
            const acct = registry.billingAccount(email);
            if (!acct) return { email, balance: null };
            const u = await sub2api.readUser(acct.user_id);
            return { email, balance: u.balance, status: u.status };
          }),
        );
        degraded = false;
      } catch (e) {
        console.warn(`[packs] billing board balance read failed: ${e.message}`);
      }
    }
    res.json({ degraded, keys, balances });
  });

  // Internal: the runner fetches a deployed agent's billing key by reference
  // (add-agent-platform-ops D2). Authenticated by the runner's REGISTRY
  // service credential — the same trust plane the runner already uses for
  // packs data; NOT a public predicate. Every fetch is audit-logged.
  app.get("/api/packs/internal/llm-key/:keyRef", (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "runner service credential required" });
    }
    const rec = registry.deploymentKeyByRef(req.params.keyRef);
    if (!rec || !rec.keyValue) return res.status(404).json({ error: "unknown or unkeyed deployment" });
    console.log(`[packs] llm-key fetched by runner (ref ${req.params.keyRef}, agent ${rec.agentId})`);
    res.json({ keyRef: req.params.keyRef, agentId: rec.agentId, keyValue: rec.keyValue });
  });

  // Internal: the runner fetches ONE deployment secret by reference
  // (add-deployment-secrets D3) — the same service-credential gate and audit
  // shape as the llm-key route above, one request per secret (simple, and the
  // audit stays per-secret). The audit line and every log use the D6 mask;
  // the value exists only in this response body.
  app.get("/api/packs/internal/secret/:ref", (req, res) => {
    const token = deployConfig()?.token || "";
    if (!token || req.headers.authorization !== `Bearer ${token}`) {
      return res.status(401).json({ error: "runner service credential required" });
    }
    const rec = registry.deploymentSecretByRef(req.params.ref);
    if (!rec) return res.status(404).json({ error: "unknown secret reference" });
    console.log(`[packs] deployment secret fetched by runner (ref ${maskSecretRef(rec.secretRef, rec.secretValue)}, agent ${rec.agentId}, name ${rec.name})`);
    res.json({ secretRef: rec.secretRef, agentId: rec.agentId, name: rec.name, secretValue: rec.secretValue });
  });

  // Internal: serving-plane deployment lookups (add-facet-platform S0). The
  // 万星 facade reads deployment bookkeeping over these read-only routes
  // instead of process-local registry access — extracting the marketplace
  // into the facet service (S1) repoints the facade's base-URL env and
  // nothing else. Same service-credential gate and shape as llm-key/secret
  // above. Registered BEFORE /api/packs/:id/deployments so the literal
  // "internal" path never falls into the :id capture.
  // Internal (service-credential) deployment/matter routes live in their own
  // module (N-9: 3.5k-line file, this block shares only `registry` + the
  // service gate). Registered at the same point so the literal "internal"
  // paths still precede the /api/packs/:id captures.
  registerInternalPackRoutes(app, { registry, deployConfig });
  // The two config routes below stayed here (their handlers thread the
  // console-verified-actor + tenancy helper); they answer the SAME service gate.
  const internalAuth = createInternalAuth(deployConfig);

  // Deployed roles of a pack (3.3): the unpublish warning's and the deploy
  // button's data. Online/offline health itself comes from the registry via
  // the catalog's a2a entries — this list is the "deployed" fact. The paused
  // flag (add-agent-residency) is a best-effort live read of each entry's
  // metadata; unreachable registry ⇒ flags omitted, never an error.
  app.get("/api/packs/:id/deployments", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    // Deploy tenancy: the viewer sees their OWN rows (the author of the pack
    // and admins see everything — they manage the pack's deployments).
    const all = registry.deployments(req.params.id);
    const isPackAuthor = registry.authorEmail(req.params.id) === user.email;
    const rows = isPackAuthor || isAdmin(user) ? all : all.filter((d) => d.deployedBy === user.email);
    const cfg = deployConfig();
    const paused = {};
    if (cfg.registryUrl) {
      for (const r of rows) {
        try {
          // cfg.fetchImpl (tests) wins; prod builds the real registry call.
          const doFetch =
            cfg.fetchImpl ??
            ((p, init = {}) =>
              fetch(`${cfg.registryUrl.replace(/\/+$/, "")}${p}`, {
                ...init,
                headers: { ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}), ...(init.headers ?? {}) },
              }));
          const entry = await (await doFetch(`/api/agents${r.agentPath}`)).json();
          paused[r.agentId] = entry?.metadata?.paused === true;
        } catch { /* flag omitted */ }
      }
    }
    res.json({ deployments: rows.map((r) => ({ ...r, paused: paused[r.agentId] ?? false })) });
  });

  // Owner-side matters (add-matter-threads D6): the principal's queue. The
  // list filters to the caller's own deployments (admins see the pack's
  // all); actions are deployer-or-admin gated with a same-shape 404 for
  // strangers — existence itself is not disclosed. Replies keep a closed
  // matter immutable (open a new one and cite the old).
  app.get("/api/packs/:id/matters", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const all = registry.mattersForPack(req.params.id);
    res.json({ matters: isAdmin(user) ? all : all.filter((m) => m.deployer === user.email) });
  });
  app.post("/api/packs/:id/matters/:mid/reply", express.json({ limit: "8kb" }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = registry.matterRead(req.params.mid);
    if (!m || m.packId !== req.params.id || (m.deployer !== user.email && !isAdmin(user))) {
      return res.status(404).json({ error: "no such matter" });
    }
    if (m.status === "closed") return res.status(409).json({ error: "matter is closed — open a new one" });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text || text.length > 2000) {
      return res.status(400).json({ error: "text must be a non-empty string of at most 2000 characters" });
    }
    registry.matterAppend(m.id, { kind: "reply", by: "owner", text, at: Date.now() }, "responded");
    res.json({ matter: registry.matterRead(m.id) });
  });
  app.post("/api/packs/:id/matters/:mid/close", express.json({ limit: "4kb" }), (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const m = registry.matterRead(req.params.mid);
    if (!m || m.packId !== req.params.id || (m.deployer !== user.email && !isAdmin(user))) {
      return res.status(404).json({ error: "no such matter" });
    }
    if (m.status === "closed") return res.status(409).json({ error: "matter is already closed" });
    const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : "";
    registry.matterAppend(m.id, { kind: "close", by: "owner", text: note, at: Date.now() }, "closed");
    res.json({ matter: registry.matterRead(m.id) });
  });

  // Pause/resume (add-agent-residency D5): deployer-facing, reversible — the
  // registry entry's metadata flag is the truth the runner polls. Kill = the
  // platform emergency stop writing the SAME flag through an admin gate; the
  // resume path is identical regardless of who paused. Undeploy is untouched.
  const pauseAction = (paused) => async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const id = req.params.id;
    // Deploy tenancy: the DEPLOYER owns the lifecycle of THEIR row — an
    // author who never deployed cannot pause someone else's service, and a
    // stranger gets the same not-found (existence not disclosed).
    const admin = isAdmin(user);
    const rows = registry.deployments(id).filter((d) => d.agentId === req.params.agentId);
    if (rows.length === 0) return res.status(404).json({ error: "Deployment not found" });
    const row = rows.find((d) => d.deployedBy === user.email) ?? (admin ? rows[0] : null);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused });
      res.json({ ...out, effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };
  app.post("/api/packs/:id/deployments/:agentId/pause", pauseAction(true));
  app.post("/api/packs/:id/deployments/:agentId/resume", pauseAction(false));

  // The platform emergency stop (add-agent-residency D5): admin-gated, writes
  // the same paused flag — a deployer resume restores.
  app.post("/api/packs/:id/deployments/:agentId/kill", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!isAdmin(user)) return res.status(403).json({ error: "Admin group required" });
    const row = registry.deployments(req.params.id).find((d) => d.agentId === req.params.agentId);
    if (!row) return res.status(404).json({ error: "Deployment not found" });
    const cfg = deployConfig();
    if (!cfg.registryUrl) return res.status(503).json({ error: "Agent serving is not configured on this deployment" });
    try {
      const out = await setAgentPaused({ ...cfg, agentPath: row.agentPath, paused: true });
      res.json({ ...out, by: "platform", effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  });

  // ── Service config (agent-service-config): the deployment's rewriteable
  // run-parameter surface. Gated to the deployment's OWN deployer (the row's
  // deployed_by) or a platform admin — an author who never deployed cannot
  // rewrite someone else's service. The registry entry's metadata is the
  // store; writes merge three-state into config_overrides and re-resolve the
  // effective fields through the ONE precedence function the descriptor
  // compose uses.
  //
  // One core, two doors: the user-facing route (session identity) and an
  // internal twin under the packs-internal service credential carrying the
  // console-verified actor in x-acting-user/x-acting-groups. The 万星 console
  // proxies through the internal door so lane/whitelist enforcement exists
  // exactly once — the console cannot read the deployed manifest anyway.
  const configRow = (id, agentId, actor) => {
    const admin = adminGroups.some((g) => (actor.groups || []).includes(g));
    const all = registry.deployments(id).filter((d) => d.agentId === agentId);
    // Deploy tenancy: the caller's OWN row first; admins fall back to the
    // first row (they manage all).
    const row = all.find((d) => d.deployedBy === actor.email) ?? (admin ? all[0] : null);
    if (!row) return { error: [404, "Deployment not found"] };
    if (row.deployedBy !== actor.email && !admin) {
      return { error: [403, "The deployment's deployer or an admin is required"] };
    }
    const cfg = deployConfig();
    if (!cfg.registryUrl) return { error: [503, "Agent serving is not configured on this deployment"] };
    return { row, cfg };
  };
  const registryFetchFor = (cfg) =>
    cfg.fetchImpl ??
    ((p, init = {}) =>
      fetch(`${cfg.registryUrl.replace(/\/+$/, "")}${p}`, {
        ...init,
        headers: {
          // Body-bearing calls (config write GET-merge-PUT) hit the real
          // registry's strict parser: without this the PUT arrives as
          // text/plain and pydantic 422s the whole entry (live probe
          // 2026-10-07). Same default the deploy client (pick) carries.
          "Content-Type": "application/json",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
          ...(init.headers ?? {}),
        },
      }));

  // The manifest + serving block of the DEPLOYED version (overrides resolve
  // against the declaration the deployment actually carries, not latest).
  const deployedServing = (id, row) => {
    const version = registry.getVersion(id, row.version);
    const agent = (version?.manifest?.agents ?? []).find((a) => a.id === row.agentId);
    return { serving: agent?.serving ?? {}, manifest: version?.manifest ?? null };
  };

  const configReadCore = async ({ id, agentId, actor, res }) => {
    const found = configRow(id, agentId, actor);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { row, cfg } = found;
    try {
      const doFetch = registryFetchFor(cfg);
      const entry = await (await doFetch(`/api/agents${row.agentPath}`)).json();
      const overrides = entry?.metadata?.config_overrides ?? {};
      const { serving } = deployedServing(id, row);
      const resolved = resolveServiceConfig({ serving, overrides });
      const dimension = (pinned, declared, effective) => ({
        effective,
        source: pinned !== undefined ? "override" : declared !== undefined && declared !== null ? "declared" : "default",
        declared: declared ?? null,
        override: pinned ?? null,
      });
      // The model picker's option set (design D5): the deployment key's live
      // lanes, best-effort — an unavailable billing plane omits them rather
      // than failing the read (the write path still refuses unvalidated models).
      let lanes = null;
      try {
        const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
        const key = registry.deploymentKeysForPack(id).find((k) => k.agentId === row.agentId)?.keyValue;
        if (sub2api && !sub2api.degraded() && key) lanes = await sub2api.listKeyModels(key);
      } catch { /* advisory only */ }
      res.json({
        config: {
          rhythm: dimension(overrides.rhythm, serving.rhythm, resolved.rhythm),
          budgetMinutes: dimension(overrides.budgetMinutes, serving.budget?.turnMinutes, resolved.budgetMinutes),
          model: dimension(overrides.model, serving.model, resolved.model),
        },
        lanes,
        packVersion: row.version,
        effectiveWithinSecs: 300,
      });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };

  const configWriteCore = async ({ id, agentId, actor, body, res }) => {
    const found = configRow(id, agentId, actor);
    if (found.error) return res.status(found.error[0]).json({ error: found.error[1] });
    const { row, cfg } = found;
    const unknown = Object.keys(body).filter((k) => !["rhythm", "budgetMinutes", "model"].includes(k));
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown config key(s): ${unknown.join(", ")} (only rhythm, budgetMinutes, model)` });
    }
    // Shape layer (cheap): the same validators the manifest and the deploy
    // route enforce — one shape definition, three enforcement points.
    if (body.rhythm !== undefined && body.rhythm !== null) {
      const errs = validateRhythm(body.rhythm);
      if (errs.length > 0) return res.status(400).json({ error: `rhythm is invalid: ${errs[0].error}` });
    }
    if (body.budgetMinutes !== undefined && body.budgetMinutes !== null) {
      const err = budgetMinutesError(body.budgetMinutes);
      if (err) return res.status(400).json({ error: `budgetMinutes is invalid: ${err}` });
    }
    const { serving, manifest } = deployedServing(id, row);
    let modelRequested = false;
    if (body.model !== undefined && body.model !== null) {
      modelRequested = true;
      const err = modelIdError(body.model);
      if (err) return res.status(400).json({ error: `model is invalid: ${err}` });
      if (!manifest) return res.status(404).json({ error: "Deployed pack version no longer readable" });
      // Lane layer (the same one the deploy route runs): deployment key's
      // live sub2api group lanes ∩ the contract whitelist. The inactive
      // plane refuses — an unvalidatable model never lands on a live agent.
      const sub2api = cfg.sub2api ? createSub2apiClient(cfg.sub2api) : null;
      if (!sub2api || sub2api.degraded()) {
        return res.status(503).json({ error: "billing plane not configured — model lanes cannot be validated" });
      }
      const key = registry.deploymentKeysForPack(id).find((k) => k.agentId === row.agentId)?.keyValue;
      if (!key) return res.status(503).json({ error: "the deployment has no billing key bound — model lanes cannot be validated" });
      let lanes;
      try {
        lanes = await sub2api.listKeyModels(key);
      } catch (err) {
        return res.status(502).json({ error: `billing lane check failed: ${err.message}` });
      }
      const laneErr = modelChoiceError({ model: body.model, whitelist: serving.modelWhitelist, lanes });
      if (laneErr) return res.status(400).json({ error: laneErr, code: "MODEL_LANE_REJECTED" });
    }
    try {
      const doFetch = registryFetchFor(cfg);
      // GET-merge-PUT (setAgentPaused's discipline): the entry carries
      // whatever else the registry holds; config_overrides merge three-state
      // — a present key writes (null included: an explicit reset), an
      // omitted key keeps what the deployment already carries.
      const g = await doFetch(`/api/agents${row.agentPath}`);
      if (!g.ok) throw Object.assign(new Error(`registry GET ${row.agentPath} failed (${g.status})`), { status: 502 });
      const entry = await g.json();
      // Roster layer (add-config-roster-gate): the same third gate the deploy
      // route runs, resolved against the LIVE entry's hosting runner (the
      // entry's assignment is what the runner itself polls — the steady-state
      // truth). A lane-passing, roster-absent model pinned here would fail
      // silently in the child on every turn. Degrades open on the same three
      // observability-blind states as the deploy gate; a null clear is not a
      // model choice and never hits this.
      if (modelRequested && scheduler) {
        try {
          const board = await scheduler.boardNow();
          const rosterRunnerId = entry?.metadata?.runner_id ?? registry.runnerList()[0]?.id ?? null;
          const roster = rosterRunnerId ? board?.runners?.[rosterRunnerId]?.models : null;
          if (Array.isArray(roster)) {
            const err = modelChoiceError({ model: body.model, roster });
            if (err) return res.status(400).json({ error: err, code: "MODEL_NOT_IN_ROSTER" });
          }
        } catch { /* board unreachable → degrade open */ }
      }
      const overrides = { ...(entry?.metadata?.config_overrides ?? {}) };
      // URL + PUT-shape sanitation (live finding 2026-10-13): the GET answers
      // the PUBLIC display url, and writing it back (PUT or the register
      // fallback after a 422) stores a self-looping proxy target — four
      // entries lost their A2A route exactly this way. Rebuild the url from
      // the hosting runner's fleet geometry (the same formula the deploy
      // side and the failover scheduler use), and normalize provider/version
      // to the write model the strict PUT parser demands (the scheduler's
      // ladder). No resolvable fleet row (legacy bare deployment) keeps the
      // stored url untouched.
      const fleetRowsForUrl = registry.runnerList();
      const urlRunnerId = entry?.metadata?.runner_id ?? fleetRowsForUrl[0]?.id ?? null;
      const urlRow = fleetRowsForUrl.find((r) => r.id === urlRunnerId) ?? null;
      if (urlRow) {
        entry.url = `http://${new URL(urlRow.baseUrl).hostname}:${resolveAgentPort(entry, { base: urlRow.portBase ?? 8791, span: urlRow.portSpan ?? 32 })}`;
        entry.provider = { organization: "paas-pack", url: urlRow.baseUrl };
        entry.version = String(entry.version ?? "1");
      }
      for (const key of ["rhythm", "budgetMinutes", "model"]) {
        if (Object.hasOwn(body, key)) overrides[key] = body[key];
      }
      for (const key of Object.keys(overrides)) {
        if (overrides[key] === undefined) delete overrides[key];
      }
      entry.metadata = { ...(entry.metadata ?? {}), config_overrides: overrides };
      const resolved = resolveServiceConfig({ serving, overrides });
      if (resolved.rhythm) entry.metadata.effective_rhythm = resolved.rhythm;
      else delete entry.metadata.effective_rhythm;
      if (resolved.budgetMinutes != null) entry.metadata.effective_budget_minutes = resolved.budgetMinutes;
      else delete entry.metadata.effective_budget_minutes;
      if (resolved.model) entry.metadata.effective_model = resolved.model;
      else delete entry.metadata.effective_model;
      const put = await doFetch(`/api/agents${row.agentPath}`, { method: "PUT", body: JSON.stringify(entry) });
      if (!put.ok) {
        // The register route is the create-side twin of the upsert: the
        // registry's PUT validates a narrower payload shape than its own GET
        // returns (live finding 2026-10-07, 422 model_attributes_type — the
        // GET-expanded entry carries proxy fields PUT rejects), so a failed
        // PUT falls back to register — the exact ladder setAgentPaused rides.
        const reg = await doFetch("/api/agents/register", { method: "POST", body: JSON.stringify(entry) });
        if (!reg.ok) {
          const detail = await reg.json().catch(() => ({}));
          throw Object.assign(new Error(`registry write failed (${put.status}/${reg.status}): ${JSON.stringify(detail).slice(0, 200)}`), { status: 502 });
        }
      }
      console.log(`[packs] service config updated: ${row.agentPath} (${Object.keys(body).join(", ") || "no-op"}) by ${actor.email}`);
      res.json({ ok: true, config: overrides, effectiveWithinSecs: 300 });
    } catch (err) {
      res.status(Number.isInteger(err?.status) ? err.status : 502).json({ error: err.message });
    }
  };

  app.get("/api/packs/:id/deployments/:agentId/config", async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    return configReadCore({ id: req.params.id, agentId: req.params.agentId, actor: user, res });
  });

  app.put("/api/packs/:id/deployments/:agentId/config", express.json({ limit: "64kb" }), async (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    return configWriteCore({ id: req.params.id, agentId: req.params.agentId, actor: user, body: req.body ?? {}, res });
  });

  // Internal twin (the 万星 console's door): the packs-internal service
  // credential plus the actor the console already verified (its Logto
  // identity — email + groups). The actor headers are trustworthy BECAUSE the
  // service credential is: only the platform's own units hold it.
  const internalActor = (req, res) => {
    if (!internalAuth(req, res)) return null;
    const email = String(req.headers["x-acting-user"] || "").trim();
    if (!email) {
      res.status(400).json({ error: "x-acting-user required" });
      return null;
    }
    const groups = String(req.headers["x-acting-groups"] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { email, groups };
  };
  app.get("/api/packs/internal/deployments/:id/:agentId/config", async (req, res) => {
    const actor = internalActor(req, res);
    if (!actor) return;
    return configReadCore({ id: req.params.id, agentId: req.params.agentId, actor, res });
  });
  app.put("/api/packs/internal/deployments/:id/:agentId/config", express.json({ limit: "64kb" }), async (req, res) => {
    const actor = internalActor(req, res);
    if (!actor) return;
    return configWriteCore({ id: req.params.id, agentId: req.params.agentId, actor, body: req.body ?? {}, res });
  });

  // Unpublish: author-checked unlist. Unknown pack and foreign pack answer
  // identically (the revoke pattern — probing teaches nothing). Deployed
  // Agent Services are NOT cascaded (spec: undeploy is independent) — the
  // response names them so the UI can warn.
  app.post("/api/packs/:id/unpublish", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    if (!registry.setUnlisted({ email: user.email, id: req.params.id })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    res.json({ ok: true, deployments: registry.deployments(req.params.id) });
  });

  // Subscribe: records the subscription and hands back the full manifest of
  // the current version so the browser can drive its cell's install in one
  // round trip. Unlisted packs take no new subscribers.
  app.post("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    // Private packs install for their owner (and admins) only — everyone
    // else gets the not-found answer (openspec: pack-visibility).
    const pack = registry.packRowPublic(req.params.id);
    if (!registry.visibleTo(pack, user, { admin: isAdmin(user) })) {
      return res.status(404).json({ error: "Pack not found" });
    }
    const sub = registry.subscribe({ email: user.email, id: req.params.id });
    if (!sub) return res.status(404).json({ error: "Pack not found" });
    res.json({ packId: req.params.id, version: sub.version, manifest: sub.manifest });
  });

  app.delete("/api/packs/:id/subscribe", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    registry.unsubscribe({ email: user.email, id: req.params.id });
    res.json({ ok: true });
  });

  // 订阅跟新提示读面 (fleet-owner-iteration): 只交通不升级——订阅者看见的是
  //「有新版本」状态与变更摘要, 已装内容由既有显式升级语义管理。
  app.get("/api/packs/subscriptions/updates", (req, res) => {
    const user = auth(req, res);
    if (!user) return;
    const rows = registry
      .subscriptionsFor(user.email)
      .filter((r) => (r.latestVersion ?? 0) > (r.subscribedVersion ?? 0));
    res.json({ updates: rows });
  });
}
