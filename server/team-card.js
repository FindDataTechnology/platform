// server/team-card.js — the team card (openspec: add-agent-team-directory).
//
// A card is a PROJECTION, never a second copy of the team: the publication row
// carries only what the owner explicitly decided to publish (display name,
// description, visibility, caller allow-list, quotas), and every other field is
// derived from the live fleet + its members at read time. That is what keeps
// "team renamed" and "post deleted" from leaving stale cards behind, and it is
// why nothing here is editable inside the card.
//
// Two red lines from the spec, enforced structurally rather than by review:
//   • FIELD-LEVEL WHITELIST (design D3): the card is built by an object literal
//     naming every field. A new column on fleets/fleet_members therefore cannot
//     leak — it is simply not mentioned. A blacklist would leak the moment
//     someone adds a column.
//   • NO PROMPTS, NO MEMORY, NO KEYS: `skills[]`/`posts[]` carry the post's
//     external title and its id only — never target_id/pack_id (internal
//     identifiers), never a prompt body, never a billing-key reference.

import { createHash } from "node:crypto";
import { quotaResetAt } from "./team-serving-policy.js";

export const CARD_VISIBILITIES = Object.freeze(["private", "listed", "open"]);
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
// Handles are a URL segment; these four already name siblings under
// /api/teams/*, so a team claiming one would make the a2a door ambiguous
// (add-team-as-a2a-agent 3.3). Refused at publish, not silently shadowed.
export const RESERVED_HANDLES = Object.freeze(["cards", "directory", "preview", "for-fleet"]);
export const CARD_TEXT_MAX = 500;
export const CARD_NAME_MAX = 120;
export const CARD_CALLERS_MAX = 200;

// Ops-tunable defaults. The spec deliberately does not pin numbers; it pins that
// a default EXISTS, is readable, and that "unlimited" is not expressible.
export const DEFAULT_CARD_QUOTA = Object.freeze({
  callsPerDay: 200,
  tokensPerDay: 2_000_000,
  usdPerDay: 5,
});

/** Every field a card may ever carry. The whitelist, as data. */
export const CARD_FIELDS = Object.freeze([
  "name",
  "description",
  "version",
  "capabilities",
  "skills",
  "posts",
  "pricing",
  "availability",
  "trust",
]);

/**
 * The cell's public identity in the directory: a stable, non-reversible hash of
 * the owner email. Both sides compute it from the same email — the cell from
 * `ctx.cellUserEmail`, the gateway from `cell.email` — so a deep link
 * (`/teams/directory/:cellId/:handle`) addresses a cell without putting an
 * owner's personal address on a cross-user surface.
 */
