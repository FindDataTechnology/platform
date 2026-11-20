// Unit tests — zhiyu permanent rooms (fix-zhiyu-permanent-rooms).
// Run: node --test scripts/test-zhiyu-permanent-rooms.mjs
//
// A standing team room used to be impossible: `idleMinutes` was clamped to
// 1..1440, so every quiet day ended the room and the team lost its space. The
// contract under test:
//
//   1.x  0 means NEVER — the room is not in the idle sweep at all.
//   2.x  finite values above a day are accepted (up to one year).
//   3.x  invalid shapes are refused with the "0 = never" hint in the message,
//        so a caller can discover the sentinel instead of guessing.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-perm-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_req, res) => res.status(401).json({ error: "auth" }),
    env: {},
    callAgent: async () => ({ text: "ok" }),
    settleTurn: async () => {},
    ssePollMs: 60,
    startTimers: false,
  });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const cli = (email) => {
    const call = async (method, p, body) => {
      const r = await fetch(`${base}${p}`, {
        method,
        headers: { "x-user": email, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b ?? {}), patch: (p, b) => call("PATCH", p, b) };
  };
  return { cli, zhiyu, close: () => srv.close() };
}

test("1.1 idleMinutes 0 creates a room that never auto-closes", async () => {
  const { cli, zhiyu, close } = await boot();
  try {
    const a = cli("owner@example.com");
    const created = await a.post("/api/zhiyu/rooms", { title: "常驻团队", idleMinutes: 0 });
    assert.equal(created.status, 200);
    assert.equal(created.body.room.idleMinutes, 0);

    // A sweep far in the future still leaves it alone.
    const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    const expired = zhiyu.store.roomsIdleExpired(farFuture);
    assert.equal(expired.some((r) => r.id === created.body.room.id), false, "never-idle room must not expire");
  } finally {
    close();
  }
});

test("1.2 a finite room DOES expire — the sentinel is what changes behavior", async () => {
  const { cli, zhiyu, close } = await boot();
  try {
    const a = cli("owner2@example.com");
    const created = await a.post("/api/zhiyu/rooms", { title: "普通", idleMinutes: 15 });
    const farFuture = Date.now() + 60 * 60 * 1000;
    const expired = zhiyu.store.roomsIdleExpired(farFuture);
    assert.equal(expired.some((r) => r.id === created.body.room.id), true, "15min room expires after an hour of quiet");
  } finally {
    close();
  }
});

test("2.1 values above one day are accepted up to a year", async () => {
  const { cli, close } = await boot();
  try {
    const a = cli("owner3@example.com");
    const week = await a.post("/api/zhiyu/rooms", { title: "一周", idleMinutes: 10080 });
    assert.equal(week.status, 200);
    assert.equal(week.body.room.idleMinutes, 10080, "one week must survive the old 1440 wall");

    const year = await a.post("/api/zhiyu/rooms", { title: "一年", idleMinutes: 525600 });
    assert.equal(year.status, 200);
    assert.equal(year.body.room.idleMinutes, 525600);
  } finally {
    close();
  }
});

test("2.2 the cap still exists — beyond a year clamps, it does not error", async () => {
  const { cli, close } = await boot();
  try {
    const a = cli("owner4@example.com");
    const over = await a.post("/api/zhiyu/rooms", { title: "超一年", idleMinutes: 9999999 });
    assert.equal(over.status, 200);
    assert.equal(over.body.room.idleMinutes, 525600, "clamped to the year ceiling");
  } finally {
    close();
  }
});

test("3.1 PATCH accepts 0 and large values, refuses negatives with the sentinel hint", async () => {
  const { cli, close } = await boot();
  try {
    const a = cli("owner5@example.com");
    const created = await a.post("/api/zhiyu/rooms", { title: "改设置" });
    const id = created.body.room.id;

    const never = await a.patch(`/api/zhiyu/rooms/${id}`, { idleMinutes: 0 });
    assert.equal(never.status, 200);
    const read = await a.get(`/api/zhiyu/rooms/${id}`);
    assert.equal(read.body.room.idleMinutes, 0);

    const month = await a.patch(`/api/zhiyu/rooms/${id}`, { idleMinutes: 43200 });
    assert.equal(month.status, 200);

    const neg = await a.patch(`/api/zhiyu/rooms/${id}`, { idleMinutes: -5 });
    assert.equal(neg.status, 400);
    assert.match(String(neg.body.error), /never/i, "the refusal must name the 0 sentinel so a caller can find it");
  } finally {
    close();
  }
});
