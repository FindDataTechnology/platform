// Hermetic ACCOUNT cell for mini-program walkthroughs (task 7.2 of openspec:
// add-mp-scan-bind, and the bind half of 3.1).
//
// Boots the real server.js in the shape an account deployment has — AUTH_MODE=
// logto with MP credentials — but with two stand-ins that make the whole bind
// journey runnable without WeChat and without a browser SSO round trip:
//
//   1. a mock code2session endpoint, so `wx.login` from the devtools simulator
//      resolves to a known, UNBOUND openid (the auto-demo trigger);
//   2. a POST /__bind route that mints a REAL single-use bind code through the
//      deployment's own /api/mp/bindcode, authenticated by a session cookie
//      signed with the deployment's session secret (the "signed-in web
//      session" the mini program's scan path expects, minus Logto's UI).
//
// Nothing here is demo-shaped: the client under test talks to a real
// single-process deployment, redeems the code at the real
// /api/mp/login-bindcode, and connects its WebSocket with the real token.
//
// Run: node scripts/mp-bind-cell.mjs [--port 3310] [--openid <id>] [--data-root <dir>]
// Prints `ready <accountOrigin> <fixtureOrigin>` once the mint route answers.

import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signSession } from "../server/session.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg("port", "3310"));
const FIXTURE_PORT = PORT + 1;
const OPENID = arg("openid", "walkthrough-unbound-openid");
const DATA_ROOT = arg("data-root", path.join(os.tmpdir(), `mp-bind-cell-${PORT}`));
const SESSION_SECRET = "walkthrough-session-secret";
const ACCOUNT = `http://127.0.0.1:${PORT}`;
const FIXTURE = `http://127.0.0.1:${FIXTURE_PORT}`;

mkdirSync(DATA_ROOT, { recursive: true });

// ── fixture: code2session + a mint route for the walkthrough ────────────────
const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, FIXTURE);
  if (url.pathname === "/code2session") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ openid: OPENID, session_key: "walkthrough-session-key" }));
  }
  // Minimal discovery doc: the deployment fetches it at boot for its metadata.
  if (url.pathname === "/oidc/.well-known/openid-configuration") {
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        issuer: `${FIXTURE}/oidc`,
        authorization_endpoint: `${FIXTURE}/oidc/auth`,
        token_endpoint: `${FIXTURE}/oidc/token`,
        jwks_uri: `${FIXTURE}/oidc/jwks`,
        end_session_endpoint: `${FIXTURE}/oidc/session/end`,
      }),
    );
  }
  // Boot fetches the JWKS too; the walkthrough never runs the browser callback,
  // so no key is ever needed to verify an id_token.
  if (url.pathname === "/oidc/jwks" || url.pathname === "/oidc/token" || url.pathname === "/oidc/auth") {
    res.setHeader("content-type", "application/json");
    return res.end(url.pathname === "/oidc/jwks" ? JSON.stringify({ keys: [] }) : "{}");
  }
  // The walkthrough's "signed-in web session": mint a real bind code.
  if (url.pathname === "/__bind") {
    res.setHeader("content-type", "application/json");
    // The deployment may not be listening yet (this route doubles as the
    // readiness probe); an unreachable deployment is an answer, not a crash.
    try {
      const cookie = signSession(
        { email: "walkthrough@corp.com", groups: ["users"], exp: Math.floor(Date.now() / 1000) + 3600 },
        SESSION_SECRET,
      );
      const r = await fetch(`${ACCOUNT}/api/mp/bindcode`, {
        headers: { accept: "application/json", cookie: `paas_session=${cookie}` },
      });
      const body = await r.text();
      return res.end(JSON.stringify({ status: r.status, body }));
    } catch (err) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ status: 0, body: err.message }));
    }
  }
  res.statusCode = 404;
  res.end("{}");
});
await new Promise((r) => fixture.listen(FIXTURE_PORT, "127.0.0.1", r));

// ── the account deployment ─────────────────────────────────────────────────
const child = spawn(process.execPath, ["server.js"], {
  cwd: REPO,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    AUTH_MODE: "logto",
    LOGTO_ENDPOINT: `${FIXTURE}/oidc`,
    LOGTO_APP_ID: "walkthrough-app",
    LOGTO_APP_SECRET: "walkthrough-secret",
    SESSION_SECRET,
    // Real MP plumbing, mock WeChat on the other end of it.
    MP_APPID: "wxwalkthrough",
    MP_SECRET: "walkthrough-mp-secret",
    MP_TOKEN_SECRET: "walkthrough-mp-token-secret",
    MP_JS_CODE_URL: `${FIXTURE}/code2session`,
    PLATFORM_DATA_DIR: DATA_ROOT,
    DSH_HOME: path.join(DATA_ROOT, "dsh-home"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
child.on("exit", (code) => {
  fixture.close();
  process.exit(code ?? 0);
});

// The deployment is a CHILD of this process, so a signal aimed at the parent
// (Ctrl-C, a pkill from a later rehearsal) must take the child with it —
// otherwise it keeps the port and the next run's readiness probe silently
// answers from the stale deployment.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill("SIGTERM");
    setTimeout(() => {
      child.kill("SIGKILL");
      fixture.close();
      process.exit(0);
    }, 1500).unref();
  });
}

// Ready = the whole chain works: the mint answers with a code.
const started = Date.now();
let last = "";
while (Date.now() - started < 120_000) {
  try {
    const r = await fetch(`${FIXTURE}/__bind`, { method: "POST" });
    const body = await r.json();
    if (r.ok && body.status === 200) {
      const code = JSON.parse(body.body).code;
      process.stdout.write(`ready ${ACCOUNT} ${FIXTURE} first-code=${code}\n`);
      break;
    }
    last = `${body.status} ${body.body}`;
  } catch (err) {
    last = err.message;
  }
  await new Promise((r) => setTimeout(r, 400));
}
if (Date.now() - started >= 120_000) {
  process.stderr.write(`not ready: ${last}\n`);
  child.kill("SIGKILL");
  fixture.close();
  process.exit(1);
}