export function cellIdFor(email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  if (!normalized) return "local";
  return `cell-${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

export function ensureTeamCardsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_cards (
    cell_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    fleet_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private',
    callers TEXT NOT NULL DEFAULT '[]',
    quota_calls_per_day INTEGER NOT NULL,
    quota_tokens_per_day INTEGER NOT NULL,
    quota_usd_per_day INTEGER NOT NULL,
    reception TEXT,
    published_by TEXT NOT NULL DEFAULT '',
    published_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(cell_id, handle)
  )`);
  // `reception` arrived with add-team-as-a2a-agent (task 3.1): an OLD cell DB
  // already has the table, so CREATE IF NOT EXISTS alone would silently skip
  // the column. Additive ALTER in try/catch, same discipline as the turn-pricing
  // columns — a second boot is a no-op, not a throw.
  try {
    db.exec("ALTER TABLE team_cards ADD COLUMN reception TEXT");
  } catch {
    /* column already exists */
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_team_cards_fleet ON team_cards(cell_id, fleet_id)`);
  // The audit trail the spec asks for ("谁、何时、改了什么"). Append-only.
  db.exec(`CREATE TABLE IF NOT EXISTS team_card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_id TEXT NOT NULL,
    handle TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  )`);
}

export function deserializePublication(row) {
  if (!row) return null;
  return {
    cellId: row.cell_id,
    handle: row.handle,
    fleetId: row.fleet_id,
    displayName: row.display_name,
    description: row.description,
    visibility: row.visibility,
    callers: JSON.parse(row.callers || "[]"),
    quota: {
      callsPerDay: row.quota_calls_per_day,
      tokensPerDay: row.quota_tokens_per_day,
      usdPerDay: row.quota_usd_per_day,
    },
    // The team's single external entry point (add-team-as-a2a-agent). NULL on
    // rows published before the column existed — such a team is listed but not
    // callable, and the card says so rather than pretending otherwise.
    reception: typeof row.reception === "string" && row.reception ? row.reception : null,
    publishedBy: row.published_by,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function asText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/**
 * Validate a publish/patch body. Partial merge onto `base`, mirroring the voice
 * config block: a present field replaces, an absent one keeps the base, and an
 * illegal value is a refusal rather than a silent coercion.
 *
 * Quotas: a value that means "no limit" is NOT an error — it falls back to the
 * system default and the response says so (`fallbacks[]`). Refusing outright
 * would push an owner into retyping; silently accepting would be a loss switch.
 */
export function validatePublication(input, base = null) {
  const fail = (error, field) => ({ ok: false, error, field });
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return fail("publication must be an object");
  }

  const current = base ?? {
    displayName: "",
    description: "",
    visibility: "private",
    callers: [],
    quota: { ...DEFAULT_CARD_QUOTA },
    reception: null,
  };
  const out = {
    displayName: current.displayName,
    description: current.description,
    visibility: current.visibility,
    callers: [...current.callers],
    quota: { ...current.quota },
    reception: current.reception ?? null,
  };
  const fallbacks = [];

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case "handle": {
        if (typeof value !== "string" || !HANDLE_PATTERN.test(value.trim().toLowerCase())) {
          return fail("handle must be kebab-case (a-z, 0-9, '-'), 1-64 chars", "handle");
        }
        if (RESERVED_HANDLES.includes(value.trim().toLowerCase())) {
          return fail(`handle '${value.trim().toLowerCase()}' is reserved by the platform`, "handle");
        }
        out.handle = value.trim().toLowerCase();
        break;
      }
      case "displayName": {
        if (typeof value !== "string") return fail("displayName must be a string", "displayName");
        if (value.trim().length > CARD_NAME_MAX) return fail(`displayName exceeds ${CARD_NAME_MAX} characters`, "displayName");
        out.displayName = asText(value, CARD_NAME_MAX);
        break;
      }
      case "description": {
        if (typeof value !== "string") return fail("description must be a string", "description");
        if (value.trim().length > CARD_TEXT_MAX) return fail(`description exceeds ${CARD_TEXT_MAX} characters`, "description");
        out.description = asText(value, CARD_TEXT_MAX);
        break;
      }
      case "visibility": {
        if (!CARD_VISIBILITIES.includes(value)) {
          return fail(`visibility must be one of ${CARD_VISIBILITIES.join(", ")}`, "visibility");
        }
        out.visibility = value;
        break;
      }
      case "callers": {
        if (!Array.isArray(value)) return fail("callers must be an array", "callers");
        if (value.length > CARD_CALLERS_MAX) return fail(`callers exceeds ${CARD_CALLERS_MAX} entries`, "callers");
        const bad = value.find((c) => typeof c !== "string" || !c.trim());
        if (bad !== undefined) return fail("callers entries must be non-empty strings", "callers");
        out.callers = [...new Set(value.map((c) => c.trim().toLowerCase()))];
        break;
      }
      case "reception": {
        // Presence is allowed but must be a string id; WHICH post it points at
        // is checked against the live team in `publishCard` (only there do we
        // have the members). `null` clears it — a team that is listed but not
        // callable is a legal state (`no_reception` at call time).
        if (value === null) {
          out.reception = null;
          break;
        }
        if (typeof value !== "string" || !value.trim()) {
          return fail("reception must be a post id or null", "reception");
        }
        out.reception = value.trim();
        break;
      }
      case "callsPerDay":
      case "tokensPerDay":
      case "usdPerDay": {
        const n = typeof value === "number" ? value : Number.NaN;
        // Anything that would mean "unlimited" (null, Infinity, 0, negative,
        // non-numeric) falls back to the default and is REPORTED as a fallback.
        if (!Number.isFinite(n) || n <= 0) {
          out.quota[key] = DEFAULT_CARD_QUOTA[key];
          fallbacks.push({ field: key, value: DEFAULT_CARD_QUOTA[key], reason: "unlimited is not allowed; using the default" });
          break;
        }
        if (!Number.isInteger(n)) return fail(`${key} must be an integer`, key);
        out.quota[key] = n;
        break;
      }
      default:
        return fail(`unknown field '${key}'`, key);
    }
  }

  return { ok: true, normalized: out, fallbacks };
}

/**
 * Derive the card from the live team. Pure: same inputs → byte-identical output
 * (the spec requires deterministic derivation so two reads cannot disagree).
 */
export function deriveCard({ fleet, members = [], publication, now = Date.now() }) {
  const posts = members
    .filter((m) => m && m.targetKind === "a2a")
    .map((m) => ({ id: m.id, title: asText(m.title, CARD_NAME_MAX) || m.id }));

  return {
    name: publication.displayName || asText(fleet.name, CARD_NAME_MAX) || publication.handle,
    description: publication.description || "",
    // Card schema version — one field that lets phase 2 (registry) evolve the
    // shape without guessing at the reader.
    version: 1,
    capabilities: ["a2a"],
    // skills mirror posts today; kept separate because the a2a card vocabulary
    // is what an external client reads.
    skills: posts.map((p) => ({ id: p.id, name: p.title })),
    posts,
    pricing: {
      callsPerDay: publication.quota.callsPerDay,
      tokensPerDay: publication.quota.tokensPerDay,
      usdPerDay: publication.quota.usdPerDay,
      currency: "USD",
      // 4.4: the reset discipline is published WITH the limits, not discovered
      // by hitting one. UTC midnight, the same instant the call response and
      // the ledger use.
      resetsAt: quotaResetAt(now),
      // The a2a model bills the serving side — for now that is the team owner.
      // Stated on the card so a caller knows whose quota it is spending.
      billedTo: "team-owner",
    },
    availability: {
      state: fleet.state === "active" ? "accepting" : fleet.state === "paused" ? "paused" : "unavailable",
      accepting: fleet.state === "active" && publication.visibility !== "private",
      // `callable` is the CALL door, separate from `accepting` (the CALL door and
      // the SEE door are different questions — spec D4). A team with no
      // reception post is discoverable but cannot be called, and the card says
      // so instead of leaving the caller to find out with a failed request.
      callable: Boolean(publication.reception),
      reception: publication.reception ?? null,
    },
    trust: {
      publishedAt: publication.publishedAt ?? now,
      cellId: publication.cellId,
    },
  };
}

function recordEvent(db, { cellId, handle, action, actor, detail, now = Date.now() }) {
  db.prepare(
    `INSERT INTO team_card_events (cell_id, handle, action, actor, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(cellId, handle, action, actor ?? "", JSON.stringify(detail ?? {}), now);
}

