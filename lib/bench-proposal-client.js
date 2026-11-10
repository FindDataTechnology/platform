// ── Bench proposal client (openspec: switch-fleet-proposals-to-domain-inbox §2) ──
//
// The ontology fleet's proposal post drafts entity/relation declarations and
// USED to push them into 柏讯's action gate — one tenant at a time, each owner
// confirming separately. That put the ontology's authority in the customer's
// tenant, against the standing verdict that the published ontology belongs to
// the platform. This client is the one outlet that replaces it: a single
// imperative function that submits a draft to the domain's inbox in 知验台
// (`POST {BENCH_URL}/api/d/{domain}/proposals`).
//
// Three deliberate properties:
//   • One function, no builder/class chain: a round either submits a draft or
//     reports why it could not. Everything else is the caller's business.
//   • Target and credential come from env and nowhere else. No default domain —
//     guessing one silently files an item in the wrong inbox, which is the
//     hardest kind of error for a human to notice.
//   • `transport` is an injection seam so contract tests never open a socket,
//     same shape and same reason as fd-wire's `bench_pull/client.py`.
//
// Error classification is part of the contract: the round report has to say
// WHICH refusal happened, and a retry policy that cannot tell "needs new
// evidence" from "server is down" retries the wrong things forever.

import { fetchWithTimeout, isRetryableHttpStatus } from "./fetch-with-timeout.js";

export const BENCH_URL_ENV = "BENCH_URL";
export const BENCH_TOKEN_ENV = "BENCH_CONSUMER_TOKEN";
export const BENCH_DOMAIN_ENV = "BENCH_PROPOSAL_DOMAIN";

//: Refusal classes the caller must discriminate on.
//:   config      — an env var is missing (message names it); nothing was sent
//:   evidence    — the peer says the draft carries no evidence
//:   vocabulary  — the kind is outside the domain's template vocabulary
//:   needs_evidence — this key was rejected before with the same evidence
//:   forbidden   — the credential is not an expert of that domain
//:   auth        — the credential is missing/invalid at the peer
//:   server      — 5xx (retryable)
//:   timeout     — the deadline passed (retryable)
//:   unreachable — transport failure (retryable)
export const REFUSALS = Object.freeze({
  CONFIG: "config",
  EVIDENCE: "evidence",
  VOCABULARY: "vocabulary",
  NEEDS_EVIDENCE: "needs_evidence",
  FORBIDDEN: "forbidden",
  AUTH: "auth",
  SERVER: "server",
  TIMEOUT: "timeout",
  UNREACHABLE: "unreachable",
});

const RETRYABLE = new Set([
  REFUSALS.SERVER,
  REFUSALS.TIMEOUT,
  REFUSALS.UNREACHABLE,
]);

export class BenchProposalError extends Error {
  constructor(kind, message, { status = null, detail = "", retryable = null } = {}) {
    super(message);
    this.name = "BenchProposalError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
    this.retryable = retryable === null ? RETRYABLE.has(kind) : retryable;
  }
}

// ── credential redaction ─────────────────────────────────────────────────────
//
// The token must not reach a log, a report or an error string. Two guards: the
// client never interpolates it into a message, and every message that could
// carry a peer echo passes through redact() first. The minimum-length check is
// the same one bench_pull uses: a 2-character "token" would match ordinary
// text and turn redaction into a shredder.

const MIN_REDACTABLE_LENGTH = 8;

export function redact(text, secret) {
  const s = String(secret || "");
  if (s.length < MIN_REDACTABLE_LENGTH) return String(text ?? "");
  return String(text ?? "").split(s).join("[redacted]");
}

// ── config ───────────────────────────────────────────────────────────────────

export function resolveConfig(env = process.env) {
  const url = String(env[BENCH_URL_ENV] || "").trim().replace(/\/+$/, "");
  const token = String(env[BENCH_TOKEN_ENV] || "").trim();
  const domain = String(env[BENCH_DOMAIN_ENV] || "").trim();
  const missing = [];
  if (!url) missing.push(BENCH_URL_ENV);
  if (!token) missing.push(BENCH_TOKEN_ENV);
  if (!domain) missing.push(BENCH_DOMAIN_ENV);
  if (missing.length) {
    // Naming the env vars is the whole value of this failure: the post's
    // operator can fix it without reading this file.
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      `bench proposal target not configured: missing ${missing.join(", ")}`,
    );
  }
  return { url, token, domain };
}

// ── default transport ────────────────────────────────────────────────────────

//: The bench's two credential channels are disjoint, and a present-but-invalid
//: Bearer is BINDING (the peer 401s instead of falling through to the API key —
//: deliberate, so an expired JWT cannot be rescued by a leaked key). So exactly
//: one header may be sent: a self-managed `lbk_` key rides X-API-Key, anything
//: else is treated as a Logto JWT. Sending Bearer for an api key is the exact
//: mistake the live probe caught: 401 "invalid bearer token" with a valid key.
const API_KEY_PREFIX = "lbk_";

