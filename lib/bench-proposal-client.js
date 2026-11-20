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
//
// ── 两套面（change bind-bench-proposal-identity-to-credential）───────────────
// `session`（默认，行为与切换前逐字一致）：`POST /api/d/{domain}/proposals`，凭据
//   `BENCH_CONSUMER_TOKEN`（`lbk_` 走 X-API-Key，否则 Bearer）——它代表**一个人**，
//   提交方来自请求体里的 `source`（**自述**）。
// `machine`（本 change 新增）：`POST /api/v1/distribution/{domain}/proposals`，凭据
//   `BENCH_FLEET_TOKEN` 走 `X-Consumer-Token`——身份由对端从登记行派生，`source` 必须形如
//   `fleet:<自己的 fleet_ref>/<post>`，否则 403。
// 默认仍是 session：切换默认是独立、可回滚的一步（design D6），不是这次改动的副作用。
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
//: 机器面：令牌代表一行**登记**，代表不了人。
export const BENCH_FLEET_TOKEN_ENV = "BENCH_FLEET_TOKEN";
//: 可选。只用于**本地**先判自称，让岗位在发请求之前就知道「你自己的 ref 是什么」。
export const BENCH_FLEET_REF_ENV = "BENCH_FLEET_REF";
//: `session`（缺省）| `machine`。切换默认是独立一步，见 design D6。
export const BENCH_MODE_ENV = "BENCH_PROPOSAL_MODE";

export const MODES = Object.freeze({ SESSION: "session", MACHINE: "machine" });

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
  //: 本地判定：自称的 fleet 与手上令牌的舰队不符。既不是对端拒绝（请求没发出去），
  //: 也不是配置缺失（配置齐了，是岗位搞错了自己是谁）——单独一类，不可重试。
  IDENTITY: "identity",
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
  const domain = String(env[BENCH_DOMAIN_ENV] || "").trim();
  const mode = String(env[BENCH_MODE_ENV] || MODES.SESSION).trim() || MODES.SESSION;
  if (!Object.values(MODES).includes(mode)) {
    // 拼错一个模式名，要么静默退化成会话面（身份退回自述）、要么直接炸。前者更坏。
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      `bench proposal mode ${JSON.stringify(mode)} is not one of ${Object.values(MODES).join("/")}`,
    );
  }
  const tokenEnv = mode === MODES.MACHINE ? BENCH_FLEET_TOKEN_ENV : BENCH_TOKEN_ENV;
  const token = String(env[tokenEnv] || "").trim();
  const fleetRef = String(env[BENCH_FLEET_REF_ENV] || "").trim();
  const missing = [];
  if (!url) missing.push(BENCH_URL_ENV);
  if (!token) missing.push(tokenEnv);
  if (!domain) missing.push(BENCH_DOMAIN_ENV);
  if (missing.length) {
    // Naming the env vars is the whole value of this failure: the post's
    // operator can fix it without reading this file.
    throw new BenchProposalError(
      REFUSALS.CONFIG,
      `bench proposal target not configured (mode=${mode}): missing ${missing.join(", ")}`,
    );
  }
  return { url, token, domain, mode, fleetRef };
}

// ── default transport ────────────────────────────────────────────────────────

//: The bench's two credential channels are disjoint, and a present-but-invalid
//: Bearer is BINDING (the peer 401s instead of falling through to the API key —
//: deliberate, so an expired JWT cannot be rescued by a leaked key). So exactly
//: one header may be sent: a self-managed `lbk_` key rides X-API-Key, anything
//: else is treated as a Logto JWT. Sending Bearer for an api key is the exact
//: mistake the live probe caught: 401 "invalid bearer token" with a valid key.
const API_KEY_PREFIX = "lbk_";

export function authHeaders(token, mode = MODES.SESSION) {
  // 机器面只发一枚头。两套面不可互换：同时带 `X-Consumer-Token` 与
  // `x-api-key`/`Authorization`，会让「是谁」取决于服务端先看哪一个。
  if (mode === MODES.MACHINE) return { "x-consumer-token": token };
  return token.startsWith(API_KEY_PREFIX)
    ? { "x-api-key": token }
    : { authorization: `Bearer ${token}` };
}

export function proposalsTarget(url, domain, mode = MODES.SESSION) {
  return mode === MODES.MACHINE
    ? `${url}/api/v1/distribution/${encodeURIComponent(domain)}/proposals`
    : `${url}/api/d/${encodeURIComponent(domain)}/proposals`;
}

//: 机器面的 source 必须正是自己的登记：`fleet:<fleet_ref>/<post>`。
//: 判据与对端 `may_submit_as_source` 同口径，只是提前到这里做——对端也会 403，
//: 但一趟往返换不来「你自己的 ref 是什么」这句话，而岗位最缺的正是这句。
export function assertOwnSource(source, fleetRef) {
  const ref = String(fleetRef || "").trim();
  if (!ref) return;
  const prefix = `fleet:${ref}/`;
  if (!String(source || "").startsWith(prefix)) {
    throw new BenchProposalError(
      REFUSALS.IDENTITY,
      `source 必须以 ${prefix} 开头（你的 fleet_ref 是 ${ref}；令牌只能替自己的登记说话）；` +
        `got ${JSON.stringify(String(source || ""))} —— 请求未发送`,
    );
  }
}

async function defaultTransport({ url, method = "POST", token, body, timeoutMs, mode }) {
  return fetchWithTimeout(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...authHeaders(token, mode),
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
  const { url, token, domain, mode, fleetRef } = resolveConfig(env);

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

  // 机器面：身份由对端从令牌派生，请求体里那个 `submitted_by` 不参与判定。
  // 仍会带上它（面板显示用），但**不**用它当身份——两者不一致时以对端派生为准。
  const payload = {
    source,
    kind,
    external_key: externalKey,
    body,
    evidence: draft?.evidence,
    submitted_by: submittedBy || source,
  };
  if (impact) payload.impact = impact;

  // 本地先判自称：不满足就**不发请求**。放在 payload 之后，是因为报错要能带上 source 原文。
  if (mode === MODES.MACHINE) assertOwnSource(source, fleetRef);

  const target = proposalsTarget(url, domain, mode);

  let res;
  try {
    res = await transport({ url: target, method: "POST", token, body: payload, timeoutMs, mode });
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
    throw classifyRefusal(res.status, data, token, domain, mode);
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

function classifyRefusal(status, data, token, domain, mode = MODES.SESSION) {
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
    if (mode === MODES.MACHINE) {
      // 机器面的 403 只有一种含义：这次自称不是本令牌的登记（或登记已吊销）。
      // 说成「不是本域专家」会把岗位引去申请权限，而该改的是 source。
      return new BenchProposalError(
        REFUSALS.FORBIDDEN,
        `403 机器面拒绝：${detail || "令牌只能替自己的登记提交"} —— 检查 source 与本令牌的 fleet_ref 是否一致`,
        { status, detail },
      );
    }
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
