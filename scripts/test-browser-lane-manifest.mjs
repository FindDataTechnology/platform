// ── Deployment unit tests (slim-browser-lane-footprint 3.1 / 3.2) ───────────
//
// 3.1: the platform pod must CARRY the shared browser service and the two envs
// that wire cells to it. This file renders the checked-in manifest and asserts
// the container + env contract, because a sidecar that is missing from the
// documented design is how a "shipped" change reaches production unshipped
// (the in-repo deployment manifest is the design of record; the live manifest
// is edited in the deployment repository).
//
// 3.2: the health/memory faces must report the lane. The probe is tested here
// against a fake fetch: reachable, unreachable, and unconfigured deployments.
//
// Run: node --test scripts/test-browser-lane-manifest.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { browserLaneHealthUrl, createBrowserLaneHealthProbe } from "../lib/browser-lane-health.js";
import { memoryFace } from "../gateway/memory-face.js";
import { groupScan } from "../lib/proc-memory.js";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFEST = join(REPO_ROOT, "k8s", "deployment.yaml");

// The open-source snapshot excludes deployment manifests, so the 3.1 contract
// can only be asserted where that file exists. Skipping is the honest answer:
// a manifest that is not in the tree has nothing to assert, and a green tick
// over an absent file would be worse than no test. 3.2 is pure and always runs.
const NO_MANIFEST = existsSync(MANIFEST)
  ? false
  : "deployment manifest not in this tree (manifests are internal)";

function manifest() {
  return yaml.load(readFileSync(MANIFEST, "utf8"));
}

function envOf(container) {
  return Object.fromEntries((container.env ?? []).map((e) => [e.name, e.value ?? e.valueFrom ?? null]));
}

// ── 3.1 ────────────────────────────────────────────────────────────────────
test("3.1 the pod carries the shared browser service as its own container", { skip: NO_MANIFEST }, () => {
  const containers = manifest().spec.template.spec.containers;
  const lane = containers.find((c) => c.name === "browser-lane");
  assert.ok(lane, "k8s/deployment.yaml must declare the browser-lane container");
  assert.deepEqual(lane.command, ["node", "server/browser-lane-service.js"]);
  const env = envOf(lane);
  assert.equal(env.BROWSER_SHARED_PORT, "9310");
  assert.equal(env.BROWSER_SHARED_HOST, "127.0.0.1", "the service must stay loopback-only");
  assert.equal(env.CELL_DATA_ROOT, "/data/cells", "cell attribution root must be the spawner's tree");
  assert.ok(env.BROWSER_MCP_CLI, "the pinned CLI path is a deployment fact");
  assert.ok(env.PLAYWRIGHT_BROWSERS_PATH, "the baked chromium dir must reach the service");
  // The container must mount the same data volume: identity + artifacts live
  // under the cell tree.
  assert.ok((lane.volumeMounts ?? []).some((m) => m.name === "data" && m.mountPath === "/data"));
  // The readiness probe must name loopback. The pod is hostNetwork and the
  // service binds 127.0.0.1 only, so kubelet's default (probe the pod IP = the
  // node IP) never connects: the pod parks at 1/2 ready and the Service loses
  // its endpoints. Found live on fd-prod 2026-11-08, not by this suite.
  assert.equal(
    lane.readinessProbe?.httpGet?.host,
    "127.0.0.1",
    "hostNetwork + loopback-only service: the probe must target 127.0.0.1 explicitly",
  );
});

test("3.1 the platform container receives the shared endpoint and artifact root", { skip: NO_MANIFEST }, () => {
  const containers = manifest().spec.template.spec.containers;
  const platform = containers.find((c) => c.name === "platform");
  const env = envOf(platform);
  assert.equal(env.BROWSER_SHARED_MCP_URL, "http://127.0.0.1:9310/mcp");
  assert.equal(env.BROWSER_SHARED_OUTPUT_ROOT, "/data/browser-lane");
  // The old per-cell shape must not ride along: no local runtime env in the
  // shared deployment (the shim stays available but unconfigured).
  assert.equal(env.BROWSER_RUNTIME_PATH, undefined);
});

test("3.1 the pod shares its PID namespace so the lane can attribute peers", { skip: NO_MANIFEST }, () => {
  const spec = manifest().spec.template.spec;
  assert.equal(
    spec.shareProcessNamespace,
    true,
    "without a shared PID namespace the lane sees no cell processes and artifacts land in an unowned dir",
  );
});

test("3.1 the manifest never asks for a shared browser context", { skip: NO_MANIFEST }, () => {
  const raw = readFileSync(MANIFEST, "utf8");
  // Comments may DISCUSS the flag (they explain why it is absent); only real
  // configuration counts.
  const configured = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.equal(
    /--shared-browser-context/.test(configured),
    false,
    "a pod-level process with a shared context would leak logins across cells",
  );
});

// ── 3.2 ────────────────────────────────────────────────────────────────────
test("3.2 the health probe derives /healthz from the MCP url", () => {
  assert.equal(browserLaneHealthUrl({ BROWSER_SHARED_MCP_URL: "http://127.0.0.1:9310/mcp" }), "http://127.0.0.1:9310/healthz");
  assert.equal(browserLaneHealthUrl({}), null);
  assert.equal(browserLaneHealthUrl({ BROWSER_SHARED_MCP_URL: "not a url" }), null);
});

test("3.2 an unconfigured deployment reports configured:false and stays out of the faces", async () => {
  const probe = createBrowserLaneHealthProbe({ env: {}, fetchImpl: async () => ({ ok: true, body: {} }) });
  assert.equal(probe.configured, false);
  const state = await probe.probe();
  assert.deepEqual(state, { configured: false, reachable: false });
});

test("3.2 a reachable service reads as up, an unreachable one as down", async () => {
  const up = createBrowserLaneHealthProbe({
    env: { BROWSER_SHARED_MCP_URL: "http://127.0.0.1:9310/mcp" },
    fetchImpl: async () => ({ ok: true, body: { ok: true, sessions: 2, upstream: { mode: "spawn" } } }),
  });
  const upState = await up.probe();
  assert.equal(upState.reachable, true);
  assert.equal(upState.sessions, 2);

  const down = createBrowserLaneHealthProbe({
    env: { BROWSER_SHARED_MCP_URL: "http://127.0.0.1:9310/mcp" },
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal((await down.probe()).reachable, false, "a dead lane is a state, not an exception");
});

test("3.2 the memory face carries a browser-lane footprint row", () => {
  const sample = groupScan({
    available: true,
    processes: [
      { pid: 10, name: "browser-lane-service.js", rssBytes: 90, role: "browser-lane", cellId: null, ppid: 1 },
      { pid: 11, name: "cli.js", rssBytes: 120, role: "browser-lane", cellId: null, ppid: 10 },
      { pid: 12, name: "server.js", rssBytes: 200, role: "cell-server", cellId: "aaaaaaaaaaaaaaaa", ppid: 1 },
    ],
  });
  sample.container = { available: true, usedBytes: 1000, limitBytes: 4000 };
  const face = memoryFace({ sample, isAdmin: true, browserLane: { configured: true, reachable: false } });
  assert.ok(face.browserLane, "the row must exist");
  assert.equal(face.browserLane.totalBytes, 210);
  assert.equal(face.browserLane.reachable, false, "the grey state rides the same row");
  assert.equal(face.cells.length, 1, "cell rows are unaffected by the new bucket");
  assert.equal(face.buckets["browser-lane"], 2);
});