export function getPublication(db, cellId, handle) {
  return deserializePublication(
    db.prepare("SELECT * FROM team_cards WHERE cell_id = ? AND handle = ?").get(cellId, handle),
  );
}

/** Every published card of this cell — the payload the gateway samples. */
export function listPublications(db) {
  return db
    .prepare("SELECT * FROM team_cards ORDER BY published_at DESC")
    .all()
    .map(deserializePublication);
}

/**
 * Publish (or re-publish) a team. The owner check lives here so both the route
 * and any future caller share one rule; the route turns `not_owner` into the
 * same 404 an unknown team produces (never leak existence).
 */
export function publishCard(db, { cellId, fleet, members = [], owner, input, now = Date.now() }) {
  if (!fleet) return { ok: false, code: "not_found", error: "fleet not found" };
  if (fleet.ownerEmail !== owner) return { ok: false, code: "not_owner", error: "not your fleet" };

  const handle = typeof input?.handle === "string" ? input.handle.trim().toLowerCase() : "";
  if (!HANDLE_PATTERN.test(handle)) {
    return { ok: false, code: "bad_request", error: "handle must be kebab-case (a-z, 0-9, '-'), 1-64 chars" };
  }

  const existing = getPublication(db, cellId, handle);
  if (existing && existing.fleetId !== fleet.id) {
    return { ok: false, code: "conflict", error: `handle '${handle}' is already used by another team` };
  }

  const validity = validatePublication(input, existing);
  if (!validity.ok) return { ok: false, code: "bad_request", error: validity.error, field: validity.field };
  const normalized = validity.normalized;

  // A team without a reception post cannot be called — say so at publish time
  // rather than at the first failed call (the spec allows either; refusing early
  // is the kinder of the two).
  const servingPosts = members.filter((m) => m.targetKind === "a2a");

  // Reception validation (add-team-as-a2a-agent 3.2): if declared, it must be a
  // CALLABLE post of THIS team. Pointing at a persona post or another team's
  // post would route stranger traffic into a seat that cannot answer it, and the
  // failure would surface as a confusing internal error much later.
  if (normalized.reception) {
    const post = members.find((m) => m.id === normalized.reception);
    if (!post) {
      return { ok: false, code: "bad_request", error: "reception must be one of this team's posts", field: "reception" };
    }
    if (post.targetKind !== "a2a") {
      return {
        ok: false,
        code: "bad_request",
        error: "reception must be an a2a post (a post that can receive calls)",
        field: "reception",
      };
    }
  }

  db.prepare(
    `INSERT INTO team_cards (
       cell_id, handle, fleet_id, display_name, description, visibility, callers,
       quota_calls_per_day, quota_tokens_per_day, quota_usd_per_day, reception,
       published_by, published_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(cell_id, handle) DO UPDATE SET
       fleet_id = excluded.fleet_id,
       display_name = excluded.display_name,
       description = excluded.description,
       visibility = excluded.visibility,
       callers = excluded.callers,
       quota_calls_per_day = excluded.quota_calls_per_day,
       quota_tokens_per_day = excluded.quota_tokens_per_day,
       quota_usd_per_day = excluded.quota_usd_per_day,
       reception = excluded.reception,
       published_by = excluded.published_by,
       updated_at = excluded.updated_at`,
  ).run(
    cellId,
    handle,
    fleet.id,
    normalized.displayName,
    normalized.description,
    normalized.visibility,
    JSON.stringify(normalized.callers),
    normalized.quota.callsPerDay,
    normalized.quota.tokensPerDay,
    normalized.quota.usdPerDay,
    normalized.reception ?? null,
    owner,
    existing?.publishedAt ?? now,
    now,
  );

  const publication = getPublication(db, cellId, handle);
  recordEvent(db, {
    cellId,
    handle,
    action: existing ? "update" : "publish",
    actor: owner,
    detail: {
      visibility: publication.visibility,
      from: existing ? existing.visibility : null,
      quota: publication.quota,
      fallbacks: validity.fallbacks,
      servingPosts: servingPosts.length,
    },
    now,
  });

  return { ok: true, publication, card: deriveCard({ fleet, members, publication, now }), fallbacks: validity.fallbacks, servingPosts: servingPosts.length };
}

