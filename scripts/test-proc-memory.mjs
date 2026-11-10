#!/usr/bin/env node
// ── lib/proc-memory unit tests (harden-platform-memory-carrier 1.1) ─────────
//
// Runs against a fake /proc fixture (statm + cmdline + cwd symlinks) and a
// fake cgroup root, so the grouping rules, the v1 fallback, the TTL cache and
// the admission verdicts are pinned without a Linux host:
//
//   node --test scripts/test-proc-memory.mjs

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createProcMemorySampler,
  evaluateAdmission,
  groupScan,
  scanProcesses,
} from "../lib/proc-memory.js";

const PAGE = 4096;

// Fixture: cellsRoot with two cells; a fake /proc with one process per role.
function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "proc-memory-"));
  const cellsRoot = path.join(root, "cells");
  const procRoot = path.join(root, "proc");
  const cgroupRoot = path.join(root, "cgroup");
  mkdirSync(cellsRoot, { recursive: true });
  mkdirSync(procRoot, { recursive: true });
  mkdirSync(cgroupRoot, { recursive: true });

  let nextPid = 100;
  // rssPages: statm field[1]. args: argv array (NUL-joined by the writer).
  function addProc({ rssPages = 1000, args, cwd = null, ppid = 1 }) {
    const pid = nextPid++;
    const dir = path.join(procRoot, String(pid));
    mkdirSync(dir);
    writeFileSync(path.join(dir, "statm"), `1 ${rssPages} 1 1 0 0 0\n`);
    writeFileSync(path.join(dir, "cmdline"), args.join("\0") + "\0");
    // /proc/<pid>/stat: pid (comm) state ppid ... — the writer fakes a comm so
    // the parser's after-last-')' split has realistic shape.
    writeFileSync(path.join(dir, "stat"), `${pid} (node) S ${ppid} 1 1 0 0 0\n`);
    if (cwd) symlinkSync(cwd, path.join(dir, "cwd"));
    return pid;
  }

  return { root, cellsRoot, procRoot, cgroupRoot, addProc };
}

function addStandardFleet(f) {
  const cellA = path.join(f.cellsRoot, "aaaaaaaaaaaaaaaa");
  const cellB = path.join(f.cellsRoot, "bbbbbbbbbbbbbbbb");
  mkdirSync(path.join(cellA, "runtime"), { recursive: true });
  mkdirSync(path.join(cellB, "workspace"), { recursive: true });
  // cell A server: cell path only in cwd (cmdline is bare server.js)
  f.addProc({
    rssPages: 55000,
    args: ["node", "/app/server.js"],
    cwd: path.join(cellA, "runtime"),
  });
  // cell A dsh runtime: cell path in cmdline patch args
  f.addProc({
    rssPages: 33000,
    args: ["node", "/opt/dsh/cli.js", "--profile", "p", "--mcp-patch", path.join(cellA, "dsh", "mcp.patch.yml")],
    cwd: path.join(cellA, "workspace"),
  });
  // cell B MCP satellite: inherited cwd under the cell root, relative script arg
  f.addProc({
    rssPages: 17000,
    args: ["node", "server/delegation-mcp.js"],
    cwd: path.join(cellB, "workspace"),
  });
  // gateway itself
  f.addProc({
    rssPages: 25000,
    args: ["node", "/app/gateway/index.js"],
    cwd: path.join(f.root, "gateway"),
  });
  // ungrouped: no cell clue, not the gateway
  f.addProc({
    rssPages: 5000,
    args: ["node", "/app/one-off-job.js"],
    cwd: path.join(f.root, "tmp"),
  });
}

function writeCgroupV2(f, { used, limit }) {
  writeFileSync(path.join(f.cgroupRoot, "memory.current"), `${used}\n`);
  writeFileSync(path.join(f.cgroupRoot, "memory.max"), `${limit}\n`);
}

