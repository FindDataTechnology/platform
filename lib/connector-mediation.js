// ── Mediated connector access (add-served-agent-connector-access D2/D9) ─────
//
// A served (facade) agent is used by people who are not its deployer, so the
// deployment token a static MCP row would inject authenticates the WRONG
// person. This module is the replacement path: the agent names a binding and a
// tool, the platform decides who is on the other end at THIS turn, and the
// connector is called as that person.
//
// The four-way decision is the whole point, and each arm is a different answer:
//
//   scope absent            → no visitor (A2A caller / background turn)
//                             run as the deployer, and say so
//   scope anonymous         → the facade said this visitor has no identity
//                             run as the deployer, and say so
//   scope registered+actor  → run as the actor (OBO)
//   scope unregistered      → the registration channel is broken
//                             FAIL CLOSED: no call, no fallback
//
// That last arm is why the module has the shape it has. Falling back there
// would turn "the link is down" into "the deployer did it", which is precisely
// the false success this change set out to remove.
//
// Before an actor call the platform asks the connector's read-only preflight
// (`GET /api/tenant/service-whoami`) why the identity would be refused, if it
// would, so a refusal reaches the visitor as "sign in once" or "ask ops to
// enable the tier" instead of a bare 401 to guess at.
//
// Deliberately NOT done here: minting, revoking, or registering an identity.
// An unknown actor stays unknown — automatic provisioning would move the
// authority for "who is this person" off the connector's OIDC login.

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { connectorOrigin as readConnectorOrigin } from "../connector-bindings.js";
import { deploymentBindingSecretName } from "../deployment-bindings.js";
import { callLineTool, classifyToolResult } from "./action-executor.js";
import { sharedVisitorActors } from "./visitor-actor-registry.js";

export const ACTOR_HEADER = "x-oo-connector-actor-sub";
export const PREFLIGHT_TIMEOUT_MS = 8_000;
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** The denial codes the connector's preflight answers with. */
export const SERVICE_IDENTITY_CODES = Object.freeze([
  "actor_header_missing",
  "obo_disabled",
  "actor_unregistered",
  "actor_disabled",
  "consent_missing",
]);

/** What the person on the other end should DO about each refusal. */
export const SERVICE_IDENTITY_HINTS = Object.freeze({
  actor_header_missing: "The platform did not send an actor for this call — retry, and report it if it persists.",
  obo_disabled: "Service delegation is switched off on this deployment; ask the operator to enable it.",
  actor_unregistered: "Sign in to the connector once, then retry, to act with your own account.",
  actor_disabled: "Your connector account is disabled; ask the operator to re-enable it.",
  consent_missing: "Approve this deployment's access in the connector, then retry.",
});

/**
 * The two refusals whose remedy is an action **inside the connector's own UI**.
 * Those hints carry the address, because "sign in once" with no place to sign in
 * is a dead end for the visitor (add-served-agent-connector-access 5.2). The
 * other codes are fixed by the operator or by the platform, so a link there
 * would send the visitor to a page that cannot help them.
 */
const HINTS_THAT_CARRY_THE_ADDRESS = new Set(["actor_unregistered", "consent_missing"]);

/**
 * The hint for a refusal code, with the connector's address appended when — and
 * only when — the fix happens at that address.
 *
 * The origin is the deployment's own `mcp.json` connector row (`connectorOrigin`),
 * i.e. the host the refused call actually went to, so the link can never name a
 * different host than the one that refused. It is the connector's root, not a
 * guessed deep path: that page renders the sign-in entry itself, and hardcoding
 * `/api/tenant/oidc/authorize` here would rot the day the connector moves it.
 */
export function serviceIdentityHint(code, origin) {
  const base = SERVICE_IDENTITY_HINTS[code] ?? "the connector refused this identity";
  if (!origin || !HINTS_THAT_CARRY_THE_ADDRESS.has(code)) return base;
  return `${base} (${String(origin).replace(/\/+$/, "")})`;
}

export function connectorEndpoint(origin) {
  return origin ? `${String(origin).replace(/\/+$/, "")}/mcp` : null;
}

export function serviceIdentityEndpoint(origin) {
  return origin ? `${String(origin).replace(/\/+$/, "")}/api/tenant/service-whoami` : null;
}

/**
 * The headers every connector request carries. One function so the preflight
 * and the tool call can never disagree about who is being asked.
 */
export function connectorHeaders(bearer, actorSub) {
  return {
    Authorization: `Bearer ${bearer}`,
    ...(actorSub ? { [ACTOR_HEADER]: actorSub } : {}),
  };
}

/**
 * Bearer + the OBO actor header on every request, including the initialize
 * handshake the connector authorizes on. One transport per call: actions are
 * taken one at a time and pooling is an optimisation nobody has measured a
 * need for.
 */
export function connectorTransportFactory(actorSub) {
  return (endpoint, bearer) =>
    new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: connectorHeaders(bearer, actorSub) },
    });
}

const failure = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });

