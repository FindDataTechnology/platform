// Platform-list drift guard (unify-im-solution 3.3).
//
// THE AUTHORITY IS fd-bot'S REGISTRY: the transport service owns which platforms
// exist, because the adapter+capability declaration lives next to the sending
// code there. paas's `BOT_TYPES` is a projection of that, and the ONLY thing that
// keeps it honest is a check that compares them. This test does that when fd-bot
// is reachable, and SKIPS (not fails) when it isn't — offline CI and the desktop
// build must not go red just because the service is absent.
//
// Why a check and not a runtime fetch: BOT_TYPES feeds several SYNCHRONOUS call
// sites (bot-create validation, the adapter registry, the /api/bots type list).
// Making them async + network-dependent would add a failure mode (fd-bot down =
// bot management down) for a list that changes once per new platform. A drift
// check catches the same bug (a platform added to one side, forgotten on the
// other) the day it happens, with none of that fragility. If a caller is ever
// added that must enumerate platforms live, use `capabilityFromFdBot` there —
// this test is the boundary guard, not the runtime source.

import test from "node:test";
import assert from "node:assert/strict";
import { BOT_TYPES } from "../server/bots/adapter.js";

const FD_BOT_URL = (process.env.FD_BOT_URL || "").replace(/\/+$/, "");

test("BOT_TYPES matches fd-bot's live platform registry (skips if unreachable)", async (t) => {
  if (!FD_BOT_URL) {
    t.skip("FD_BOT_URL unset — no live authority to compare against");
    return;
  }
  let live;
  try {
    const res = await fetch(`${FD_BOT_URL}/v1/platforms`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) {
      t.skip(`fd-bot answered ${res.status} — treating as unreachable`);
      return;
    }
    live = (await res.json()).map((p) => p.platform).sort();
  } catch (err) {
    t.skip(`fd-bot unreachable (${err.message}) — offline build`);
    return;
  }
  const paas = [...BOT_TYPES].sort();
  // Name the exact drift, not just "not equal": an operator reading CI needs to
  // see which platform is missing/extra to fix it, not a diff of arrays.
  const missing = live.filter((p) => !paas.includes(p));
  const extra = paas.filter((p) => !live.includes(p));
  assert.deepEqual(
    { missing, extra },
    { missing: [], extra: [] },
    `BOT_TYPES drifted from fd-bot: paas is missing [${missing}], has extra [${extra}]`,
  );
});
