// ── ACP harness config-dir ownership (harden-acp-credential-channel,
//    own-acp-harness-config) ────────────────────────────────────────────────
//
// The runner points an ACP child at a config directory (CLAUDE_CONFIG_DIR on
// the runner's persistent volume). Two things about that directory are the
// runner's to own, because hand configuration has now failed in both
// directions:
//
// 1. It must not keep a second copy of the credential. ACP harnesses read
//    ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN from the environment the runner
//    injects per spawn — that is the channel (add-harness-adapter D9). A
//    settings file holding the same values outlives the process, is readable by
//    anything in the pod, and rides volume backups. Measured 2026-11-12:
//    /data/.claude-acp/settings.json at 0644 carried the live token (same
//    sha256 prefix as the injected one), written by hand on 2026-10-14.
//
// 2. It must declare the model. This harness (claude-code-acp / SDK 0.2.44)
//    resolves its model from settings.json's top-level `model`; the env's
//    ANTHROPIC_MODEL and the adapter's ACP `_meta.claudeCode.options.model` do
//    NOT change it. Measured 2026-11-13 on agent-runner-c: the file was absent,
//    the harness asked for its built-in default, and the gateway answered
//    "No available accounts" for eleven retries — an ACP lane that had never
//    worked on that node, for want of one declaration. agent-runner-serving had
//    it because somebody typed it there in October.
//
// So the runner now owns the file: strip credentials, declare the model (and
// mirror the injected base URL, which the file's own copy would otherwise
// shadow), one pass, at most one write, mode 0600. Non-credential settings stay
// — dropping them would change behavior and buy nothing. It NEVER fails a spawn:
// a dirty file is a disclosure to log, not a reason to take the agent down, and
// an unparseable file is reported by path rather than silently rewritten.

import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Values that ARE credentials. Deliberately narrow: ANTHROPIC_BASE_URL and the
// model names are configuration, not secrets.
const CREDENTIAL_ENV_KEYS = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];
const CREDENTIAL_TOP_KEYS = ["apiKey", "primaryApiKey"];

// Which keys in a parsed settings.json hold credentials — pure, so the policy is
// testable without touching a filesystem.
export function credentialKeysIn(settings) {
  if (!settings || typeof settings !== "object") return [];
  const found = [];
  const env = settings.env;
  if (env && typeof env === "object") {
    for (const key of CREDENTIAL_ENV_KEYS) if (key in env) found.push(`env.${key}`);
  }
  for (const key of CREDENTIAL_TOP_KEYS) if (key in settings) found.push(key);
  return found;
}

// The directory the child will read — ONLY when the spawn names it explicitly.
//
// Deliberately no $HOME fallback. The CLI's own default ($HOME/.claude) is where
// a DEVELOPER's config lives too, and it carries env.ANTHROPIC_AUTH_TOKEN in the
// exact shape this guard strips: any code path that ran the guard over
// `process.env` on a workstation — a unit test that builds the registry with the
// ambient environment, say — would quietly delete the operator's own live
// credential and chmod their settings file. Measured 2026-11-12: this machine's
// ~/.claude/settings.json is exactly that shape. So the guard acts only where
// the runner itself pointed the child; a deployment that does not set
// CLAUDE_CONFIG_DIR is out of scope by construction (and the production ACP env
// does set it — it is an AGENT_RUNNER_ACP_ENV key).
export function configDirFor(env = {}) {
  const explicit = String(env.CLAUDE_CONFIG_DIR ?? "").trim();
  return explicit || null;
}

function withoutCredentials(settings) {
  const next = { ...settings };
  const env = settings.env && typeof settings.env === "object" ? { ...settings.env } : null;
  if (env) {
    for (const key of CREDENTIAL_ENV_KEYS) delete env[key];
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
  }
  for (const key of CREDENTIAL_TOP_KEYS) delete next[key];
  return next;
}

// The settings the HARNESS resolves from this file first, taken from the same
// injected env that carries the credential. Measured 2026-11-13 on
// agent-runner-c: with no settings.json the harness asked for its built-in
// default model and the gateway answered `503 No available accounts` — the
// spawn env's ANTHROPIC_MODEL and the adapter's ACP `_meta.claudeCode.options
// .model` both failed to change that. The declared model is what routes the
// request, so a runner that hosts ACP agents must not leave it to hand
// configuration: agent-runner-serving carried it, agent-runner-c never did.
export function declaredSettings(env = {}) {
  const out = {};
  const model = String(env.ANTHROPIC_MODEL ?? "").trim();
  if (model) out.model = model;
  const base = String(env.ANTHROPIC_BASE_URL ?? "").trim();
  if (base) out.env = { ANTHROPIC_BASE_URL: base };
  return out;
}

