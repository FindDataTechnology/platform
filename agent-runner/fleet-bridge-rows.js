// ── The bridge's MCP row shape, with no dependencies ─────────────────────────
//
// Lives in its own module so BOTH consumers can import it without dragging the
// satellite host (and the MCP SDK behind it) into every `manager.js` import:
// the composer builds rows through this, and `fleet-bridge.js` starts the host
// those rows point at. One shape, one place — a second inlined copy is how the
// row and the endpoint drift apart silently.
//
// Deliberately carries NO identity: one patch serves every home in the pack, so
// an env-borne member id here would sign other members' work. Identity arrives
// per turn as `turn_token`.
//
// The bridge mount base + the runner's bearer ride in `headers`, not in the
// satellite's env: `fleet`/`fleet-architect` are SHARED satellites (one child
// per cell serves every runtime), and a secret in that child's env is readable
// by every member's process — `scripts/test-mcp-satellite-sharing.mjs` fails on
// exactly that shape. Headers are per-request, which is also the shape the
// identity channel already uses.
//
// `failOnStartupError: false` matches `mcpEntry()` in compose.js on purpose:
// visibility does NOT come from making composition fail (that would turn a
// crash of one loopback host into every home refusing to start). It comes from
// the boot-time probe + `<homeRoot>/.fleet-bridge-status.json`, plus the child
// returning the door's 401/503 verbatim at call time.

// `x-fleet-bridge-base` is the GATEWAY mount (`<url>/api/runner-fleet`), NOT the
// satellite origin in `url`: the child composes `${base}${"/fleets/report"}` /
// `${base}${"/architect/fleets"}`, so an origin-shaped base sends every call to
// the satellite host with a path no mount matches and the tool answers
// `unknown satellite endpoint` — while the mount itself stays healthy. Measured
// live 2026-11-15: rows correct, host up, `/fleet/mcp` handshaking, tool calls
// failing. With no base there is no honest row to build (a row that looks fine
// and 404s on first use is exactly what this module exists to prevent).

export const FLEET_BRIDGE_SERVERS = Object.freeze(["fleet", "fleet-architect"]);

export function fleetBridgeMcpRows(origin, { token = "", owner = "", bridgeBase = "" } = {}) {
  if (!origin) return [];
  const base = String(bridgeBase || "").trim().replace(/\/+$/, "");
  if (!base) {
    console.warn(
      "[fleet-bridge-rows] bridgeBase missing — not composing fleet rows (the base must be the gateway mount, e.g. <url>/api/runner-fleet, never this satellite's origin)",
    );
    return [];
  }
  return FLEET_BRIDGE_SERVERS.map((serverName) => ({
    id: `mcp-${serverName}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: {
      serverName,
      failOnStartupError: false,
      transport: "streamable-http",
      url: `${origin}/${serverName}/mcp`,
      headers: {
        // The host turns these into the reserved `__fleetBridge` argument per
        // request; the child never reads a secret from its own environment.
        "x-fleet-bridge-base": base,
        ...(token ? { "x-fleet-bridge-token": token } : {}),
        // 主人的坐标（4.4）：一行一套、按 agent 的部署者邮箱生成，所以同一
        // pod 上别人的 home 拿着自己那一行时读到的是自己的舰队。缺它时网关
        // 门回 400（宁可报错，也不拿某个默认 cell 顶替——那会把一个人的工
        // 作记进另一个人的账本）。
        ...(owner ? { "x-fleet-bridge-owner": String(owner).trim().toLowerCase() } : {}),
      },
    },
  }));
}
