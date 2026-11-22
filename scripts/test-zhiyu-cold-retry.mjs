// Cold-start turn retry (2026-11-22): a callAgent failure that is retryable
// (ECONNREFUSED/5xx, i.e. the cell is still booting) must be retried a few times
// — otherwise the room appends agent_failed and the ingested IM message goes
// unanswered (fd-bot already got 200 and never re-sends).
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerZhiyuRoutes } from "../gateway/zhiyu/index.js";

// The room router reads these from process.env at turn time (createRoomRouter is
// not given the registerZhiyuRoutes env), so set them process-wide before boot.
process.env.ZHIYU_TURN_COLD_BACKOFF_MS = "10";
process.env.ZHIYU_TURN_COLD_RETRIES = "4";

async function boot(callAgent) {
  const app = express();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zhiyu-cold-"));
  const zhiyu = registerZhiyuRoutes(app, {
    dataRoot: tmp,
    env: { ...process.env, ZHIYU_ROOM_COMMANDER: "" },
    resolveUser: (req) => (req.headers["x-user"] ? { email: req.headers["x-user"], groups: [] } : null),
    rejectUnauthenticated: (_q, res) => res.status(401).json({ error: "auth" }),
    callAgent,
  });
  const srv = app.listen(0);
  await new Promise((r) => srv.once("listening", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const j = async (m, p, b, user = "a@x") => {
    const r = await fetch(base + p, { method: m, headers: { "x-user": user, "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
    return r.json();
  };
  const room = await j("POST", "/api/zhiyu/rooms", { title: "t" });
  const roomId = room.room?.id ?? room.id;
  zhiyu.store.memberAdd({ roomId, kind: "agent", ref: "advisor", display: "advisor" });
  return { zhiyu, roomId, j, close: () => srv.close() };
}

test("a retryable cold-start failure is retried and the turn still answers", async () => {
  let n = 0;
  const { zhiyu, roomId, j, close } = await boot(async () => {
    n += 1;
    if (n <= 2) { const e = new Error("connect ECONNREFUSED 127.0.0.1:3001"); throw e; }
    return { text: "冷启动后仍答上了" };
  });
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "本周进展" });
  await new Promise((r) => setTimeout(r, 500));
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  const answered = rows.find((r) => r.kind === "agent" && /冷启动后仍答上了/.test(r.content));
  const failed = rows.find((r) => r.meta?.event === "agent_failed");
  assert.ok(answered, "the turn answered after retries");
  assert.equal(failed, undefined, "no agent_failed row when the retry succeeded");
  assert.ok(n >= 3, `callAgent was retried (called ${n} times)`);
  close();
});

test("a non-retryable failure is NOT retried (one call, agent_failed)", async () => {
  let n = 0;
  const { zhiyu, roomId, j, close } = await boot(async () => {
    n += 1;
    throw new Error("invalid api key"); // not in the retryable set
  });
  await j("POST", `/api/zhiyu/rooms/${roomId}/messages`, { content: "本周进展" });
  await new Promise((r) => setTimeout(r, 300));
  const rows = zhiyu.store.messagesAfter(roomId, 0, {});
  assert.ok(rows.find((r) => r.meta?.event === "agent_failed"), "agent_failed recorded");
  assert.equal(n, 1, "non-retryable → exactly one call");
  close();
});
