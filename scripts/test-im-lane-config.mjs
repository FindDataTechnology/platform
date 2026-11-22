// IM lane configuration (externalize-im-platform-adapters 1.x).
// Run: node --test scripts/test-im-lane-config.mjs
//
// The property under test is not "a JSON file is read" — it is that changing the
// data layer costs no image and no restart, and that a broken file can never take
// the channel down.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createLaneConfig, mergeLaneConfig, copyForEvent, renderCopy } from "../gateway/zhiyu/lane-config.js";

const DEFAULTS = {
  version: 1,
  echo: { events: ["all_passed", "commander_receipt"] },
  copy: {
    default: "（会话事件）",
    events: {
      all_passed: "本轮无人作答——A",
      pass: null,
      commander_receipt: { thinking: "已收到，正在确认…", dispatched: "已收到，正在处理{{seats}}…" },
    },
    seatsSeparator: "、",
    seatsWrapper: "（{{seats}}）",
  },
  dispatch: { wecom: { groupPattern: "^wr", groupApi: "appchat/send", memberApi: "message/send" } },
  timeouts: { commanderDecisionMs: 45000 },
};

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "im-lanes-"));
}

test("no overlay mounted = shipped defaults, no error", () => {
  const cfg = createLaneConfig({ dir: tmpdir(), defaults: DEFAULTS });
  assert.equal(cfg.source(), "default");
  assert.deepEqual(cfg.get().echo.events, DEFAULTS.echo.events);
});

test("an overlay changes one field without erasing the rest", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "im-lanes.json"), JSON.stringify({ copy: { events: { all_passed: "新文案" } } }));
  const cfg = createLaneConfig({ dir, defaults: DEFAULTS });
  const c = cfg.get();
  assert.equal(c.copy.events.all_passed, "新文案", "the overlaid sentence wins");
  assert.equal(c.copy.events.commander_receipt.thinking, "已收到，正在确认…", "siblings survive");
  assert.equal(c.echo.events.length, 2, "untouched sections survive");
  assert.equal(cfg.source(), "merged");
});

test("a changed file is picked up without a restart (mtime re-read)", async () => {
  const dir = tmpdir();
  const file = path.join(dir, "im-lanes.json");
  fs.writeFileSync(file, JSON.stringify({ copy: { events: { all_passed: "第一次" } } }));
  const cfg = createLaneConfig({ dir, defaults: DEFAULTS });
  assert.equal(cfg.get().copy.events.all_passed, "第一次");

  // Touch with a different mtime AND size: ConfigMap swaps change both, but the
  // size guard keeps a same-millisecond same-length edit from being missed.
  await new Promise((r) => setTimeout(r, 12));
  fs.writeFileSync(file, JSON.stringify({ copy: { events: { all_passed: "第二次（更长一点）" } } }));
  assert.equal(cfg.get().copy.events.all_passed, "第二次（更长一点）", "next turn sees the new value");
});

test("a broken file falls back to defaults and says so exactly once", () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "im-lanes.json"), "{not json");
  const warns = [];
  const cfg = createLaneConfig({ dir, defaults: DEFAULTS, onWarn: (m) => warns.push(m) });
  assert.equal(cfg.get().copy.events.all_passed, DEFAULTS.copy.events.all_passed, "channel keeps working");
  assert.equal(cfg.source(), "default");
  cfg.get();
  cfg.get();
  assert.equal(warns.filter((w) => w.includes("cannot parse")).length, 1, "one log, not a flood");
});

test("one wrong-typed field falls back alone; its siblings still apply", () => {
  const dir = tmpdir();
  fs.writeFileSync(
    path.join(dir, "im-lanes.json"),
    JSON.stringify({ echo: { events: "not-an-array" }, copy: { events: { all_passed: "生效了" } } }),
  );
  const warns = [];
  const c = createLaneConfig({ dir, defaults: DEFAULTS, onWarn: (m) => warns.push(m) }).get();
  assert.deepEqual(c.echo.events, DEFAULTS.echo.events, "bad shape → default");
  assert.equal(c.copy.events.all_passed, "生效了", "the valid field beside it applies");
  assert.ok(warns.some((w) => w.includes("echo.events")), "and the bad one is named");
});

