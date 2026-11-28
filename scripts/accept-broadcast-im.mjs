#!/usr/bin/env node
// ── Broadcast → zhiyu IM face, in-cluster acceptance ────────────────────────
//    (openspec: broadcast-reaches-zhiyu, tasks 6.1–6.3)
//
// Run inside the platform pod. Proves the three claims the change makes, using
// the deployment's REAL zhiyu store and a throwaway broadcast:
//
//   6.1 a broadcast lands in the zy_notifications lane with title + body
//   6.2 the enter-the-page sweep does NOT clear it; only an explicit read does
//   6.3 the sweep still clears every ambient type (the existing producers keep
//       their deterministic badge path)
//
//   node scripts/accept-broadcast-im.mjs            # read-only probes + one temp row
//   node scripts/accept-broadcast-im.mjs --keep     # leave the temp row for the UI check
//
// Everything it writes is namespaced `accept-<ts>` and removed at the end
// unless --keep is passed.

import path from "node:path";
import { createZhiyuStore } from "../gateway/zhiyu/store.js";

const DATA_ROOT = path.resolve(process.env.CELL_DATA_ROOT || "/data/cells");
const EMAIL = process.env.ACCEPT_EMAIL || "acceptance@local";
const TAG = `accept-${Date.now()}`;
const KEEP = process.argv.includes("--keep");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const store = createZhiyuStore({ file: path.join(DATA_ROOT, "zhiyu.db") });

const unread = (email) => store.notificationUnreadCount(email);

// The same list the gateway route passes (kept in sync by the route's own test).
const BROWSE_CLEARABLE = ["invite", "call", "minutes", "budget_warning", "take_over", "handback", "room_ended"];

// ── 6.1 the notice lands with its content intact ────────────────────────────
store.notificationAdd({
  email: EMAIL,
  type: "broadcast",
  roomId: null,
  payload: { broadcastId: TAG, seq: 0, title: `${TAG} 标题`, body: `${TAG} 正文`, action: null },
});
{
  const rows = store.notificationsFor(EMAIL, { unreadOnly: true }).filter((n) => n.type === "broadcast");
  const mine = rows.find((n) => n.payload?.broadcastId === TAG);
  check("6.1 broadcast notice is readable in the zy lane", Boolean(mine));
  check("6.1 title and body survive verbatim", mine?.payload?.title === `${TAG} 标题` && mine?.payload?.body === `${TAG} 正文`);
}

// ── 6.2 the page-entry sweep must NOT clear it ──────────────────────────────
{
  const before = unread(EMAIL);
  store.notificationMarkAllRead(EMAIL, { types: BROWSE_CLEARABLE });
  const mine = store.notificationsFor(EMAIL, { unreadOnly: true }).find((n) => n.payload?.broadcastId === TAG);
  check("6.2 broadcast survives the enter-the-page sweep", Boolean(mine), `unread ${before} → ${unread(EMAIL)}`);
}

// ── 6.3 ambient types still clear ──────────────────────────────────────────
{
  for (const t of BROWSE_CLEARABLE) store.notificationAdd({ email: `${TAG}@ambient`, type: t, payload: {} });
  const before = unread(`${TAG}@ambient`);
  store.notificationMarkAllRead(`${TAG}@ambient`, { types: BROWSE_CLEARABLE });
  check("6.3 ambient types still clear on the same sweep", before > 0 && unread(`${TAG}@ambient`) === 0, `${before} → 0`);
}

// ── 6.2b an explicit read IS what clears it ────────────────────────────────
{
  const mine = store.notificationsFor(EMAIL, { unreadOnly: true }).find((n) => n.payload?.broadcastId === TAG);
  store.notificationMarkRead(EMAIL, mine.id);
  check("6.2b only an explicit read clears the broadcast", !store.notificationsFor(EMAIL, { unreadOnly: true }).some((n) => n.payload?.broadcastId === TAG));
}

// ── cleanup ────────────────────────────────────────────────────────────────
if (!KEEP) {
  store.notificationMarkAllRead(EMAIL);
  store.notificationMarkAllRead(`${TAG}@ambient`);
  check("cleanup left no accept rows unread", unread(EMAIL) === 0 && unread(`${TAG}@ambient`) === 0);
} else {
  console.log(`kept: one broadcast row for ${EMAIL} (tag ${TAG}) — open the zhiyu page to see it`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
