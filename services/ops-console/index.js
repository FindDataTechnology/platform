// ── Ops console (internal, read-only, zero-dependency single file) ───────────
//
// The fd deployment health board (openspec: ops-console): pollers snapshot
// every source into SQLite; the rendered page reads snapshots only, so a
// source being down shows as a stale/failed cell instead of a hung page —
// the board must stay renderable exactly during incidents.
//
// Sources: k8s API (dedicated read-only ServiceAccount), Jenkins REST,
// Harbor /v2/, per-deployment /api/ready probes, search-relay /v1/stats.
//
// Security posture (spec requirements): every route except /healthz requires
// the bearer token from env; there is NO mutating surface anywhere; no
// credential value ever lives in this file or the repo — addresses and tokens
// arrive via env (cluster Secret at deploy time).
//
// Run: node index.js   (Node ≥ 23 for node:sqlite)

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── config (all env; refuse to start open) ───────────────────────────────────
const TOKEN = process.env.OPS_CONSOLE_TOKEN?.trim();
if (!TOKEN) {
  console.error("[ops-console] OPS_CONSOLE_TOKEN not set — refusing to start open");
  process.exit(1);
}
// Browser login (design D8): a dedicated Logto "Traditional Web" app. All
// values live in the cluster Secret; absent OIDC env ⇒ token-only mode.
// The email allowlist FAILS CLOSED: the tenant carries mini-program-bound
// end-user accounts, so "authenticated" alone is not authorization.
const LOGTO_ENDPOINT = process.env.LOGTO_ENDPOINT?.replace(/\/+$/, "");
const LOGTO_APP_ID = process.env.LOGTO_APP_ID?.trim() || "";
const LOGTO_APP_SECRET = process.env.LOGTO_APP_SECRET?.trim() || "";
const OPS_PUBLIC_URL = process.env.OPS_PUBLIC_URL?.replace(/\/+$/, "") || "";
const SESSION_SECRET = process.env.SESSION_SECRET?.trim() || "";
// Admission is ORGANIZATION-membership based: the Logto organization whose ID
// must appear in the ID token's `organizations` claim. (Tenant ROLE claims were
// tried first — this Logto build never ships the roles claim in any token,
// verified empirically — while the organizations claim is this tenant's native,
// proven gating mechanism, the same one the platform uses for group access.)
// Fail closed: no org claim / no membership, no board.
const REQUIRED_ORG = process.env.OPS_REQUIRED_ORG?.trim() || "";
const OIDC_ENABLED = !!(LOGTO_ENDPOINT && LOGTO_APP_ID && LOGTO_APP_SECRET && OPS_PUBLIC_URL && SESSION_SECRET);
if (OIDC_ENABLED) {
  console.log(`[ops-console] login gate: Logto organization membership required (fail closed)${REQUIRED_ORG ? "" : " — OPS_REQUIRED_ORG unset: logins will be refused"}`);
}
const PORT = Number(process.env.PORT) || 4598;
const HOST = process.env.HOST || "0.0.0.0"; // in-pod all-interfaces; ClusterIP/NodePort fronts it
const POLL_SECS = Number(process.env.POLL_SECS) || 45;
const RETENTION_MS = 7 * 24 * 3600 * 1000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "ops-console.db");
const NAMESPACE = process.env.WATCH_NAMESPACE || "fd-prod";
const WATCHED_DEPLOYS = (process.env.WATCHED_DEPLOYS || "platform,platform-demo,search-relay")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Scheduled-job freshness ("name:maxAgeHours"). Event-type failures — a CronJob
// that quietly stops succeeding — show up in NO other source: the deployment is
// fine and every probe is green; the only trace is a Failed Job in a TTL'd
// history nobody reads. Age is measured from `status.lastSuccessfulTime`, i.e.
// "when did this last actually work", not "when did it last run".
const WATCH_CRONJOBS = (process.env.WATCH_CRONJOBS || "erp-event-archive-backup:26,registry-credential-renewal:26")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((s) => {
    const [name, raw] = s.split(":");
    const hours = Number(raw);
    // NOT `Number(raw) || 26`: that makes 0 (and every typo) collapse to 26
    // silently — a misconfigured allowance would look configured. Say so instead
    // (found by drill: `:0` rendered max=26h).
    const usable = Number.isFinite(hours) && hours > 0;
    if (!usable) console.warn(`[ops-console] WATCH_CRONJOBS "${s}": no usable max-age — using 26h`);
    return { name, maxAgeHours: usable ? hours : 26 };
  });
