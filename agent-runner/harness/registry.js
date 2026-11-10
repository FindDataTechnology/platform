// ── Harness registry (add-harness-adapter D5) ────────────────────────────────
//
// The one place harness NAMES become adapter instances. The manager asks for a
// name (the descriptor's `harness`, else the runner default) and gets either an
// adapter factory or a structured "unsupported harness" — the deploy gate
// normally refuses earlier, but the runner never assumes it did.
//
// Commands are runner-side configuration, NEVER descriptor data: a descriptor
// arrives from the registry (untrusted), so it may only name a harness this
// runner has already allowlisted. AGENT_RUNNER_ACP_COMMANDS maps harness name →
// [command, ...args] (JSON), e.g. {"acp-claude-code": ["claude-code-acp"]}.

import { AcpHarnessAdapter } from "./acp.js";

export const DEFAULT_HARNESS = "dsh";

// The registry: name → factory(spawnSpec) → adapter. `dsh` is always present
// (the built-in harness); every ACP entry rides the runner's allowlist (parsed
// in config.js, where a malformed value refuses the boot).
export function createHarnessRegistry({ acpCommands = {}, acpEnv = {}, log = console } = {}) {
  const harnesses = new Map();
  harnesses.set(DEFAULT_HARNESS, {
    name: DEFAULT_HARNESS,
    kind: "dsh",
    // The dsh factory is injected by the manager (it owns the clientFactory /
    // private-home wiring); this entry only carries the name and kind.
    factory: null,
  });
  for (const [name, argv] of Object.entries(acpCommands)) {
    if (name === DEFAULT_HARNESS) {
      throw new Error(`AGENT_RUNNER_ACP_COMMANDS must not redefine the built-in harness '${DEFAULT_HARNESS}'`);
    }
    harnesses.set(name, {
      name,
      kind: "acp",
      command: argv[0],
      args: argv.slice(1),
    });
  }
  return {
    names() {
      return [...harnesses.keys()];
    },
    kindOf(name) {
      return harnesses.get(name)?.kind ?? null;
    },
    // Build the adapter for one spawn. `dshFactory` is the manager's
    // constructor closure (it needs clientFactory + private home); an ACP
    // entry builds its own adapter from the allowlisted command. An unknown
    // name throws the structured unsupported-harness error the spec names.
    // The destructuring list IS the forwarding contract — a host callback
    // added at the manager's spawn sites must appear here too, or the
    // registry silently drops it (live 2026-10-25: onMatter wired at both
    // spawn sites but never forwarded, every facade call declined
    // "not configured" with the executor never reached).
    create(name, { key, spawnSpec, log: childLog = log, onNotify, onMatter, onExit, podMembers, budgetCancelGraceMs, turnTimeoutMs, budgetLabel, dshFactory }) {
      const entry = harnesses.get(name);
      if (!entry) {
        throw Object.assign(
          new Error(`this runner cannot host harness '${name}' (available: ${[...harnesses.keys()].join(", ")})`),
          { code: "UNSUPPORTED_HARNESS", harness: name },
        );
      }
      if (entry.kind === "dsh") {
        if (!dshFactory) throw new Error("the dsh harness factory was not wired (internal wiring error)");
        return dshFactory({ key, spawnSpec, log: childLog, onNotify, onMatter, onExit, podMembers, budgetCancelGraceMs, turnTimeoutMs, budgetLabel });
      }
      // ACP: the spawn spec carries the allowlisted command; the descriptor's
      // cwd/provider/model ride along. Credentials reach the process through
      // the child env (claude-code-acp reads ANTHROPIC_API_KEY via the Claude
      // Agent SDK) — the runner's acpEnv configuration injects them on top of
      // the scrubbed child env. acpCredentialEnv wins over acpEnv BY DESIGN
      // (add-harness-materializer D4): the standing credential is the default,
      // the deployment's own billing key is the override — the same
      // deployer-attribution semantics the dsh path's applyBillingKey carries.
      // acpMcpServers (compose-acp.js shape) rides to session/new untouched.
      return new AcpHarnessAdapter({
        key,
        spawnSpec: {
          command: entry.command,
          args: [...entry.args],
          cwd: spawnSpec.cwd,
          env: { ...spawnSpec.env, ...acpEnv, ...(spawnSpec.acpCredentialEnv ?? {}) },
          provider: spawnSpec.provider,
          model: spawnSpec.model,
          ...(Array.isArray(spawnSpec.acpMcpServers) ? { acpMcpServers: spawnSpec.acpMcpServers } : {}),
        },
        log: childLog,
        onExit,
      });
    },
  };
}
