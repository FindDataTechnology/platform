// ── Action preflight (add-line-boards-and-action-gate, task 1.5) ─────────────
//
// Checks a proposed action's target before it enters a confirmation tier.
// Deployment-agnostic by design: the SAME deploy action has two targets with
// different prerequisites.
//
//   target=cloud          → requires the user's `wanxing-deployer` ref
//                           (a pasted sub2api sk- key that carries the
//                           deployed service's autonomous turns)
//   target=desktop:<seat> → requires the seat to be paired and (when it is
//                           this machine) online; NEVER requires a billing key
//
// A failed preflight blocks the proposal and returns a human-readable fix.

import { getLineCredential } from "../db.js";
import { connectPathForRef, liveTokenForRef } from "../credential-refs.js";
import { resolveCredentialRef } from "./action-executor.js";
import { DECISION, resolveMandate } from "./personal-mandate.js";

const DEPLOYER_LINE = "wanxing-deployer";

// What the connect pointer calls each ref (server-side wording, same register
// as the wire label the first consumer chose).
const REF_LABELS = Object.freeze({
  registry: "MCP 市场",
  "facet-market": "谦面市场",
  "wire-customer": "柏讯（操作）",
  lex: "识律",
  "wanxing-caller": "词元账号",
  "wanxing-deployer": "萬星部署者",
});

function refusal(ref, label) {
  const connectPath = connectPathForRef(ref);
  const name = label ?? REF_LABELS[ref] ?? ref;
  return {
    ok: false,
    details: `需要先连接${name}：设置 → 连接 → ${name}（${connectPath}）`,
    connectPath,
    credentialRef: ref,
  };
}

// Credential preflight (add-wire-line-board 2.3, generalised): an action
// executed with the user's own credential is pointless to confirm when that
// credential is absent or expired — refuse before the confirmation tier and
// point at the connect card. Resolution goes through the credential-refs table
// (expiry/stale semantics per ref), so one helper is correct for ID-token
// lines (wire/lex), pasted keys (wanxing-caller) and the market device token.
export function requireCredentialRef(ref, { label = null } = {}) {
  return async (ctx) => {
    const email = String(ctx?.email || "").trim();
    if (liveTokenForRef(ref, email)) return { ok: true };
    return refusal(ref, label);
  };
}
// The wire registry entries' name for the same thing.
export const requireLineCredential = requireCredentialRef;

// Chatwoot dual-credential preflight (add-crm-desk-pack-embed D3): the send
// action executes with the USER's own Chatwoot credential when the proposer is
// an authenticated identity; the machine owner (auth off / no identity — the
// self-hosted and 寻数 A-tenant shape) falls back to the deployment env pair.
// An authenticated user without a live credential is refused with the connect
// pointer — they MUST NOT ride the shared deployment token (tenant isolation).
export function requireChatwootCredential() {
  return async (ctx) => {
    const email = String(ctx?.email || "").trim();
    if (!email) {
      // Machine owner: the deployment env is the credential — verify it exists.
      return requireServerEnv(["CHATWOOT_BASE_URL", "CHATWOOT_API_TOKEN"], "CRM 客服台")(ctx);
    }
    if (liveTokenForRef("chatwoot", email)) return { ok: true };
    return {
      ok: false,
      details: "需要先连接你自己的 Chatwoot 账号：设置 → 连接 → CRM 客服台（Chatwoot）",
      connectPath: connectPathForRef("chatwoot"),
      credentialRef: "chatwoot",
    };
  };
}

// Server-env preflight (add-crm-desk-bridge D7): a stdio-hosted action's
// credential is the DEPLOYMENT env itself (first-party shared token; no
// per-user ref to check). Refuse when the declared env names are absent — the
// server is omitted from every patch in that deployment and its child cannot
// start, so a proposal could never execute. The fix pointer is deployment
// configuration, not a connect card.
export function requireServerEnv(names, label = null) {
  return async () => {
    const missing = names.filter((n) => process.env[n] == null || process.env[n] === "");
    if (!missing.length) return { ok: true };
    return {
      ok: false,
      details: `${label ?? names.join(" / ")}未配置（部署环境变量缺失：${missing.join(", ")}），需平台管理员配置后方可执行`,
    };
  };
}