const JENKINS_URL = process.env.JENKINS_URL?.replace(/\/$/, "");
const JENKINS_JOB = process.env.JENKINS_JOB || "platform";
const HARBOR_URL = process.env.HARBOR_URL?.replace(/\/$/, "");
const RELAY_URL = process.env.RELAY_URL?.replace(/\/$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN?.trim();
// PROBE_<NAME>_URL per watched deployment (NAME upper-cased, dashes → underscores)
function probeUrlFor(name) {
  return process.env[`PROBE_${name.toUpperCase().replace(/-/g, "_")}_URL`];
}

// ── snapshot store (SQLite; render never touches sources) ────────────────────
const db = new DatabaseSync(DB_PATH);
db.exec("CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL)");
db.exec("CREATE INDEX IF NOT EXISTS idx_snap_source_ts ON snapshots(source, ts)");

function storeWrite(source, obj, ts = Date.now()) {
  db.prepare("INSERT INTO snapshots (source, ts, json) VALUES (?, ?, ?)").run(source, ts, JSON.stringify(obj));
}
function storeLatest(source) {
  const row = db.prepare("SELECT ts, json FROM snapshots WHERE source = ? ORDER BY ts DESC LIMIT 1").get(source);
  if (!row) return null;
  try { return { ts: row.ts, data: JSON.parse(row.json) }; } catch { return null; }
}
// Last SUCCESSFUL poll for a source — failed polls also store a snapshot (with
// __error), so "age of newest row" would report the failure's own timestamp
// as recovery age (fix-ops-console-board-alarms: that lie is what this fixes).
function storeLastOk(source) {
  const row = db.prepare("SELECT ts FROM snapshots WHERE source = ? AND json NOT LIKE '%__error%' ORDER BY ts DESC LIMIT 1").get(source);
  return row ? row.ts : null;
}
function pruneOld() {
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(Date.now() - RETENTION_MS);
}

// ── tiny HTTP client (zero-dep: supports the SA's CA for in-cluster https) ──
function getJson(url, { headers = {}, ca, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(url, { headers, ca, timeout: timeoutMs, rejectUnauthorized: !!ca || u.protocol === "https:" }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${u.host}${u.pathname}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error(`non-JSON from ${u.host}${u.pathname}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(new Error(`timeout from ${u.host}`)); });
    req.on("error", reject);
  });
}

// ── session cookies + OIDC (browser login; HMAC-signed, no deps) ─────────────
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE = "ops_session";
const STATE_COOKIE = "ops_state";
const SESSION_TTL_MS = 24 * 3600 * 1000;
const sign = (payload) => createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
function cookieSet(name, payload, maxAgeMs) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${name}=${body}.${sign(body)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}
function cookieClear(name) { return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`; }
function cookieRead(header, name) {
  const raw = (header || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  const [body, sig] = raw.slice(name.length + 1).split(".");
  if (!body || !sig) return null;
  const want = sign(body);
  if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch { return null; }
}
async function postForm(url, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "http:" ? http : https;
    const body = new URLSearchParams(params).toString();
    const req = mod.request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 10_000 }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { reject(new Error("non-JSON from OIDC token endpoint")); } });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

// Discovery once at boot; login routes 503 if OIDC is off.
let oidc = null;
if (OIDC_ENABLED) {
  const discoUrl = LOGTO_ENDPOINT.endsWith("/oidc")
    ? `${LOGTO_ENDPOINT}/.well-known/openid-configuration`
    : `${LOGTO_ENDPOINT}/oidc/.well-known/openid-configuration`;
  getJson(discoUrl).then((d) => {
    oidc = { auth: d.authorization_endpoint, token: d.token_endpoint, userinfo: d.userinfo_endpoint, endSession: d.end_session_endpoint || null };
    console.log("[ops-console] OIDC login ready");
  }).catch((e) => console.error(`[ops-console] OIDC discovery failed: ${e.message} (login unavailable, token mode active)`));
}

// ── k8s source (in-cluster read-only SA) ─────────────────────────────────────
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const KUBE_BASE = process.env.KUBE_API_BASE ||
  (fs.existsSync(path.join(SA_DIR, "token"))
    ? `https://${process.env.KUBERNETES_SERVICE_HOST}:${process.env.KUBERNETES_SERVICE_PORT || 443}`
    : "");
const saToken = (() => { try { return fs.readFileSync(path.join(SA_DIR, "token"), "utf8").trim(); } catch { return ""; } })();
const saCa = (() => { try { return fs.readFileSync(path.join(SA_DIR, "ca.crt"), "utf8"); } catch { return ""; } })();
const kubeHeaders = saToken ? { authorization: `Bearer ${saToken}` } : {};
async function kube(pathname) {
  if (!KUBE_BASE) throw new Error("k8s API not configured (no SA, no KUBE_API_BASE)");
  return getJson(`${KUBE_BASE}${pathname}`, { headers: kubeHeaders, ca: saCa || undefined });
}

const ARGO_APP = process.env.ARGO_APP || "all-services-prod";
async function pollK8s() {
  const [deps, nodes, events, app, cjs] = await Promise.all([
    kube(`/apis/apps/v1/namespaces/${NAMESPACE}/deployments`),
    kube("/api/v1/nodes"),
    kube(`/api/v1/namespaces/${NAMESPACE}/events`),
    kube(`/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/${ARGO_APP}`).catch(() => null),
    // Tolerated on purpose: an SA without batch read must not take the whole
    // k8s source down (that would blank the deployment cards too). `null` here
    // means "unreadable" and renders explicitly as n/a, never as "no cronjobs".
    kube(`/apis/batch/v1/namespaces/${NAMESPACE}/cronjobs`).catch(() => null),
  ]);
  // metrics.k8s.io is best-effort: absent → per-node memory "n/a" (design open question)
  let nodeMetrics = null;
  try {
    nodeMetrics = await kube("/apis/metrics.k8s.io/v1beta1/nodes");
  } catch { /* metrics-server unreadable through the SA or absent */ }

  const memByNode = new Map(
    (nodeMetrics?.items || []).map((m) => [m.metadata.name, m.usage]),
  );
  return {
    deployments: (deps.items || []).map((d) => ({
      name: d.metadata.name,
      replicas: d.spec?.replicas ?? null,
      ready: d.status?.readyReplicas ?? 0,
      image: d.spec?.template?.spec?.containers?.[0]?.image || null,
    })),
    nodes: (nodes.items || []).map((n) => ({
      name: n.metadata.labels?.["kubernetes.io/hostname"] || n.metadata.name,
      ready: n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True",
      memUsageBytes: memByNode.get(n.metadata.name)?.memory || null,
      memAllocatable: n.status?.allocatable?.memory || null,
      pressure: n.status?.conditions?.some((c) => /pressure/i.test(c.type) && c.status === "True") || false,
    })),
    // 24h Warning/eviction-ish events, small and counting-only
    warningEvents: (events.items || [])
      .filter((e) => e.type === "Warning" && Date.now() - Date.parse(e.lastTimestamp || 0) < 24 * 3600 * 1000)
      .map((e) => ({ reason: e.reason, count: e.count || 1, involved: e.involvedObject?.name || "" })),
    argocd: app ? {
      sync: app.status?.sync?.status || "Unknown",
      health: app.status?.health?.status || "Unknown",
      resources: (app.status?.resources || []).map((r) => ({ kind: r.kind, name: r.name, status: r.status || "" })),
    } : null,
    // null = the list call failed (RBAC or API error) — distinct from "no cronjobs"
    cronjobs: cjs ? (cjs.items || []).map((c) => ({
      name: c.metadata.name,
      schedule: c.spec?.schedule || null,
      suspend: !!c.spec?.suspend,
      lastSuccess: c.status?.lastSuccessfulTime || null,
    })) : null,
  };
}

// ── jenkins source (anonymous reads, as exercised on every deploy day) ───────
async function pollJenkins() {
  if (!JENKINS_URL) throw new Error("JENKINS_URL not configured");
  const [queue, job, lastOk] = await Promise.all([
    getJson(`${JENKINS_URL}/queue/api/json`),
    getJson(`${JENKINS_URL}/job/${JENKINS_JOB}/api/json?tree=builds[number,result,building,timestamp]{0,10}`),
    getJson(`${JENKINS_URL}/job/${JENKINS_JOB}/lastSuccessfulBuild/api/json?tree=number,result,timestamp`),
  ]);
  // The pushed image tag lives in the build log's final lines — same read the
  // deploy runbook uses; no Jenkins plugin API assumptions.
  let builtTag = null;
  try {
    const log = await new Promise((resolve, reject) => {
      const u = new URL(`${JENKINS_URL}/job/${JENKINS_JOB}/lastSuccessfulBuild/consoleText`);
      const mod = u.protocol === "http:" ? http : https;
      const req = mod.get(u, { timeout: 10_000 }, (res) => {
        let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b));
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
    });
    builtTag = (log.match(/Pushed[^\n]*:(sha-\w+)/) || [])[1] || null;
  } catch { builtTag = null; }
  return {
    queueDepth: (queue.items || []).length,
    lastBuilds: (job.builds || []).map((b) => ({ number: b.number, result: b.result, building: b.building })),
    lastSuccessful: lastOk ? { number: lastOk.number, ts: lastOk.timestamp } : null,
    builtTag,
  };
}

// ── harbor / probes / relay sources ──────────────────────────────────────────
async function pollHarbor() {
  if (!HARBOR_URL) throw new Error("HARBOR_URL not configured");
  // Any HTTP response (including 401) proves the registry is up; the k8s poller
  // carries the harbor-core pod state.
  await getJson(`${HARBOR_URL}/v2/`, { headers: { accept: "application/json" } }).catch((err) => {
    if (!/HTTP \d+/.test(err.message)) throw err; // connection-level failure
  });
  return { reachable: true };
}

async function pollProbes() {
  const out = {};
  await Promise.all(WATCHED_DEPLOYS.map(async (name) => {
    const url = probeUrlFor(name);
    if (!url) { out[name] = { configured: false }; return; }
    const started = Date.now();
    try {
      await getJson(url, { timeoutMs: 5_000 });
      out[name] = { configured: true, ok: true, ms: Date.now() - started };
    } catch (err) {
      out[name] = { configured: true, ok: false, error: err.message };
    }
  }));
  return out;
}

async function pollRelay() {
  if (!RELAY_URL || !RELAY_TOKEN) throw new Error("RELAY_URL/RELAY_TOKEN not configured");
  return getJson(`${RELAY_URL}/v1/stats`, { headers: { authorization: `Bearer ${RELAY_TOKEN}` } });
}

// ── agent fleet (add-agent-platform-ops 5.1) ────────────────────────────────
// Two pollers: the runner's health surface (five live states) and the
// platform's billing board (key refs + per-deployer balances). Both degrade
// visibly — a failed read renders stale/failed, never omits the section.
const RUNNER_HEALTH_URL = process.env.RUNNER_HEALTH_URL || "";
const PLATFORM_BOARD_URL = process.env.PLATFORM_BOARD_URL || "";
const PLATFORM_BOARD_TOKEN = process.env.PLATFORM_BOARD_TOKEN || "";
// Fleet overview (add-fleet-board, program slice ④): the Wanxing observer's
// board is the data plane — the console renders it, it does not re-derive
// fleet state from direct runner polls.
const FLEET_BOARD_URL = process.env.FLEET_BOARD_URL || "";
const FLEET_BOARD_TOKEN = process.env.FLEET_BOARD_TOKEN || "";
// Internal pack usage (add-pack-usage-telemetry): the platform's own
// /api/ops/pack-usage aggregate — the M1 weekly-active-pack gate reads here.
const PACK_USAGE_URL = process.env.PACK_USAGE_URL || "";
const PACK_USAGE_TOKEN = process.env.PACK_USAGE_TOKEN || "";

async function pollRunnerHealth() {
  if (!RUNNER_HEALTH_URL) throw new Error("RUNNER_HEALTH_URL not configured");
  return getJson(RUNNER_HEALTH_URL, { timeoutMs: 8000 });
}

async function pollFleetBoard() {
  if (!FLEET_BOARD_URL) throw new Error("FLEET_BOARD_URL not configured");
  return getJson(`${FLEET_BOARD_URL.replace(/\/+$/, "")}/api/fleet/v1/board`, {
    headers: { Authorization: `Bearer ${FLEET_BOARD_TOKEN}` },
    timeoutMs: 8000,
  });
}

async function pollBillingBoard() {
  if (!PLATFORM_BOARD_URL) throw new Error("PLATFORM_BOARD_URL not configured");
  return getJson(PLATFORM_BOARD_URL, {
    headers: { Authorization: `Bearer ${PLATFORM_BOARD_TOKEN}` },
    timeoutMs: 8000,
  });
}

async function pollPackUsage() {
  if (!PACK_USAGE_URL) throw new Error("PACK_USAGE_URL not configured");
  return getJson(`${PACK_USAGE_URL.replace(/\/+$/, "")}/api/ops/pack-usage?days=7`, {
    headers: { Authorization: `Bearer ${PACK_USAGE_TOKEN}` },
    timeoutMs: 8000,
  });
}

// ── version drift ────────────────────────────────────────────────────────────
// Cluster-internal facts only: the running pod image tag and the ArgoCD sync
// state. Build-pipeline tags deliberately do NOT participate: the canonical
// image pipeline (GHA→TCR) is not observable from the cluster, so comparing
// against the fallback build system's last tag asserted a direction the
// console cannot know and produced a permanent false "newer build not rolled"
// on every canonical-path deploy (fix-ops-console-board-alarms). "Manifest
// lags the build" visibility belongs to ArgoCD's OutOfSync, which IS a fact.
// A Synced application means manifest == cluster, so a parsed running tag is
// shown as in-agreement.
function computeDrift(runningTag, argocd) {
  const run = runningTag?.match(/(sha-\w+)$/)?.[1] || null;
  const drift = { running: run, status: "unknown" };
  if (!argocd) { return drift; }
  drift.status = argocd.sync === "Synced" ? "in-agreement" : "cluster-out-of-sync";
  return drift;
}

// Drift fact granularity: the deployment's OWN status in the ArgoCD app's
// resource list — an app-wide OutOfSync caused by an unwatched deployment
// must not flag an individually-synced card. Unlisted deployments fall back
// to the app-level status (listing may lag) (fix-ops-console-drift-granularity).
function argocdStatusFor(name, argocd) {
  if (!argocd) return null;
  const own = (argocd.resources || []).find((r) => r.kind === "Deployment" && r.name === name);
  return { sync: own?.status || argocd.sync };
}

// ── poll loop ────────────────────────────────────────────────────────────────
const SOURCES = [
  ["k8s", pollK8s],
  ["jenkins", pollJenkins],
  ["harbor", pollHarbor],
  ["probes", pollProbes],
  ["relay", pollRelay],
  ["runnerHealth", pollRunnerHealth],
  ["billingBoard", pollBillingBoard],
  ["fleetBoard", pollFleetBoard],
  ["packUsage", pollPackUsage],
];
let pollBusy = false;
async function pollOnce() {
  if (pollBusy) return; // single-flight: no retry storms (next cycle retries)
  pollBusy = true;
  for (const [name, fn] of SOURCES) {
    try {
      storeWrite(name, await fn());
    } catch (err) {
      // A failed poll must NOT delete the previous snapshot — the renderer
      // shows the last-known state with a stale timestamp (spec scenario).
      storeWrite(name, { __error: err.message });
    }
  }
  try { pruneOld(); } catch { /* prune is best-effort */ }
  pollBusy = false;
}
// Test seam: importing this module (node:test) must not boot the poller or
// the listener — both are main-guarded, so the exported helpers can be
// exercised against a throwaway DB without a server.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  pollOnce();
  setInterval(pollOnce, POLL_SECS * 1000);
}

// ── board model + render (server-side string template, zero frontend build) ─
function boardModel() {
  const snap = Object.fromEntries(SOURCES.map(([n]) => [n, storeLatest(n)]));
  const k8s = snap.k8s?.data?.__error ? null : snap.k8s?.data || null;
  const jenkins = snap.jenkins?.data?.__error ? null : snap.jenkins?.data || null;
  const harbor = snap.harbor?.data?.__error ? null : snap.harbor?.data || null;
  const probes = snap.probes?.data?.__error ? null : snap.probes?.data || null;
  const relay = snap.relay?.data?.__error ? null : snap.relay?.data || null;

  const cards = WATCHED_DEPLOYS.map((name) => {
    const dep = k8s?.deployments?.find((d) => d.name === name) || null;
    // search-relay sits outside the ArgoCD application: no GitOps fact applies,
    // so its drift field renders n/a instead of forcing a derived verdict.
    const drift = dep
      ? (name === "search-relay"
          ? { running: dep.image?.split(":").pop() || null, status: "n/a" }
          : computeDrift(dep.image, argocdStatusFor(name, k8s?.argocd)))
      : null;
    return {
      name,
      replicas: dep ? `${dep.ready}/${dep.replicas}` : null,
      runningTag: dep?.image?.split(":").pop() || null,
      probe: probes?.[name] || null,
      drift,
    };
  });

  const oomEvictions = (k8s?.warningEvents || []).filter((e) => /^(Evict|SystemOOM|OOM)/i.test(e.reason));

  // Scheduled jobs: only the watched ones become rows, but a watched name that
  // is absent from the cluster is itself a finding (the backup policy quietly
  // disappeared), so it renders as missing rather than silently vanishing.
  const cronjobs = !k8s || k8s.cronjobs === null
    ? null
    : WATCH_CRONJOBS.map(({ name, maxAgeHours }) => {
        const c = (k8s.cronjobs || []).find((x) => x.name === name) || null;
        const ageHours = c?.lastSuccess ? (Date.now() - Date.parse(c.lastSuccess)) / 3_600_000 : null;
        return {
          name,
          maxAgeHours,
          schedule: c?.schedule ?? null,
          missing: !c,
          suspend: !!c?.suspend,
          lastSuccess: c?.lastSuccess ?? null,
          ageHours,
          // Suspended counts as stale on purpose: a daily backup that was
          // switched off is an active data-loss exposure, not a neutral state.
          stale: !c || !!c.suspend || ageHours === null || ageHours > maxAgeHours,
        };
      });

  return {
    ts: Date.now(),
    cards,
    cronjobs,
    banner: {
      nodes: k8s?.nodes || [],
      oomEvictions: oomEvictions.reduce((a, e) => a + e.count, 0),
      jenkinsQueue: jenkins?.queueDepth ?? null,
      argocd: k8s?.argocd || null,
    },
    jenkins,
    harbor,
    relay,
    stale: {
      k8s: snap.k8s && Date.now() - snap.k8s.ts > POLL_SECS * 4000,
      jenkins: snap.jenkins && Date.now() - snap.jenkins.ts > POLL_SECS * 4000,
    },
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ago = (ts) => (ts ? `${Math.max(0, Math.round((Date.now() - ts) / 1000))}s ago` : "never");

// Overall health: the one dot a tired operator reads first. Red beats amber
// beats green; "stale source" counts as amber because a dark cell lies.
function overallStatus(m) {
  let bad = 0, warn = 0;
  for (const c of m.cards) {
    if (c.replicas && c.replicas.startsWith("0")) bad += 1;
    if (c.probe?.configured && c.probe.ok === false) bad += 1;
    if (c.drift && !["in-agreement", "unknown", "n/a"].includes(c.drift.status)) warn += 1;
  }
  if (m.harbor && m.harbor.reachable === false) bad += 1;
  // A watched job that stopped succeeding is red, not amber: nobody else will
  // notice, and the damage (unbacked event archive, lapsed registry token) is
  // invisible until it is expensive.
  for (const cj of m.cronjobs || []) if (cj.stale) bad += 1;
  if (m.banner.jenkinsQueue > 0) warn += 1;
  if (m.banner.oomEvictions > 0) warn += 1;
  if (m.stale.k8s || m.stale.jenkins) warn += 1;
  // Application-level divergence counts exactly once: with per-deployment
  // verdicts the watched cards can all be clean while an unwatched deployment
  // drifts the app — the one-dot summary must not go green over that.
  if (m.banner.argocd && m.banner.argocd.sync !== "Synced") warn += 1;
  if (bad) return { cls: "bad", label: `${bad} incident${bad > 1 ? "s" : ""}`, count: bad };
  if (warn) return { cls: "warn", label: `${warn} warning${warn > 1 ? "s" : ""}`, count: warn };
  return { cls: "ok", label: "all nominal", count: 0 };
}

function renderBoard() {
  const m = boardModel();
  const overall = overallStatus(m);

  // ── cluster vitals strip ──
  const nodes = [...m.banner.nodes].sort((a, b) => (b.memUsageBytes || 0) - (a.memUsageBytes || 0));
  const nodeChips = nodes.map((n) => {
    const pct = n.memUsageBytes && n.memAllocatable
      ? Math.round((parseInt(n.memUsageBytes, 10) / parseInt(n.memAllocatable, 10)) * 100) : null;
    const cls = !n.ready ? "bad" : n.pressure || (pct !== null && pct >= 85) ? "warn" : "";
    return `<div class="vchip ${cls}" title="${esc(n.name)}${pct !== null ? ` — memory ${pct}% of allocatable` : ""}${n.pressure ? " — pressure" : ""}">
      <span class="vname">${esc(n.name)}</span>
      <span class="vbar"><span class="vfill" style="width:${Math.min(100, pct ?? 0)}%"></span></span>
      <span class="vpct">${pct === null ? "n/a" : pct + "%"}</span>
    </div>`;
  }).join("");
  const vitals = `<section class="vitals" aria-label="cluster vitals">
    ${nodeChips}
    <span class="vsep"></span>
    <div class="vchip ${m.banner.oomEvictions > 0 ? "warn" : ""}" title="Evicted + OOM events in the last 24h">
      <span class="vname">evict/oom 24h</span><span class="vbig ${m.banner.oomEvictions > 0 ? "warn" : ""}">${m.banner.oomEvictions}</span>
    </div>
    <div class="vchip ${m.banner.jenkinsQueue > 0 ? "warn" : ""}" title="Jobs waiting for the Jenkins executor">
      <span class="vname">jenkins queue</span><span class="vbig ${m.banner.jenkinsQueue > 0 ? "warn" : ""}">${m.banner.jenkinsQueue ?? "n/a"}</span>
    </div>
    <div class="vchip" title="GitOps application state">
      <span class="vname">argocd</span>
      <span class="vbig ${m.banner.argocd?.sync === "Synced" ? "ok" : "warn"}">${m.banner.argocd ? esc(m.banner.argocd.sync) : "n/a"}</span>
    </div>
  </section>`;

  // ── deployment chain cards ──
  const chain = (label, value, cls = "", title = "") =>
    `<div class="step ${cls}"${title ? ` title="${esc(title)}"` : ""}><span class="slabel">${esc(label)}</span><span class="svalue">${value === null || value === "" ? "n/a" : value}</span></div>`;
  const arrow = `<span class="sarrow" aria-hidden="true">→</span>`;

  const cards = m.cards.map((c) => {
    const driftCls = !c.drift ? "" : { "in-agreement": "ok", unknown: "", "n/a": "" }[c.drift.status] ?? "warn";
    const driftTxt = !c.drift ? "no data" : {
      "in-agreement": `in sync at ${c.drift.running || "?"}`,
      "cluster-out-of-sync": "cluster diverges from GitOps",
      "n/a": "n/a — not GitOps-managed",
      unknown: "no drift data",
    }[c.drift.status] || "no drift data";
    const probe = c.probe?.configured
      ? (c.probe.ok
        ? chain("probe", `ok · ${c.probe.ms}ms`, "ok")
        : chain("probe", "FAIL", "bad", c.probe.error || ""))
      : chain("probe", "not configured", "", "no PROBE_ URL for this deployment");
    const synced = c.name !== "search-relay";
    return `<article class="card">
      <header class="chead">
        <h2>${esc(c.name)}</h2>
        <span class="drift ${driftCls}"><span class="dot"></span>${esc(driftTxt)}</span>
      </header>
      <div class="chain">
        ${chain("image", c.runningTag)}
        ${arrow}
        ${synced ? chain("gitops", m.banner.argocd?.sync ?? null, m.banner.argocd?.sync === "Synced" ? "ok" : "warn") : chain("gitops", "n/a")}
        ${arrow}
        ${chain("pods", c.replicas, c.replicas && !c.replicas.startsWith("0") ? "ok" : "bad")}
        ${arrow}
        ${probe}
      </div>
    </article>`;
  }).join("");

  // ── jenkins / harbor / relay ──
  const jenkinsCard = m.jenkins ? `<article class="card">
    <header class="chead"><h2>jenkins</h2>
      <span class="drift ${m.jenkins.queueDepth > 0 ? "warn" : "ok"}"><span class="dot"></span>queue ${m.jenkins.queueDepth}</span></header>
    <div class="chain">
      ${chain("last ok build", m.jenkins.lastSuccessful ? `#${m.jenkins.lastSuccessful.number}` : "n/a", "ok", m.jenkins.lastSuccessful ? ago(m.jenkins.lastSuccessful.ts) : "")}
      ${chain("pushed tag", m.jenkins.builtTag ?? "n/a")}
      ${chain("history", (m.jenkins.lastBuilds || []).slice(0, 4).map((b) => `#${b.number}${b.building ? "…" : b.result === "SUCCESS" ? "✓" : b.result ? "✗" : "?"}`).join("  "))}
    </div>
  </article>` : `<article class="card is-down"><header class="chead"><h2>jenkins</h2><span class="drift bad"><span class="dot"></span>unreachable${m.stale.jenkins ? " · stale" : ""}</span></header></article>`;

  const harborCard = m.harbor
    ? `<article class="card"><header class="chead"><h2>harbor</h2><span class="drift ok"><span class="dot"></span>reachable</span></header></article>`
    : `<article class="card is-down"><header class="chead"><h2>harbor</h2><span class="drift bad"><span class="dot"></span>unreachable</span></header></article>`;

  const relayBody = m.relay ? (() => {
    const cap = m.relay.dailyCap ?? 300;
    const used = (m.relay.tokens || []).reduce((a, t) => a + t.count, 0);
    const pct = Math.min(100, Math.round((used / cap) * 100));
    const hit = m.relay.cache?.hitRate;
    return `<article class="card"><header class="chead"><h2>search-relay</h2>
      <span class="drift ${pct >= 90 ? "warn" : "ok"}"><span class="dot"></span>${used}/${cap} today</span></header>
      <div class="chain">
        ${chain("quota", `${used}/${cap}`, pct >= 90 ? "warn" : "ok", (m.relay.tokens || []).map((t) => `${t.prefix} ${t.count}`).join(", "))}
        ${chain("cache hit", hit === null || hit === undefined ? "n/a" : `${Math.round(hit * 100)}%`, "ok", `${m.relay.cache?.hits ?? 0} hits / ${m.relay.cache?.misses ?? 0} misses`)}
        ${chain("5xx", String((m.relay.errors?.upstream ?? 0) + (m.relay.errors?.poolDry ?? 0)), (m.relay.errors?.upstream ?? 0) + (m.relay.errors?.poolDry ?? 0) > 0 ? "warn" : "ok", `${m.relay.errors?.poolDry ?? 0} pool-dry`)}
        ${chain("key fails", String((m.relay.keys || []).reduce((a, k) => a + k.failures, 0)), "")}
      </div></article>`;
  })() : `<article class="card is-down"><header class="chead"><h2>search-relay</h2><span class="drift bad"><span class="dot"></span>stats unavailable${m.stale.relay ? " · stale" : ""}</span></header></article>`;

  const updated = ago(m.ts);
  const staleNote = m.stale.k8s || m.stale.jenkins ? `<span class="staleflag">some sources stale</span>` : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="refresh" content="30">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>fd ops</title>
<style>
  :root{
    --bg:oklch(0.16 0 0);--card:oklch(0.19 0 0);--card-2:oklch(0.22 0 0);
    --border:oklch(0.28 0 0);--fg:oklch(0.96 0 0);--muted:oklch(0.65 0 0);
    --accent:oklch(0.64 0.16 250);--ok:oklch(0.72 0.17 145);--warn:oklch(0.80 0.15 85);--bad:oklch(0.62 0.22 25);
  }
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{margin:0;padding:20px clamp(14px,3vw,32px) 40px;font:400 13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
  ::selection{background:oklch(0.64 0.16 250/.35)}
  a{color:var(--accent)}
  .wrap{max-width:1280px;margin:0 auto}
  header.page{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:2px 0 14px}
  h1{font-size:18px;font-weight:650;letter-spacing:-0.02em;margin:0}
  h1 .lamp{display:inline-block;width:8px;height:8px;border-radius:99px;background:var(--accent);margin-right:9px;box-shadow:0 0 8px oklch(0.64 0.16 250/.55);vertical-align:1px}
  .pagestatus{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .pill{display:inline-flex;align-items:center;gap:7px;padding:3px 11px;border-radius:99px;border:1px solid var(--border);background:var(--card);font-size:12px;font-weight:550}
  .pill .dot{width:7px;height:7px}
  .pill.ok{color:var(--ok);border-color:oklch(0.72 0.17 145/.35)}
  .pill.warn{color:var(--warn);border-color:oklch(0.80 0.15 85/.4)}
  .pill.bad{color:var(--bad);border-color:oklch(0.62 0.22 25/.45)}
  .updated{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
  .logout{color:var(--muted);font-size:12px;text-decoration:none;padding:3px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card)}
  .logout:hover{color:var(--fg);border-color:var(--accent)}
  .staleflag{color:var(--warn);font-size:12px}
  .vitals{display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;margin:0 0 16px}
  .vchip{display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--card);border:1px solid var(--border);border-radius:8px;min-height:32px}
  .vchip.warn{border-color:oklch(0.80 0.15 85/.45)}
  .vchip.bad{border-color:oklch(0.62 0.22 25/.5)}
  .vname{font-size:11px;color:var(--muted);white-space:nowrap}
  .vbar{width:56px;height:6px;border-radius:99px;background:oklch(0.28 0 0);overflow:hidden;display:inline-block}
  .vfill{display:block;height:100%;background:var(--accent);border-radius:99px}
  .vchip.warn .vfill{background:var(--warn)}.vchip.bad .vfill{background:var(--bad)}
  .vpct,.vbig{font-size:12px;font-variant-numeric:tabular-nums}
  .vbig.warn{color:var(--warn)}.vbig.ok{color:var(--ok)}
  .vsep{width:1px;background:var(--border);margin:2px 4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:14px}
  .card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:13px 16px 15px;box-shadow:0 1px 2px oklch(0 0 0/.25)}
  .card.is-down{border-color:oklch(0.62 0.22 25/.4)}
  .chead{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 10px}
  h2{font-size:13.5px;font-weight:600;margin:0;letter-spacing:0.01em}
  .drift{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);text-align:right}
  .drift.ok{color:var(--ok)}.drift.warn{color:var(--warn)}.drift.bad{color:var(--bad)}
  .dot{width:6px;height:6px;border-radius:99px;background:var(--muted);flex:none}
  .drift.ok .dot{background:var(--ok)}.drift.warn .dot{background:var(--warn)}.drift.bad .dot{background:var(--bad)}
  .chain{display:flex;align-items:flex-start;gap:9px;flex-wrap:wrap}
  .step{display:flex;flex-direction:column;gap:2px;min-width:58px}
  .slabel{font-size:10px;text-transform:uppercase;letter-spacing:0.06em;color:var(--muted)}
  .svalue{font-size:12.5px;font-variant-numeric:tabular-nums;word-break:break-all}
  .step.ok .svalue{color:var(--ok)}.step.warn .svalue{color:var(--warn)}.step.bad .svalue{color:var(--bad)}
  .sarrow{color:oklch(0.4 0 0);font-size:12px;margin-top:13px}
  .muted{color:var(--muted);font-size:12px}
  @media (max-width:640px){.chain{flex-direction:column;gap:7px}.sarrow{display:none}.grid{grid-template-columns:1fr}}
  @media (prefers-reduced-motion:no-preference){.card{transition:border-color .2s ease-out}}
</style></head><body>
<div class="wrap">
  <header class="page">
    <h1><span class="lamp"></span>fd ops</h1>
    <div class="pagestatus">
      <span class="pill ${overall.cls}"><span class="dot"></span>${esc(overall.label)}</span>
      ${staleNote ? `<span class="staleflag">${staleNote}</span>` : ""}
      <span class="updated">polled ${esc(updated)} · refreshes every ${POLL_SECS}s</span>
      <a class="logout" href="/auth/logout" title="End this board session">log out</a>
    </div>
  </header>
  ${vitals}
  ${renderCronjobs(m)}
  ${renderFleetOverview()}
  ${renderFleet()}
  ${renderPackUsage()}
  <div class="grid">${cards}${jenkinsCard}${harborCard}${relayBody}</div>
</div>
</body></html>`;
}

// ── scheduled jobs (harden-erp-operations 3.2) ─────────────────────────────
// Event-type failures: nothing else on this board moves when a CronJob stops
// succeeding. Same degradation discipline as every other section — unreadable,
// missing, suspended and never-succeeded all render explicitly; the section
// never disappears (an empty section would read as "all clear").
function renderCronjobs(m) {
  if (!WATCH_CRONJOBS.length) return "";
  const span = (hours) => (hours >= 48 ? `${Math.floor(hours / 24)}d` : `${Math.floor(hours)}h`);
  if (m.cronjobs === null) {
    return `<section class="vitals" aria-label="scheduled jobs">
    <div class="vchip warn" title="WATCH_CRONJOBS is configured but batch/v1 cronjobs could not be listed — check the console SA's RBAC">
      <span class="vname">scheduled jobs</span>
      <span class="vbig warn">unreadable</span>
      <span class="vpct">cannot list batch/v1 cronjobs</span>
    </div>
  </section>`;
  }
  const chips = m.cronjobs.map((c) => {
    const cls = c.stale ? "bad" : "ok";
    const detail = c.missing
      ? "not found in namespace"
      : c.suspend
        ? "suspended"
        : c.ageHours === null
          ? "no successful run yet"
          : `last success ${span(c.ageHours)} ago`;
    return `<div class="vchip ${cls}" title="${esc(`${c.name} · schedule ${c.schedule || "?"} · allowed age ${c.maxAgeHours}h${c.lastSuccess ? ` · last success ${c.lastSuccess}` : ""}`)}">
      <span class="vname">${esc(c.name)}</span>
      <span class="vbig ${cls === "bad" ? "warn" : "ok"}">${c.missing ? "n/a" : c.ageHours === null ? "—" : span(c.ageHours)}</span>
      <span class="vpct">${esc(detail)}</span>
    </div>`;
  }).join("");
  return `<section class="vitals" aria-label="scheduled jobs">${chips}</section>`;
}

// ── fleet overview (add-fleet-board, program slice ④) ───────────────────────
// The Wanxing observer's board is the data plane; this render is a straight
// projection. Degradation follows the console's discipline: unconfigured and
// failed states render explicitly, the section never disappears.
function renderFleetOverview() {
  const snap = storeLatest("fleetBoard");
  const f = snap?.data ?? null;
  const err = f?.__error ?? null;
  const age = snap ? ago(snap.ts) : null;
  if (!FLEET_BOARD_URL) {
    return `<section class="fleet" aria-label="fleet overview">
  <h2>fleet overview</h2>
  <p class="dim">not configured — set FLEET_BOARD_URL/FLEET_BOARD_TOKEN (Wanxing observer board)</p>
</section>`;
  }
  if (!f || f.__error) {
    // True recovery age: failed polls store snapshots too, so the last-ok age
    // must come from the most recent SUCCESSFUL poll — never the failed
    // write's own timestamp (which would claim "last ok 31s ago" while the
    // source has been failing since boot).
    const okTs = storeLastOk("fleetBoard");
    return `<section class="fleet" aria-label="fleet overview">
  <h2>fleet overview</h2>
  <p class="warn">board read failed${err ? ` (${esc(err)})` : ""}${okTs ? ` — last ok ${esc(ago(okTs))}` : " — never succeeded"}</p>
</section>`;
  }
  const states = f.states ?? {};
  const statePills = Object.entries(states)
    .map(([k, v]) => `<span class="pill ${k === "serving" || k === "resident" ? "ok" : k === "paused" ? "warn" : ""}">${esc(k)} ${Number(v)}</span>`)
    .join(" ");
  const runners = Object.entries(f.runners ?? {})
    .map(([id, s]) => `<tr><td class="mono">${esc(id)}</td><td>${Number(s.children ?? 0)}</td><td>${Number(s.queued ?? 0)}</td><td>${Math.round(Number(s.budget_mb ?? 0))}/${Number(s.budget_mb_limit ?? "?")}MB</td><td>${Number(s.agents ?? 0)}</td></tr>`)
    .join("");
  const lagRows = (f.ingest_lag ?? [])
    .map((l) => {
      const slow = Number(l.event_age_ms) > 5 * 60_000;
      return `<tr><td class="mono">${esc(l.source)}</td><td class="${slow ? "warn" : ""}">${l.event_age_ms == null ? "?" : Math.round(l.event_age_ms / 1000) + "s"}</td><td>${l.arrival_age_ms == null ? "?" : Math.round(l.arrival_age_ms / 1000) + "s"}</td></tr>`;
    })
    .join("");
  const pending = f.settled_pending ?? {};
  const wake = f.wake_ms ?? {};
  return `<section class="fleet" aria-label="fleet overview">
  <h2>fleet overview <span class="dim">(${esc(String(f.window ?? "24h"))} · updated ${esc(age ?? "?")})</span></h2>
  <div class="fleetgrid">
    <div>
      <h3>${Number(f.agents_total ?? 0)} agent(s)</h3>
      <p>${statePills || '<span class="dim">no state events in window</span>'}</p>
      <table><tbody>
        <tr><td>turns / errors</td><td>${Number(f.turns ?? 0)} / ${Number(f.errors ?? 0)}</td></tr>
        <tr><td>wake p50/p95</td><td>${wake.p50 == null ? "n/a" : wake.p50 + "ms"} / ${wake.p95 == null ? "n/a" : wake.p95 + "ms"}</td></tr>
        <tr><td>budget kills / reaped</td><td>${Number(f.budget_kills ?? 0)} / ${Number(f.reaped ?? 0)}</td></tr>
        <tr><td>settled pending</td><td class="${pending.count ? "warn" : ""}">${Number(pending.count ?? 0)}${pending.usd ? ` ($${Number(pending.usd).toFixed(2)})` : ""}</td></tr>
        <tr><td>billed</td><td>${Number(f.minutes_billed ?? 0)}min · $${Number(f.usd ?? 0).toFixed(2)}</td></tr>
      </tbody></table>
    </div>
    <div>
      <h3>runners</h3>
      ${runners ? `<table><thead><tr><th>runner</th><th>children</th><th>queued</th><th>budget</th><th>agents</th></tr></thead><tbody>${runners}</tbody></table>` : `<p class="dim">no runner_stats in window</p>`}
      <h3>ingest lag</h3>
      ${lagRows ? `<table><thead><tr><th>source</th><th>event age</th><th>arrival age</th></tr></thead><tbody>${lagRows}</tbody></table>` : `<p class="dim">no recent events</p>`}
    </div>
  </div>
</section>`;
}

// ── agent fleet section (add-agent-platform-ops 5.1) ───────────────────────
// runnerHealth gives the five live states; billingBoard gives key refs and
// balances. Failed reads render failed with age — rows are never omitted.
function renderFleet() {
  const h = storeLatest("runnerHealth")?.data ?? null;
  const b = storeLatest("billingBoard")?.data ?? null;
  const hErr = h?.__error ?? null;
  const bErr = b?.__error ?? null;
  const agents = Array.isArray(h?.agents) ? h.agents : [];
  const balances = new Map((b?.balances ?? []).map((x) => [x.email, x]));
  const rows = agents.map((a) => {
    const stateCls = a.state === "serving" || a.state === "resident" ? "ok" : a.state === "paused" ? "warn" : "";
    return `<tr><td class="mono">${esc(a.key ?? "?")}</td><td><span class="pill ${stateCls}">${esc(a.state ?? "?")}</span></td><td>v${esc(String(a.version ?? "?"))}</td><td class="mono">${esc(a.port ?? "")}</td></tr>`;
  });
  const keyRows = (b?.keys ?? []).map((k) => {
    const bal = balances.get(k.deployer);
    const low = bal?.balance != null && bal.balance <= 1;
    return `<tr><td class="mono">${esc(k.agentId)}</td><td class="mono">${esc(String(k.keyRef).slice(0, 12))}</td><td>${esc(k.deployer)}</td><td class="${low ? "warn" : ""}">${bal?.balance == null ? "n/a" : "$" + Number(bal.balance).toFixed(2)}</td></tr>`;
  });
  const poolLine = b?.degraded === false ? "billing linked" : bErr ? "billing read failed" : "billing degraded";
  return `<section class="fleet" aria-label="agent fleet">
  <h2>agent fleet</h2>
  <p class="dim">states: serving turn in flight · resident warm &amp; idle · starting booting · draining stopping · paused held · warm no live process (never touched or budget-demoted; re-warms on demand)</p>
  <div class="fleetgrid">
    <div>
      <h3>runner: ${hErr ? `<span class="warn">health failed (${esc(hErr)})</span>` : `${agents.length} agent(s) · budget ${Math.round(h?.budget ?? 0)}/${h?.budgetMb ?? "?"}MB`}</h3>
      ${rows.length ? `<table><thead><tr><th>agent</th><th>state</th><th>v</th><th>port</th></tr></thead><tbody>${rows.join("")}</tbody></table>` : `<p class="dim">no deployed agents</p>`}
    </div>
    <div>
      <h3>billing: <span class="${bErr || b?.degraded ? "warn" : "ok"}">${esc(poolLine)}</span></h3>
      ${keyRows.length ? `<table><thead><tr><th>agent</th><th>key</th><th>deployer</th><th>balance</th></tr></thead><tbody>${keyRows.join("")}</tbody></table>` : `<p class="dim">no metered keys${bErr ? ` — ${esc(bErr)}` : ""}</p>`}
      <p class="dim">upstream isolation: see runbook (pool group 7)</p>
    </div>
  </div>
</section>`;
}
// ── server (token OR session cookie; read-only surface) ─────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200, { "content-type": "application/json" }); return res.end('{"ok":true}'); }

  const authed = (req.headers.authorization === `Bearer ${TOKEN}`)
    ? { via: "token" }
    : (() => { const s = cookieRead(req.headers.cookie, SESSION_COOKIE); return s ? { via: "browser", email: s.email } : null; })();

  // Browser login (D8). /auth/login is reachable unauthenticated on purpose;
  // admission happens at callback against the allowlist (fail closed).
  if (req.method === "GET" && req.url === "/auth/login") {
    if (!OIDC_ENABLED) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("login not configured (token-only mode)"); }
    if (!oidc) { res.writeHead(503, { "content-type": "text/plain" }); return res.end("login initializing, retry"); }
    const state = randomBytes(18).toString("base64url");
    res.setHeader("Set-Cookie", cookieSet(STATE_COOKIE, { state, exp: Math.floor((Date.now() + 600_000) / 1000) }, 600_000));
    const u = new URL(oidc.auth);
    u.searchParams.set("client_id", LOGTO_APP_ID);
    u.searchParams.set("redirect_uri", `${OPS_PUBLIC_URL}/auth/callback`);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid profile email urn:logto:scope:organizations");
    u.searchParams.set("state", state);
    return res.writeHead(302, { location: u.toString() }).end();
  }
  if (req.method === "GET" && req.url.startsWith("/auth/callback")) {
    if (!OIDC_ENABLED || !oidc) { res.writeHead(503); return res.end("login not configured"); }
    const q = new URL(req.url, "http://x").searchParams;
    const st = cookieRead(req.headers.cookie, STATE_COOKIE);
    res.setHeader("Set-Cookie", cookieClear(STATE_COOKIE));
    if (!st || st.state !== q.get("state")) { res.writeHead(401, { "content-type": "text/plain" }); return res.end("bad state"); }
    (async () => {
      const tokenRes = await postForm(oidc.token, {
        grant_type: "authorization_code",
        code: q.get("code"),
        redirect_uri: `${OPS_PUBLIC_URL}/auth/callback`,
        client_id: LOGTO_APP_ID,
        client_secret: LOGTO_APP_SECRET,
      });
      if (tokenRes.status !== 200 || !tokenRes.json.access_token) throw new Error(`token exchange HTTP ${tokenRes.status}`);
      // The userinfo call over TLS to the provider IS the identity verification
      // (single-file console: no local JWKS/RSA verification — design D8).
      const me = await getJson(oidc.userinfo, { headers: { authorization: `Bearer ${tokenRes.json.access_token}` } });
      const email = String(me.email || "").toLowerCase();
      // Organization-membership gate, fail closed. The `organizations` claim
      // (org IDs) rides the ID token when the authorize request carries
      // urn:logto:scope:organizations. Decode the id_token payload — signature
      // verification is unnecessary: it arrived directly from the provider's
      // token endpoint over TLS behind our client-secret exchange (D8 trust).
      const idClaims = (() => {
        try { return JSON.parse(Buffer.from(String(tokenRes.json.id_token || "").split(".")[1] || "", "base64url").toString()); }
        catch { return {}; }
      })();
      const orgs = Array.isArray(idClaims.organizations) ? idClaims.organizations.map(String) : [];
      if (!REQUIRED_ORG || !orgs.includes(REQUIRED_ORG)) {
        console.error(`[ops-console] login refused for ${email || "(no email)"} — org membership missing (required org: ${REQUIRED_ORG || "(unset)"}, has: [${orgs.join(", ")}])`);
        res.writeHead(403, { "content-type": "text/plain" });
        return res.end("not authorized for this board");
      }
      // idt (the id_token) rides the session so logout can send id_token_hint —
      // providers only honor post_logout_redirect_uri when the hint is present.
      res.setHeader("Set-Cookie", cookieSet(SESSION_COOKIE, { email, orgs, idt: tokenRes.json.id_token || "", exp: Math.floor((Date.now() + SESSION_TTL_MS) / 1000) }, SESSION_TTL_MS));
      res.writeHead(302, { location: "/" }).end();
    })().catch((e) => { console.error(`[ops-console] callback failed: ${e.message}`); res.writeHead(401); res.end("login failed"); });
    return;
  }
  if (req.url === "/auth/logout") {
    // Clear the local cookie, then end the PROVIDER session too — otherwise
    // the board's auto-redirect silently signs the user straight back in via
    // the still-live Logto SSO session and "logout" appears to do nothing.
    res.setHeader("Set-Cookie", cookieClear(SESSION_COOKIE));
    if (OIDC_ENABLED && oidc?.endSession) {
      const sess = cookieRead(req.headers.cookie, SESSION_COOKIE);
      const u = new URL(oidc.endSession);
      if (sess?.idt) u.searchParams.set("id_token_hint", sess.idt);
      u.searchParams.set("post_logout_redirect_uri", `${OPS_PUBLIC_URL}/`);
      return res.writeHead(302, { location: u.toString() }).end();
    }
    res.writeHead(302, { location: "/" }).end();
    return;
  }

  if (!authed) {
    // Browsers get redirected to the login page; programmatic callers that
    // present (or omit) an Authorization header get the flat 401 they expect.
    if (req.method === "GET" && !req.headers.authorization && OIDC_ENABLED) {
      res.writeHead(302, { location: "/auth/login" });
      return res.end();
    }
    res.writeHead(401, { "content-type": "text/plain" });
    return res.end("unauthorized");
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(renderBoard());
  }
  if (req.method === "GET" && req.url === "/api/board.json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(boardModel()));
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
if (isMain) {
  server.listen(PORT, HOST, () => console.log(`[ops-console] listening on ${HOST}:${PORT} | ns=${NAMESPACE} deploys=[${WATCHED_DEPLOYS}] poll=${POLL_SECS}s`));
}
// ── internal pack usage (add-pack-usage-telemetry) ───────────────────────────
// Straight projection of the platform's pack-usage aggregate: the weekly-
// active-pack number up front, then one line per origin. Same degradation
// discipline as the fleet sections — unconfigured/failed render explicitly.
function renderPackUsage() {
  const snap = storeLatest("packUsage");
  const d = snap?.data ?? null;
  const err = d?.__error ?? null;
  const age = snap ? ago(snap.ts) : null;
  if (!PACK_USAGE_URL) {
    return `<section class="fleet" aria-label="pack usage">
  <h2>internal pack usage</h2>
  <p class="dim">not configured — set PACK_USAGE_URL/PACK_USAGE_TOKEN (platform /api/ops/pack-usage)</p>
</section>`;
  }
  if (!d || err) {
    return `<section class="fleet" aria-label="pack usage">
  <h2>internal pack usage</h2>
  <p class="dim">${err ? `read failed: ${esc(err)}` : "no data yet"}${age ? ` · ${esc(age)}` : ""}</p>
</section>`;
  }
  const rows = (d.rows || []).map((r) => {
    const label = r.packId ? esc(r.packId) : "<i>非 pack（本地/自建）</i>";
    return `<div class="dim" style="display:flex;gap:12px"><span style="min-width:240px;overflow:hidden;text-overflow:ellipsis">${label}</span><span>${r.turns} turns · ${r.activeUsers} users · ${ago(r.lastUsedAt)}</span></div>`;
  });
  return `<section class="fleet" aria-label="pack usage">
  <h2>internal pack usage</h2>
  <p><b>${d.weeklyActivePacks ?? 0}</b> weekly-active packs (7d)${age ? ` · ${esc(age)}` : ""}</p>
  ${rows.length ? rows.join("\n  ") : '<p class="dim">window empty — no turns recorded yet</p>'}
</section>`;
}

export { computeDrift, argocdStatusFor, overallStatus, storeWrite, storeLatest, storeLastOk, renderFleetOverview, renderFleet, renderPackUsage };