/** Withdraw: the card disappears; the team and its data are untouched. */
export function deleteCard(db, { cellId, handle, owner, fleet, isAdmin = false, now = Date.now() }) {
  const existing = getPublication(db, cellId, handle);
  // Unknown and not-yours are the same answer — the caller returns a 404 for both.
  if (!existing) return { ok: false, code: "not_found" };
  const ownsFleet = fleet && fleet.ownerEmail === owner;
  if (!ownsFleet && !isAdmin) return { ok: false, code: "not_owner" };

  db.prepare("DELETE FROM team_cards WHERE cell_id = ? AND handle = ?").run(cellId, handle);
  recordEvent(db, { cellId, handle, action: "withdraw", actor: owner, detail: { byAdmin: !ownsFleet && isAdmin }, now });
  return { ok: true };
}

/** The cards a sampling gateway should see: everything not `private`. */
export function listVisibleCards(db, { fleetsById = new Map(), membersByFleet = new Map(), now = Date.now() } = {}) {
  const out = [];
  for (const publication of listPublications(db)) {
    if (publication.visibility === "private") continue;
    const fleet = fleetsById.get(publication.fleetId);
    if (!fleet) continue; // fleet deleted behind the card: it simply stops appearing
    out.push(deriveCard({ fleet, members: membersByFleet.get(publication.fleetId) ?? [], publication, now }));
  }
  return out;
}