// The executor's own ref for this action (resolved the same way it will be at
// execution — lib/action-executor resolveCredentialRef), checked for a live
// token. For facet/wanxing the ref comes from the hosting server's registry
// entry, so a cold catalog refuses honestly instead of letting the proposal
// into a tier it cannot leave. `entryFor` is the test seam onto the catalog.
export function requireExecutionCredential({ label = null, entryFor = undefined } = {}) {
  return async (ctx, _args, action) => {
    const ref = resolveCredentialRef(action, action?.server, entryFor ? { entryFor } : undefined);
    if (!ref) {
      return { ok: false, details: `动作「${action?.id ?? "?"}」的宿主服务器「${action?.server ?? "?"}」尚未进入市场目录，无法判定凭据` };
    }
    const email = String(ctx?.email || "").trim();
    if (liveTokenForRef(ref, email)) return { ok: true };
    return refusal(ref, label);
  };
}
const SEAT_RE = /^desktop-[A-Za-z0-9._-]{1,60}$/;
const HEALTH_TIMEOUT_MS = 2000;

function identityEmail(ctx) {
  return String(ctx?.email || "").trim().toLowerCase() || null;
}

async function localRunnerHealthy() {
  const base = String(process.env.WANXING_RUNNER_URL || "http://127.0.0.1:8790").replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Deploy preflight. Returns { ok: true } or { ok: false, details }.
 */
export async function preflightDeploy(ctx, args) {
  const target = String(args?.target || "");

  if (target === "cloud") {
    const email = identityEmail(ctx);
    if (!email) {
      return { ok: false, details: "云端部署需要登录身份：请先登录后再试" };
    }
    const cred = getLineCredential(email, DEPLOYER_LINE);
    if (!cred || cred.stale) {
      return {
        ok: false,
        details: "云端部署需要先连接部署者凭据（设置 → 连接 → 萬星部署者，粘贴 sub2api sk- key）",
      };
    }
    return { ok: true };
  }

  if (target.startsWith("desktop:")) {
    const seat = target.slice("desktop:".length);
    if (!SEAT_RE.test(seat)) {
      return { ok: false, details: `机位格式不合法：${seat || "(空)"}（应为 desktop-…）` };
    }
    // Only this machine's seat is probeable from the cell. A remote seat's
    // online state is the registry's truth; accept and let the deploy fail
    // honestly rather than blocking a valid remote target here.
    const localSeat = String(process.env.WANXING_PLUGIN_RUNNER_ID || "");
    if (localSeat && localSeat === seat) {
      const healthy = await localRunnerHealthy();
      if (!healthy) {
        return {
          ok: false,
          details: "本机机位当前离线：请打开桌面应用并启用「Wanxing Fleet」后重试（桌面部署不需要计费键）",
        };
      }
    }
    return { ok: true };
  }

  return { ok: false, details: "target 必须是 cloud 或 desktop:<seat>" };
}

/**
 * Generic preflight dispatcher. Falls back to the registry's own hook, which
 * receives the action itself so a shared hook (requireExecutionCredential) can
 * read the entry it is attached to.
 */
async function basePreflight(action, ctx, args) {
  if (action.id === "wanxing.agent.deploy") return preflightDeploy(ctx, args);
  if (typeof action.preflight === "function") return action.preflight(ctx, args, action);
  return { ok: true };
}

/**
 * Preflight = the registry's prerequisites, then the mandate (add-personal-mandate
 * 3.1). Order matters and is pinned by tests: a missing credential outranks an
 * authorization verdict, because "go connect your account" is actionable while
 * "your mandate says no" would send the user to the wrong settings page.
 *
 * The mandate never *fails* a preflight — a `draft` or `advise` verdict is a
 * routing decision, not a missing prerequisite. Callers branch on
 * `result.mandate.decision`; `ok` keeps meaning "the prerequisites hold".
 * No mandate in ctx (copilot, browser callers) → result is byte-identical to
 * before this change.
 */
export async function preflightAction(action, ctx, args) {
  const base = await basePreflight(action, ctx, args);
  if (!base.ok) return base;
  if (!ctx?.mandate) return base;

  const verdict = resolveMandate({ ...ctx.mandate, action, args });
  if (verdict.decision === DECISION.FALLBACK) return base;
  return { ...base, mandate: verdict };
}
