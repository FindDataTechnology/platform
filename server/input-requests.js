// ── Input requests (add-input-request-cards) ────────────────────────────────
//
// 平台原语「AI 向人要一次输入」的内核：卡片校验、一行持久记录、单向状态机、
// 无人应答策略、长轮询等待。表归本模块自建（CREATE TABLE IF NOT EXISTS，
// 幂等），照 model-budget.js 的先例，不进 fleets-db.js 的 schema 块。
//
// 三条纪律（design D3/D4/D5）：
//   1. 状态只以行为真源。进程内只有「谁在等这个连接」的等待表，没有任何
//      待答状态的副本——换实例、重连、多端并发都从行上读。
//   2. 先答者生效靠一条条件 UPDATE 的受影响行数，不引入锁。
//   3. 卡片类型与字段类型是封闭集合，未知形状在提卡时就被拒，不静默降级。

const SETTLED_STATES = new Set(["answered", "cancelled", "expired", "escalated"]);

export const CARD_TYPES = Object.freeze(["form", "confirm", "choice"]);
export const FIELD_KINDS = Object.freeze([
  "text",
  "multiline",
  "number",
  "date",
  "enum",
  "boolean",
  "file",
]);
export const UNATTENDED_POLICIES = Object.freeze(["wait", "default", "abort", "escalate"]);

export const DEFAULT_TTL_SEC = 600;
export const DEFAULT_POLICY = Object.freeze({
  onUnattended: "escalate",
  ttlSec: DEFAULT_TTL_SEC,
  answerableBy: "owner",
});

export class InputRequestError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "InputRequestError";
    this.code = code;
    this.details = details;
  }
}

export function ensureInputRequestSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS input_requests (
    id TEXT PRIMARY KEY,
    owner_email TEXT NOT NULL,
    session_id TEXT,
    fleet_id TEXT,
    member_id TEXT,
    turn_id TEXT,
    card TEXT NOT NULL,
    policy TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    answer TEXT,
    answered_by TEXT,
    answered_at INTEGER,
    expires_at INTEGER NOT NULL,
    escalated_decision_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_input_requests_pending ON input_requests(state, expires_at)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_input_requests_session ON input_requests(session_id, state)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_input_requests_owner ON input_requests(owner_email, state)`,
  );
  // 每回合配额要按 (session, turn) 数数（design D8）。turn_id 可空：没有回合
  // 登记的通道写入 null，配额退化为「本会话在途请求数」。
  try {
    db.exec(`ALTER TABLE input_requests ADD COLUMN turn_id TEXT`);
  } catch {
    /* column already exists */
  }
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_input_requests_turn ON input_requests(session_id, turn_id)`,
  );
}

// ── 卡片校验 ────────────────────────────────────────────────────────────────

function fieldError(key, message) {
  return { field: key, message };
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => {
      if (typeof o === "string") return { value: o, label: o };
      if (o && typeof o === "object" && typeof o.value === "string") {
        return { value: o.value, label: typeof o.label === "string" ? o.label : o.value };
      }
      return null;
    })
    .filter((o) => o !== null);
}

/**
 * Validate + normalize one card. Returns { card } on success, throws
 * InputRequestError("invalid_card", …, {errors}) otherwise. Unknown field kinds
 * are refused here — a card that silently degrades to plain text is exactly the
 * failure this primitive exists to avoid.
 */