export function authHeaders(token) {
  return token.startsWith(API_KEY_PREFIX)
    ? { "x-api-key": token }
    : { authorization: `Bearer ${token}` };
}

async function defaultTransport({ url, method = "POST", token, body, timeoutMs }) {
  return fetchWithTimeout(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { timeoutMs },
  );
}

// ── the outlet ───────────────────────────────────────────────────────────────

/**
 * Submit one draft to `POST {BENCH_URL}/api/d/{domain}/proposals`.
 *
 * @param {object} draft  `{ source, kind, externalKey, body, evidence, impact?, submittedBy? }`
 * @param {object} [opts] `{ env?, transport?, timeoutMs? }`
 * @returns {Promise<{id, state, externalKey, evidenceDigest, created}>} —
 *   `created: false` means the inbox already had this pending key (idempotent
 *   hit, nothing added). Both are successes; the report must say which.
 * @throws {BenchProposalError} classified by `kind`; `retryable` is false for
 *   every semantic refusal, so a round cannot machine-retry a human decision.
 */
export async function submitProposal(draft, opts = {}) {
  const env = opts.env ?? process.env;
  const transport = opts.transport ?? defaultTransport;
  const timeoutMs = opts.timeoutMs ?? undefined;
  const { url, token, domain } = resolveConfig(env);

  const source = String(draft?.source ?? "").trim();
  const kind = String(draft?.kind ?? "").trim();
  const externalKey = String(draft?.externalKey ?? "").trim();
  const body = String(draft?.body ?? "").trim();
  const submittedBy = String(draft?.submittedBy ?? "").trim();
  const impact = String(draft?.impact ?? "");

  const missing = [];
  if (!source) missing.push("source");
  if (!kind) missing.push("kind");
  if (!externalKey) missing.push("externalKey");
  if (!body) missing.push("body");
  if (missing.length) {
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      `draft is missing ${missing.join(", ")} — nothing was submitted`,
    );
  }

  const payload = {
    source,
    kind,
    external_key: externalKey,
    body,
    evidence: draft?.evidence,
    submitted_by: submittedBy || source,
  };
  if (impact) payload.impact = impact;

  const target = `${url}/api/d/${encodeURIComponent(domain)}/proposals`;

  let res;
  try {
    res = await transport({ url: target, method: "POST", token, body: payload, timeoutMs });
  } catch (err) {
    // fetchWithTimeout aborts the signal with a FetchTimeoutError, so a real
    // deadline usually surfaces as AbortError — both spellings mean the same
    // thing here, and neither is a semantic refusal.
    const timedOut =
      err?.code === "FETCH_TIMEOUT" ||
      err?.name === "FetchTimeoutError" ||
      err?.name === "AbortError" ||
      err?.name === "TimeoutError";
    throw new BenchProposalError(
      timedOut ? REFUSALS.TIMEOUT : REFUSALS.UNREACHABLE,
      redact(
        `${timedOut ? "bench submit timed out" : "bench submit unreachable"}: ${
          err?.message || err
        }`,
        token,
      ),
    );
  }

  const data = await readJson(res);
  if (!res.ok) {
    throw classifyRefusal(res.status, data, token, domain);
  }

  return {
    id: data?.id ?? null,
    state: String(data?.state ?? ""),
    externalKey: String(data?.external_key ?? externalKey),
    evidenceDigest: String(data?.evidence_digest ?? ""),
    // Absent flag = a peer that predates the created/created-false distinction.
    // Report it as new so a stale peer cannot silently inflate the "hit" count.
    created: data?.created !== false,
  };
}

async function readJson(res) {
  try {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { detail: text };
    }
  } catch {
    return {};
  }
}

function classifyRefusal(status, data, token, domain) {
  const detail = redact(String(data?.detail ?? data?.error ?? ""), token);
  const mk = (kind, retryable = false) =>
    new BenchProposalError(kind, redact(`${status} ${detail || "refused"}`, token), {
      status,
      detail,
      retryable,
    });

  if (status === 400) {
    if (detail.includes("同键已驳回")) return mk(REFUSALS.NEEDS_EVIDENCE);
    if (detail.includes("提案必须携带依据")) return mk(REFUSALS.EVIDENCE);
    if (detail.includes("不在模板") || detail.includes("词表")) {
      return mk(REFUSALS.VOCABULARY);
    }
    // Any other 400 is still a semantic refusal — never machine-retried.
    return mk(REFUSALS.VOCABULARY);
  }
  if (status === 401) return mk(REFUSALS.AUTH);
  if (status === 403) {
    // Keep the peer's own words (redacted) next to ours: a 403 here is either
    // "not a member of this domain" or "no content:write scope", and the caller
    // has to be able to tell which one to ask a human to fix.
    return new BenchProposalError(
      REFUSALS.FORBIDDEN,
      `403 forbidden for domain '${domain}' — credential is not an expert member with content:write${
        detail ? `: ${detail}` : ""
      }`,
      { status, detail },
    );
  }
  if (isRetryableHttpStatus(status)) return mk(REFUSALS.SERVER, true);
  return mk(REFUSALS.SERVER, false);
}