test("copy: an unknown event gets the generic line, never its internal name", () => {
  const c = mergeLaneConfig(DEFAULTS, null);
  assert.equal(copyForEvent(c, "some_internal_event", {}), "（会话事件）");
  assert.ok(!copyForEvent(c, "some_internal_event", {}).includes("some_internal_event"));
});

test("copy: null means deliberate silence", () => {
  const c = mergeLaneConfig(DEFAULTS, null);
  assert.equal(copyForEvent(c, "pass", {}), "");
});

test("copy: phase-dependent templates render their variables", () => {
  const c = mergeLaneConfig(DEFAULTS, null);
  assert.equal(copyForEvent(c, "commander_receipt", { meta: { phase: "thinking" } }), "已收到，正在确认…");
  assert.equal(
    copyForEvent(c, "commander_receipt", { meta: { seats: ["产品顾问", "项目评估师"] } }),
    "已收到，正在处理（产品顾问、项目评估师）…",
  );
  // No seats known yet: the wrapper disappears rather than rendering empty brackets.
  assert.equal(copyForEvent(c, "commander_receipt", { meta: {} }), "已收到，正在处理…");
});

test("an unknown placeholder stays visible instead of vanishing", () => {
  assert.equal(renderCopy("x {{nope}} y", {}), "x {{nope}} y");
});

// ── The three consumers actually read the config ─────────────────────────────
// A config layer nobody reads is worse than none: it *looks* configurable while
// every change is a no-op.
// The module builds its config handle at import time (the overlay DIRECTORY is
// resolved then; the FILE is re-read per call). So the env var must be set before
// the import — that is the deployment's situation too, where IM_LANES_DIR comes
// from the pod spec.
const laneDir = tmpdir();
fs.writeFileSync(
  path.join(laneDir, "im-lanes.json"),
  JSON.stringify({ dispatch: { wecom: { groupPattern: "^NEVERMATCHES$", memberApi: "cgi-bin/message/send" } } }),
);
process.env.IM_LANES_DIR = laneDir;
const { registry: wecom } = await import("../server/bots/wecom.js");

test("the WeCom dispatch rule comes from config, not from a literal regex", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("gettoken")) return new Response(JSON.stringify({ errcode: 0, access_token: "T", expires_in: 7200 }), { status: 200 });
    calls.push({ path: u.split("/cgi-bin/")[1].split("?")[0], body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
  };
  try {
    // This chatKey would be a GROUP under the shipped default.
    await wecom.sendText({ corpId: "c", agentId: "1000002", corpSecret: "s" }, "wrqmGucgAAVV-jld74M1414TYymX8ZUw", "x");
    assert.equal(calls[0].path, "message/send", "the configured rule decided, not the literal");
    assert.ok(calls[0].body.touser, "and the configured recipient field was used");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("every echoed event has a copy sentence (no '（会话事件）' placeholder leaks)", () => {
  // Regression guard for the 2026-11-22 bug: echo.events listed
  // commander_degraded but copy.events had no entry, so copyForEvent fell back
  // to copy.default ("（会话事件）") and the GROUP received that literal string.
  // Every event the lane echoes MUST have a sentence (or be a deliberate null
  // silence); a missing entry is the placeholder leak, caught here not in prod.
  const here = path.dirname(new URL(import.meta.url).pathname);
  const shipped = JSON.parse(fs.readFileSync(path.join(here, "..", "gateway", "zhiyu", "im-lanes.json"), "utf8"));
  const echoed = shipped.echo?.events ?? [];
  const missing = echoed.filter((e) => !(e in (shipped.copy?.events ?? {})));
  assert.deepEqual(missing, [], `echoed events without copy (would render the default placeholder): ${missing.join(", ")}`);
});