export function validateCard(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InputRequestError("invalid_card", "card must be an object");
  }
  const type = String(raw.type ?? "form");
  if (!CARD_TYPES.includes(type)) {
    throw new InputRequestError("invalid_card", `unsupported card type '${type}'`, {
      errors: [fieldError("type", `type must be one of ${CARD_TYPES.join(" / ")}`)],
    });
  }
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) {
    throw new InputRequestError("invalid_card", "card.title is required", {
      errors: [fieldError("title", "required")],
    });
  }
  const detail = typeof raw.detail === "string" ? raw.detail : null;

  const rawFields = Array.isArray(raw.fields) ? raw.fields : [];
  const errors = [];
  const fields = [];
  for (const f of rawFields) {
    if (!f || typeof f !== "object") {
      errors.push(fieldError("fields", "field entries must be objects"));
      continue;
    }
    const key = typeof f.key === "string" ? f.key.trim() : "";
    if (!key) {
      errors.push(fieldError("fields", "every field needs a key"));
      continue;
    }
    const kind = String(f.kind ?? f.type ?? "text");
    if (!FIELD_KINDS.includes(kind)) {
      errors.push(
        fieldError(key, `unsupported field kind '${kind}' (allowed: ${FIELD_KINDS.join(", ")})`),
      );
      continue;
    }
    const options = kind === "enum" ? normalizeOptions(f.options) : [];
    if (kind === "enum" && options.length === 0) {
      errors.push(fieldError(key, "enum fields must declare options"));
      continue;
    }
    fields.push({
      key,
      kind,
      label: typeof f.label === "string" && f.label.trim() ? f.label.trim() : key,
      required: f.required === true,
      ...(typeof f.placeholder === "string" ? { placeholder: f.placeholder } : {}),
      ...(typeof f.unit === "string" ? { unit: f.unit } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
    });
  }

  // confirm / choice 是 form 的语法糖（design D4）：一个必填字段 + 固定的
  // 两个动作。语法糖不成立就拒绝，不猜调用方的意图。
  if (type === "confirm") {
    if (fields.length !== 1 || fields[0].kind !== "boolean") {
      errors.push(fieldError("fields", "confirm cards need exactly one boolean field"));
    }
  }
  if (type === "choice") {
    if (fields.length !== 1 || fields[0].kind !== "enum") {
      errors.push(fieldError("fields", "choice cards need exactly one enum field"));
    }
  }
  if (type === "form" && fields.length === 0) {
    errors.push(fieldError("fields", "form cards need at least one field"));
  }

  const actions = Array.isArray(raw.actions)
    ? raw.actions
        .filter((a) => a && typeof a.id === "string" && typeof a.label === "string")
        .map((a) => ({ id: a.id, label: a.label, kind: a.kind === "danger" ? "danger" : "primary" }))
    : [];

  if (errors.length > 0) {
    throw new InputRequestError("invalid_card", "card failed validation", { errors });
  }
  return { type, title, detail, fields, actions };
}

/** Validate submitted answers against the card. Returns [] when valid. */
export function validateAnswers(card, values) {
  const errors = [];
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return [fieldError("values", "answers must be a keyed object")];
  }
  for (const f of card.fields) {
    const v = values[f.key];
    const empty = v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) errors.push(fieldError(f.key, "required"));
      continue;
    }
    if (f.kind === "number" && !Number.isFinite(Number(v))) {
      errors.push(fieldError(f.key, "must be a number"));
    }
    if (f.kind === "boolean" && typeof v !== "boolean") {
      errors.push(fieldError(f.key, "must be a boolean"));
    }
    if (f.kind === "enum" && !f.options.some((o) => o.value === String(v))) {
      errors.push(fieldError(f.key, `must be one of ${f.options.map((o) => o.value).join(", ")}`));
    }
    if (f.kind === "file" && typeof v !== "string") {
      errors.push(fieldError(f.key, "must be a resource reference string"));
    }
  }
  const known = new Set(card.fields.map((f) => f.key));
  for (const key of Object.keys(values)) {
    if (!known.has(key)) errors.push(fieldError(key, "unknown field"));
  }
  return errors;
}

// ── 策略 ────────────────────────────────────────────────────────────────────

/**
 * Merge a declared policy over the defaults, per field. `null`/absent values
 * inherit — the same discipline the fleet's nullable config columns use.
 */
export function normalizePolicy(policy, card = null) {
  const src = policy && typeof policy === "object" ? policy : {};
  const onUnattended = UNATTENDED_POLICIES.includes(src.onUnattended)
    ? src.onUnattended
    : DEFAULT_POLICY.onUnattended;
  const ttlSecRaw = Number(src.ttlSec);
  const ttlSec =
    Number.isFinite(ttlSecRaw) && ttlSecRaw > 0 ? Math.round(ttlSecRaw) : DEFAULT_POLICY.ttlSec;
  const answerableBy =
    src.answerableBy === "any" || src.answerableBy === "deputy" ? src.answerableBy : "owner";
  if (onUnattended === "default" && card) {
    const hasDefault = card.fields.some((f) => f.default !== undefined);
    if (!hasDefault) {
      throw new InputRequestError(
        "invalid_policy",
        "policy 'default' requires the card to declare at least one default value",
        { errors: [fieldError("onUnattended", "no default value declared on the card")] },
      );
    }
  }
  return { onUnattended, ttlSec, answerableBy };
}

// ── 行操作 ──────────────────────────────────────────────────────────────────