export function createConnectorMediation({
  registry,
  visitorActors = sharedVisitorActors,
  connectorOrigin = readConnectorOrigin,
  fetchImpl = fetch,
  callTool = callLineTool,
  preflightTimeoutMs = PREFLIGHT_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
} = {}) {
  /** Ask the connector whether the actor could act — read-only, no execution. */
  async function preflight({ origin, token, actor }) {
    const url = serviceIdentityEndpoint(origin);
    if (!url) return failure("connector_not_configured", "the connector origin is not configured on this deployment");
    let response;
    try {
      response = await fetchImpl(url, {
        headers: connectorHeaders(token, actor),
        signal: AbortSignal.timeout(preflightTimeoutMs),
      });
    } catch (e) {
      // Link failure is NOT a reason to fall back: doing so would report the
      // deployer's action as the visitor's. Fail closed instead.
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      return failure(
        "connector_unreachable",
        timeout ? "the connector did not answer the identity preflight in time" : `the connector is unreachable: ${e?.message || e}`,
      );
    }
    const doc = await response.json().catch(() => null);
    if (response.ok && doc?.ok === true) return { ok: true };
    const code = doc?.error?.code ?? doc?.code;
    if (typeof code === "string" && SERVICE_IDENTITY_CODES.includes(code)) {
      // `hint` is what the person on the other end should DO; the message stays
      // the same sentence so a log line and a UI line tell one story. For the
      // two self-service refusals it also carries where to do it (5.2).
      const hint = serviceIdentityHint(code, origin);
      return failure(code, hint, { hint, httpStatus: response.status });
    }
    // Anything else (403 not_a_service_token, a 404 on an older connector, a
    // proxy page) is a wiring problem, not a visitor problem. Name it as such
    // and never guess a friendly story.
    return failure("connector_preflight_rejected", `the connector answered HTTP ${response.status}${code ? ` (${code})` : ""}`, {
      httpStatus: response.status,
      connectorCode: typeof code === "string" ? code : null,
    });
  }

  return {
    /**
     * Run one connector tool for one turn.
     *
     * @returns {Promise<
     *   | {ok: true, executedAs: "actor", actor: string, result: unknown, text: string|null}
     *   | {ok: true, executedAs: "deployer", reason: "no_visitor_scope"|"visitor_identity_absent", result: unknown, text: string|null}
     *   | {ok: false, code: string, message: string, hint?: string, httpStatus?: number}
     * >}
     */
    async call({ packId, agentId, agentPath = "", scope = "", bindingKey, tool, args, timeoutMs = callTimeoutMs } = {}) {
      if (!packId || !agentId) {
        return failure("deployment_identity_required", "a mediated connector call needs a deployment identity");
      }
      if (typeof tool !== "string" || !tool.trim()) {
        return failure("tool_required", "a mediated connector call needs the connector tool name");
      }
      if (typeof bindingKey !== "string" || !bindingKey.trim()) {
        return failure("binding_unknown", "a mediated connector call needs the binding's key");
      }

      // The deployment decides the registration key, exactly as the
      // registration route did — a caller-supplied agentPath must not open a
      // second key space.
      const deps = registry.deployments(packId);
      const dep =
        (agentPath ? deps.find((d) => d.agentPath === agentPath) : null) ?? deps.find((d) => d.agentId === agentId);
      if (!dep) return failure("deployment_identity_required", `no such deployment ${packId}/${agentId}`);

      const secretName = deploymentBindingSecretName(bindingKey.trim());
      const row = (registry.deploymentSecretsForPack(packId) ?? []).find(
        (r) => r.agentId === dep.agentId && r.name === secretName,
      );
      if (!row) {
        return failure(
          "binding_unwired",
          `binding '${bindingKey}' has no deployment credential on ${packId}/${dep.agentId}`,
        );
      }
      const token = row.secretValue;
      if (typeof token !== "string" || !token) {
        return failure("binding_secret_missing", `binding '${bindingKey}' has an empty deployment credential`);
      }

      const origin = connectorOrigin();
      const endpoint = connectorEndpoint(origin);
      if (!endpoint) return failure("connector_not_configured", "the connector origin is not configured on this deployment");

      // ── who is on the other end of this turn? ──────────────────────────────
      const scopeValue = typeof scope === "string" ? scope.trim() : "";
      let executedAs = "deployer";
      let actor = null;
      let fallbackReason = "no_visitor_scope";
      if (scopeValue) {
        const found = visitorActors.lookup({
          packId,
          agentId: dep.agentId,
          agentPath: dep.agentPath ?? "",
          scope: scopeValue,
        });
        if (found.state === "missing") {
          // Fail closed. Not "anonymous": nobody said this visitor is nobody.
          return failure(
            "actor_registration_missing",
            "this turn carries a visitor scope with no registered identity — the facade/paas registration link is broken, so the call was not made",
          );
        }
        if (found.state === "anonymous") {
          fallbackReason = "visitor_identity_absent";
        } else {
          executedAs = "actor";
          actor = found.actor;
        }
      }

      if (executedAs === "actor") {
        const pre = await preflight({ origin, token, actor });
        if (!pre.ok) return pre;
      }

      let raw;
      try {
        raw = await callTool({
          endpoint,
          toolName: tool.trim(),
          args: args ?? {},
          bearer: token,
          timeoutMs,
          transportFactory: connectorTransportFactory(actor),
        });
      } catch (e) {
        const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
        return failure(
          timeout ? "connector_timeout" : "connector_tool_error",
          timeout ? "the connector did not answer in time" : String(e?.message || e),
          { executedAs },
        );
      }

      const classified = classifyToolResult(raw);
      if (!classified.ok) {
        return failure("connector_tool_error", classified.detail || "the connector reported an error", {
          executedAs,
          httpStatus: classified.status,
          toolKind: classified.kind,
        });
      }

      return {
        ok: true,
        executedAs,
        ...(actor ? { actor } : {}),
        ...(executedAs === "deployer" ? { reason: fallbackReason } : {}),
        result: raw,
        text: classified.text ?? null,
      };
    },
  };
}