// Merge the declaration into a settings object without disturbing anything
// else. `changed` is false when the file already said exactly this — the
// idempotence the spec requires, expressed as a value so the caller can skip
// the write (and a test can assert byte-identity).
function withDeclaration(settings, declaration) {
  let changed = false;
  const next = { ...settings };
  if (declaration.model !== undefined && settings.model !== declaration.model) {
    next.model = declaration.model;
    changed = true;
  }
  if (declaration.env?.ANTHROPIC_BASE_URL !== undefined) {
    const env = settings.env && typeof settings.env === "object" ? { ...settings.env } : {};
    if (env.ANTHROPIC_BASE_URL !== declaration.env.ANTHROPIC_BASE_URL) {
      env.ANTHROPIC_BASE_URL = declaration.env.ANTHROPIC_BASE_URL;
      next.env = env;
      changed = true;
    }
  }
  return { settings: next, changed };
}

// Own the named config directory: strip credentials AND declare the model, in
// one pass and at most one write. Returns a small receipt so callers/tests can
// assert what happened without parsing logs:
//   { ok, checked, present?, created?, changed?, dropped?, declared?, path?, reason? }
export function ownAcpConfigDir(env = {}, { log = console } = {}) {
  const warn = log.warn ?? log.log ?? (() => {});
  const note = log.info ?? log.log ?? (() => {});
  const dir = configDirFor(env);
  if (!dir) return { ok: true, checked: false };

  const declaration = declaredSettings(env);
  const file = path.join(dir, "settings.json");
  let raw = null;
  let created = false;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    // Absent is normal until something declares the file. With nothing to
    // declare there is nothing to say, so the directory stays as found.
    if (e.code === "ENOENT") {
      if (Object.keys(declaration).length === 0) {
        return { ok: true, checked: true, present: false, path: file };
      }
      created = true;
    } else {
      warn(`[acp] harness config at ${file} is unreadable (${e.code ?? e.message}); spawn continues`);
      return { ok: false, checked: true, present: true, path: file, reason: e.code ?? "read_failed" };
    }
  }

  let settings = {};
  if (!created) {
    try {
      settings = JSON.parse(raw);
    } catch {
      // Never rewrite a file we cannot parse: a blind write would drop the
      // operator's other settings, and a silent skip would read as "clean".
      warn(`[acp] harness config at ${file} is not valid JSON; leaving it untouched`);
      return { ok: false, checked: true, present: true, path: file, reason: "invalid_json" };
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
      warn(`[acp] harness config at ${file} is not a JSON object; leaving it untouched`);
      return { ok: false, checked: true, present: true, path: file, reason: "invalid_shape" };
    }
  }

  const dropped = credentialKeysIn(settings);
  const merged = withDeclaration(withoutCredentials(settings), declaration);

  if (!created && dropped.length === 0 && !merged.changed) {
    return { ok: true, checked: true, present: true, changed: false, path: file, dropped: [] };
  }

  const declared = [];
  if (merged.changed && declaration.model !== undefined) declared.push(`model=${declaration.model}`);
  if (merged.changed && declaration.env?.ANTHROPIC_BASE_URL !== undefined) {
    declared.push(`env.ANTHROPIC_BASE_URL=${declaration.env.ANTHROPIC_BASE_URL}`);
  }

  try {
    writeFileSync(file, `${JSON.stringify(merged.settings, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's mode only applies when it CREATES the file; an existing
    // 0644 settings file keeps its mode without this.
    chmodSync(file, 0o600);
  } catch (e) {
    warn(
      `[acp] harness config at ${file} could not be rewritten (${e.code ?? e.message}); spawn continues`,
    );
    return {
      ok: false,
      checked: true,
      present: !created,
      path: file,
      dropped,
      reason: e.code ?? "write_failed",
    };
  }

  if (dropped.length) note(`[acp] dropped credential keys from ${file}: ${dropped.join(", ")}`);
  if (created) note(`[acp] created ${file} at 0600 declaring ${declared.join(", ") || "nothing"}`);
  else if (declared.length) note(`[acp] declared ${declared.join(", ")} in ${file}`);

  return {
    ok: true,
    checked: true,
    present: true,
    created,
    changed: created || merged.changed,
    path: file,
    dropped,
    declared,
  };
}