function rowToRequest(row) {
  if (!row) return null;
  const parse = (text, fallback) => {
    if (typeof text !== "string" || !text) return fallback;
    try {
      return JSON.parse(text);
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    sessionId: row.session_id,
    fleetId: row.fleet_id,
    memberId: row.member_id,
    turnId: row.turn_id,
    card: parse(row.card, null),
    policy: parse(row.policy, null),
    state: row.state,
    values: parse(row.answer, null),
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    expiresAt: row.expires_at,
    escalatedDecisionId: row.escalated_decision_id,
    createdAt: row.created_at,
  };
}

/** The answer object handed back to the caller — one shape for every route. */
export function answerPayload(request) {
  return {
    requestId: request.id,
    state: request.state,
    values: request.values ?? null,
    answeredBy: request.answeredBy ?? null,
  };
}

export function getInputRequest(db, id) {
  ensureInputRequestSchema(db);
  return rowToRequest(db.prepare("SELECT * FROM input_requests WHERE id = ?").get(String(id)));
}

export function listPendingForOwner(db, ownerEmail, { sessionId = null, limit = 50 } = {}) {  ensureInputRequestSchema(db);
  const clauses = ["owner_email = ?", "state = 'pending'"];
  const params = [String(ownerEmail)];
  if (sessionId) {
    clauses.push("session_id = ?");
    params.push(String(sessionId));
  }
  params.push(Math.max(1, Math.min(200, Number(limit) || 50)));
  const rows = db
    .prepare(
      `SELECT * FROM input_requests WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...params);
  return rows.map(rowToRequest);
}

/** Every pending request of one session — the reconnect/sync rehydration read. */
export function listPendingForSession(db, sessionId) {
  if (!sessionId) return [];
  ensureInputRequestSchema(db);
  return db
    .prepare(
      "SELECT * FROM input_requests WHERE session_id = ? AND state = 'pending' ORDER BY created_at ASC",
    )
    .all(String(sessionId))
    .map(rowToRequest);
}

export function countPendingForFleet(db, fleetId) {
  ensureInputRequestSchema(db);
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM input_requests WHERE fleet_id = ? AND state = 'pending'",
    )
    .get(String(fleetId));
  return row?.n ?? 0;
}

/**
 * Create one request. Owner is mandatory: an owner-less row can never be
 * answered (owner-only enforcement) — the same dead end `propose_action` hit
 * when its bundled twin carried no proposer email.
 */
export function createInputRequest(
  db,
  { id, ownerEmail, sessionId = null, fleetId = null, memberId = null, turnId = null, card, policy = null, now = Date.now() },
) {
  if (!ownerEmail) {
    throw new InputRequestError("owner_required", "input requests need an owner email");
  }
  // 始终过一遍校验：调用方递来的可能是原始卡（字符串 options、缺 kind），
  // 也可能是已归一化的卡（校验对两者都幂等）。跳过校验会让未声明的字段
  // 类型直接落库——正是这个原语要拦住的事。
  const validCard = validateCard(card);
  const validPolicy = normalizePolicy(policy, validCard);
  ensureInputRequestSchema(db);
  const expiresAt = now + validPolicy.ttlSec * 1000;
  db.prepare(
    `INSERT INTO input_requests
      (id, owner_email, session_id, fleet_id, member_id, turn_id, card, policy, state, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(
    String(id),
    String(ownerEmail).toLowerCase(),
    sessionId,
    fleetId,
    memberId,
    turnId,
    JSON.stringify(validCard),
    JSON.stringify(validPolicy),
    expiresAt,
    now,
  );
  return getInputRequest(db, id);
}

/**
 * Answer one request. First-wins: the conditional UPDATE's affected-row count is
 * the arbiter, so two surfaces submitting at once cannot overwrite each other.
 * Returns { request, changed }.
 */
export function answerInputRequest(db, id, { values, answeredBy, now = Date.now() }) {
  ensureInputRequestSchema(db);
  const current = getInputRequest(db, id);
  if (!current) throw new InputRequestError("not_found", "input request not found");
  if (SETTLED_STATES.has(current.state)) {
    return { request: current, changed: false, reason: current.state };
  }
  const errors = validateAnswers(current.card, values);
  if (errors.length > 0) {
    throw new InputRequestError("invalid_answers", "answers failed validation", { errors });
  }
  const info = db
    .prepare(
      `UPDATE input_requests
          SET state = 'answered', answer = ?, answered_by = ?, answered_at = ?
        WHERE id = ? AND state = 'pending'`,
    )
    .run(JSON.stringify(values), String(answeredBy ?? current.ownerEmail), now, String(id));
  const changed = Number(info.changes) > 0;
  const request = getInputRequest(db, id);
  if (changed) notifyWaiters(id, request);
  return { request, changed, reason: changed ? null : request.state };
}

export function cancelInputRequest(db, id, { now = Date.now() } = {}) {
  ensureInputRequestSchema(db);
  const current = getInputRequest(db, id);
  if (!current) throw new InputRequestError("not_found", "input request not found");
  if (SETTLED_STATES.has(current.state)) {
    return { request: current, changed: false, reason: current.state };
  }
  const info = db
    .prepare("UPDATE input_requests SET state = 'cancelled', answered_at = ? WHERE id = ? AND state = 'pending'")
    .run(now, String(id));
  const changed = Number(info.changes) > 0;
  const request = getInputRequest(db, id);
  if (changed) notifyWaiters(id, request);
  return { request, changed, reason: changed ? null : request.state };
}

/**
 * Apply the unattended policy to every request whose TTL has passed.
 *
 * `escalate` needs a writer that the platform's team plane owns, so it comes in
 * as a callback: the core module must not grow a second dependency on the fleet
 * database (design D5). A missing or failing callback falls back to `expired` —
 * an upgraded status is never fabricated.
 */
export function expireDueInputRequests(db, { now = Date.now(), escalate = null } = {}) {
  ensureInputRequestSchema(db);
  const rows = db
    .prepare("SELECT * FROM input_requests WHERE state = 'pending' AND expires_at <= ?")
    .all(now)
    .map(rowToRequest);
  const settled = [];
  for (const request of rows) {
    const policy = request.policy ?? DEFAULT_POLICY;
    if (policy.onUnattended === "wait") continue; // wait 不设终点，等作答或调用方取消
    if (policy.onUnattended === "default") {
      const values = {};
      for (const f of request.card.fields) {
        if (f.default !== undefined) values[f.key] = f.default;
        else if (f.required && f.kind === "boolean") values[f.key] = false;
      }
      const info = db
        .prepare(
          `UPDATE input_requests
              SET state = 'answered', answer = ?, answered_by = 'policy:default', answered_at = ?
            WHERE id = ? AND state = 'pending'`,
        )
        .run(JSON.stringify(values), now, request.id);
      if (Number(info.changes) > 0) settled.push(settleAndNotify(db, request.id));
      continue;
    }
    if (policy.onUnattended === "escalate" && typeof escalate === "function") {
      let decisionId = null;
      try {
        decisionId = escalate(request);
      } catch (err) {
        console.error("[input-requests] escalate failed:", err?.message || err);
      }
      if (decisionId) {
        const info = db
          .prepare(
            `UPDATE input_requests
                SET state = 'escalated', escalated_decision_id = ?, answered_at = ?
              WHERE id = ? AND state = 'pending'`,
          )
          .run(String(decisionId), now, request.id);
        if (Number(info.changes) > 0) settled.push(settleAndNotify(db, request.id));
        continue;
      }
      // 升级写不进去时不假装升级：落到 expired（fail-closed）
    }
    const info = db
      .prepare("UPDATE input_requests SET state = 'expired', answered_at = ? WHERE id = ? AND state = 'pending'")
      .run(now, request.id);
    if (Number(info.changes) > 0) settled.push(settleAndNotify(db, request.id));
  }
  return settled;
}

function settleAndNotify(db, id) {
  const request = getInputRequest(db, id);
  notifyWaiters(id, request);
  return request;
}

// ── 长轮询 ──────────────────────────────────────────────────────────────────

// id -> Set<resolve>。只在「有人正挂在长轮询上」时存在；跨实例的答案靠轮询
// 数据库发现（同一个进程内的答案走这张表，省掉一次轮询延迟）。
const waiters = new Map();

function notifyWaiters(id, request) {
  const set = waiters.get(String(id));
  if (!set) return;
  for (const resolve of [...set]) resolve(request);
  waiters.delete(String(id));
}

export function waitForInputRequest(db, id, { timeoutMs = 25_000, pollMs = 250 } = {}) {
  const current = getInputRequest(db, id);
  if (!current) return Promise.resolve(null);
  if (SETTLED_STATES.has(current.state)) return Promise.resolve(current);
  return new Promise((resolve) => {
    const key = String(id);
    let done = false;
    const finish = (request) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      const set = waiters.get(key);
      if (set) {
        set.delete(finish);
        if (set.size === 0) waiters.delete(key);
      }
      resolve(request);
    };
    const set = waiters.get(key) ?? new Set();
    set.add(finish);
    waiters.set(key, set);
    // 跨实例兜底：答案可能落在另一个进程，行是唯一真源。
    const poll = setInterval(() => {
      const row = getInputRequest(db, id);
      if (row && SETTLED_STATES.has(row.state)) finish(row);
    }, pollMs);
    const timer = setTimeout(() => finish(null), Math.max(1, timeoutMs));
    poll.unref?.();
    timer.unref?.();
  });
}

export function _resetWaitersForTest() {
  waiters.clear();
}