test("three role buckets each attribute one process to its owning cell", () => {
  const f = makeFixture();
  try {
    addStandardFleet(f);
    const snap = groupScan(scanProcesses({ procRoot: f.procRoot, cellsRoot: f.cellsRoot }));
    assert.ok(snap.available);
    assert.equal(snap.cells.length, 2, "two cells seen");

    const a = snap.cells.find((c) => c.cellId === "aaaaaaaaaaaaaaaa");
    assert.ok(a, "cell A grouped");
    assert.deepEqual(
      a.processes.map((p) => p.role).sort(),
      ["cell-server", "dsh-runtime"],
      "cell A carries its server (cwd attribution) and dsh runtime (cmdline attribution)",
    );
    // RSS order: server (55000*PAGE) sorts above dsh (33000*PAGE)
    assert.equal(a.processes[0].role, "cell-server");
    assert.equal(a.processes[0].rssBytes, 55000 * PAGE);

    const b = snap.cells.find((c) => c.cellId === "bbbbbbbbbbbbbbbb");
    assert.deepEqual(b.processes.map((p) => p.role), ["mcp-satellite"], "cell B satellite grouped to its host cell");
    assert.equal(b.totalBytes, 17000 * PAGE);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("each cell row carries its satellite count and bytes (share-mcp-satellites 4.1)", () => {
  const f = makeFixture();
  try {
    const cellA = path.join(f.cellsRoot, "aaaaaaaaaaaaaaaa");
    const cellB = path.join(f.cellsRoot, "bbbbbbbbbbbbbbbb");
    mkdirSync(path.join(cellA, "workspace"), { recursive: true });
    mkdirSync(path.join(cellB, "workspace"), { recursive: true });
    // Cell A: server + dsh + three satellites hanging off the dsh (what one
    // dsh generation really looks like).
    f.addProc({ rssPages: 1000, args: ["node", "/app/server.js"], cwd: path.join(cellA, "runtime") });
    const dshA = f.addProc({
      rssPages: 2000,
      args: ["node", "/opt/dsh/cli.js", "--mcp-patch", path.join(cellA, "dsh", "mcp.patch.yml")],
      cwd: path.join(cellA, "workspace"),
    });
    for (const script of ["fleet-mcp.js", "cron-mcp.js", "delegation-mcp.js"]) {
      f.addProc({ rssPages: 100, args: ["node", `server/${script}`], cwd: path.join(cellA, "workspace"), ppid: dshA });
    }
    // Cell B: a bare cell with no satellites — the summary must say 0, not
    // omit the field (a shape that changes with traffic is unreadable).
    f.addProc({ rssPages: 500, args: ["node", "/app/server.js"], cwd: path.join(cellB, "runtime") });

    const snap = groupScan(scanProcesses({ procRoot: f.procRoot, cellsRoot: f.cellsRoot }));
    const a = snap.cells.find((c) => c.cellId === "aaaaaaaaaaaaaaaa");
    const b = snap.cells.find((c) => c.cellId === "bbbbbbbbbbbbbbbb");
    assert.deepEqual(a.satellites, { count: 3, totalBytes: 300 * PAGE }, "satellite count and bytes on the cell row");
    assert.equal(a.totalBytes, (1000 + 2000 + 300) * PAGE, "the cell total still covers every process");
    assert.deepEqual(b.satellites, { count: 0, totalBytes: 0 }, "a cell with no satellites reports zero");
    // order inside the row is unaffected (RSS desc), so existing readers keep working
    assert.equal(a.processes[0].role, "dsh-runtime");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("ungrouped remainder stays visible, gateway bucket separate", () => {
  const f = makeFixture();
  try {
    addStandardFleet(f);
    const snap = groupScan(scanProcesses({ procRoot: f.procRoot, cellsRoot: f.cellsRoot }));
    assert.equal(snap.gateway.processes.length, 1);
    assert.equal(snap.gateway.processes[0].role, "gateway");
    assert.equal(snap.ungrouped.processes.length, 1, "clueless process surfaces as ungrouped");
    assert.equal(snap.ungrouped.processes[0].name, "one-off-job.js");
    assert.deepEqual(snap.buckets, {
      "cell-server": 1,
      "dsh-runtime": 1,
      "mcp-satellite": 1,
      // The shared browser lane's own bucket (slim-browser-lane-footprint):
      // empty here, and it must still be REPORTED — a bucket that disappears
      // when empty would make the face's shape depend on traffic.
      "browser-lane": 0,
      gateway: 1,
      ungrouped: 1,
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("gateway relative cmdline arg is attributed (2026-11-02 live gap)", () => {
  const f = makeFixture();
  try {
    // Production shape: `node gateway/index.js` — a relative arg that neither
    // starts the joined cmdline nor follows a slash in it.
    f.addProc({ rssPages: 25000, args: ["node", "gateway/index.js"], cwd: "/app" });
    const snap = groupScan(scanProcesses({ procRoot: f.procRoot, cellsRoot: f.cellsRoot }));
    assert.equal(snap.gateway.processes.length, 1, "gateway bucket catches its own process");
    assert.equal(snap.ungrouped.processes.length, 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("one-step ppid inheritance: dsh stdio MCP satellites land in their host cell", () => {
  const f = makeFixture();
  try {
    const cellA = path.join(f.cellsRoot, "aaaaaaaaaaaaaaaa");
    mkdirSync(path.join(cellA, "runtime"), { recursive: true });
    // The gateway first — children must point at its real fixture pid.
    const gwPid = f.addProc({ rssPages: 25000, args: ["node", "gateway/index.js"], cwd: "/app", ppid: 0 });
    // The dsh runtime: attributed via cmdline patch args.
    const dshPid = f.addProc({
      rssPages: 33000,
      args: ["node", "/opt/dsh/bin.js", "--mcp-patch", path.join(cellA, "dsh", "mcp.patch.yml")],
      cwd: "/app",
      ppid: gwPid,
    });
    // Its stdio MCP satellite: cwd=/app, no cell clue anywhere — attribution
    // rides the single ppid hop to the attributed dsh process.
    f.addProc({ rssPages: 7000, args: ["node", "server/delegation-mcp.js"], cwd: "/app", ppid: dshPid });
    // The gateway's transient child inherits the gateway bucket.
    f.addProc({ rssPages: 8, args: ["curl", "http://127.0.0.1:3100/api/ready"], cwd: "/app", ppid: gwPid });
    // A clueless orphan (parent gone/never attributed) stays ungrouped.
    f.addProc({ rssPages: 500, args: ["node", "/app/loose.js"], cwd: "/app", ppid: 999999 });

    const snap = groupScan(scanProcesses({ procRoot: f.procRoot, cellsRoot: f.cellsRoot }));
    const a = snap.cells.find((c) => c.cellId === "aaaaaaaaaaaaaaaa");
    assert.ok(a, "dsh runtime grouped to its cell");
    assert.deepEqual(a.processes.map((p) => p.role).sort(), ["dsh-runtime", "mcp-satellite"], "satellite rides one hop into the cell");
    assert.equal(a.totalBytes, (33000 + 7000) * PAGE, "satellite RSS counts into the cell total");
    assert.equal(snap.gateway.processes.length, 2, "gateway itself + its transient child in the gateway bucket");
    assert.equal(snap.ungrouped.processes.length, 1, "orphan without an attributed parent stays honestly ungrouped");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cache window serves one scan for repeated reads", () => {
  const f = makeFixture();
  try {
    addStandardFleet(f);
    let t = 1000;
    const sampler = createProcMemorySampler({
      ttlMs: 5000,
      procRoot: f.procRoot,
      cellsRoot: f.cellsRoot,
      now: () => t,
    });
    const first = sampler.sample();
    assert.equal(first.cells.length, 2);
    // A new process appears mid-window — the cached view must not see it.
    f.addProc({ rssPages: 999, args: ["node", "/app/late.js"], cwd: f.root });
    const second = sampler.sample();
    assert.equal(second, first, "same object returned from cache");
    assert.equal(second.cells.length, 2, "no re-scan inside the TTL window");
    // Past the window the scan re-runs and sees the newcomer (ungrouped).
    t += 5001;
    const third = sampler.sample();
    assert.equal(third.ungrouped.processes.length, 2, "fresh scan past the TTL");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("non-Linux / missing /proc degrades to available:false", () => {
  const f = makeFixture();
  try {
    const snap = scanProcesses({ procRoot: path.join(f.root, "no-such-proc"), cellsRoot: f.cellsRoot });
    assert.equal(snap.available, false);
    assert.match(snap.reason, /proc_unavailable/);
    const grouped = groupScan(snap);
    assert.equal(grouped.available, false, "grouping preserves the unavailable marker");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("cgroup v2 primary read and v1 fallback both work; no limit fails soft", () => {
  const f = makeFixture();
  try {
    // v2 files present → used directly.
    writeCgroupV2(f, { used: 1_000_000, limit: 4_000_000 });
    let c = createProcMemorySampler({ procRoot: f.procRoot, cellsRoot: f.cellsRoot, cgroupRoot: f.cgroupRoot }).sample();
    assert.equal(c.container.available, true);
    assert.equal(c.container.usedBytes, 1_000_000);
    assert.equal(c.container.limitBytes, 4_000_000);

    // v1 layout: v2 files gone, memory/ dir present.
    rmSync(path.join(f.cgroupRoot, "memory.current"));
    rmSync(path.join(f.cgroupRoot, "memory.max"));
    mkdirSync(path.join(f.cgroupRoot, "memory"), { recursive: true });
    writeFileSync(path.join(f.cgroupRoot, "memory", "memory.usage_in_bytes"), "700000\n");
    writeFileSync(path.join(f.cgroupRoot, "memory", "memory.limit_in_bytes"), "-1\n");
    c = createProcMemorySampler({ procRoot: f.procRoot, cellsRoot: f.cellsRoot, cgroupRoot: f.cgroupRoot }).sample();
    assert.equal(c.container.usedBytes, 700_000, "v1 fallback reads usage");
    assert.equal(c.container.limitBytes, null, "v1 -1 means no limit");
    assert.equal(c.container.available, true);

    // Neither layout → honest unavailable, not a throw.
    rmSync(path.join(f.cgroupRoot, "memory"), { recursive: true, force: true });
    c = createProcMemorySampler({ procRoot: f.procRoot, cellsRoot: f.cellsRoot, cgroupRoot: f.cgroupRoot }).sample();
    assert.equal(c.container.available, false);
    assert.match(c.container.reason, /cgroup_unavailable/);

    // cgroup v2 "max" string = no limit.
    writeCgroupV2(f, { used: 123, limit: "max" });
    c = createProcMemorySampler({ procRoot: f.procRoot, cellsRoot: f.cellsRoot, cgroupRoot: f.cgroupRoot }).sample();
    assert.equal(c.container.usedBytes, 123);
    assert.equal(c.container.limitBytes, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("admission verdicts: allow / refuse with four-tuple / fail-open / disabled", () => {
  const threshold = 0.15;
  // Headroom above threshold → allow.
  assert.equal(evaluateAdmission({ container: { available: true, usedBytes: 100, limitBytes: 1000 }, threshold }).decision, "allow");
  // Headroom below threshold → refuse, carrying usage/limit/headroom/threshold.
  const refused = evaluateAdmission({ container: { available: true, usedBytes: 900, limitBytes: 1000 }, threshold });
  assert.equal(refused.decision, "refuse");
  assert.equal(refused.usedBytes, 900);
  assert.equal(refused.limitBytes, 1000);
  assert.equal(refused.headroomPct, 0.1);
  assert.equal(refused.threshold, 0.15);
  // Metrics missing → fail-open (never blocks business).
  const open = evaluateAdmission({ container: { available: false, reason: "cgroup_unavailable: ENOENT" }, threshold });
  assert.equal(open.decision, "fail_open");
  assert.match(open.reason, /cgroup_unavailable/);
  // Malformed values → fail-open.
  assert.equal(
    evaluateAdmission({ container: { available: true, usedBytes: NaN, limitBytes: 1000 }, threshold }).decision,
    "fail_open",
  );
  // Threshold 0 → gate disabled, always allow.
  assert.equal(
    evaluateAdmission({ container: { available: true, usedBytes: 999, limitBytes: 1000 }, threshold: 0 }).decision,
    "allow",
  );
});

test("sampler.admission threads the container read into the verdict", () => {
  const f = makeFixture();
  try {
    writeCgroupV2(f, { used: 950_000, limit: 1_000_000 });
    const sampler = createProcMemorySampler({
      procRoot: f.procRoot,
      cellsRoot: f.cellsRoot,
      cgroupRoot: f.cgroupRoot,
      now: () => 1000,
    });
    const v = sampler.admission(0.15);
    assert.equal(v.decision, "refuse");
    assert.equal(v.headroomPct, 0.05);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("admission inflightBytes: reservations count into the verdict, zero stays byte-identical (add-wake-budget-admission 1.1)", () => {
  const threshold = 0.15;
  const container = { available: true, usedBytes: 1_200_000_000, limitBytes: 2_048_000_000 };
  // No inflight, no projection → verdict identical to the pre-change call shape.
  const bare = evaluateAdmission({ container, threshold });
  const zero = evaluateAdmission({ container, threshold, inflightBytes: 0 });
  assert.deepEqual(zero, bare);
  // inflightBytes=0 → byte-identical verdict (legacy equivalence contract).
  assert.equal(zero.decision, "allow");
  // Other wakes' reservations push the projection over the floor → refuse,
  // carrying the projected total (current + inflight) as evidence.
  const reserved = evaluateAdmission({ container, threshold, inflightBytes: 650_000_000 });
  assert.equal(reserved.decision, "refuse");
  assert.equal(reserved.projectedBytes, 1_200_000_000 + 650_000_000);
  // Reservation + own footprint stack (concurrent big cells: the 11-04 shape).
  const both = evaluateAdmission({ container, threshold, projectedBytes: 650_000_000, inflightBytes: 650_000_000 });
  assert.equal(both.decision, "refuse");
  assert.equal(both.projectedBytes, 1_200_000_000 + 1_300_000_000);
  // Non-finite/garbage inflight is ignored, not fatal.
  assert.deepEqual(
    evaluateAdmission({ container, threshold, inflightBytes: NaN }),
    bare,
  );
  // fail-open path ignores reservations entirely (metrics unavailable wins).
  const open = evaluateAdmission({
    container: { available: false, reason: "cgroup_unavailable" },
    threshold,
    inflightBytes: 650_000_000,
  });
  assert.equal(open.decision, "fail_open");
});
