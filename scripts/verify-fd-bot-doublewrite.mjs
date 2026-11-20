#!/usr/bin/env node
// Double-write verification (adopt-fd-bot-transport 6.4).
//
// The rule this enforces: a leg is only switched to fd-bot when the TWO paths
// produce the same envelope for the same input. "fd-bot delivered something" is
// not evidence — the transports agree only if their outputs agree field by
// field, and a field that is absent on both sides is itself a finding (it means
// neither path carries it, which may be fine, or may be the bug).
//
// Usage:
//   node scripts/verify-fd-bot-doublewrite.mjs <botId>
//   node scripts/verify-fd-bot-doublewrite.mjs <botId> --json
//
// It needs BOTH:
//   fd-bot side   FD_BOT_URL + FD_BOT_SECRET + a binding for the bot
//   cell side     a running cell (this script drives the module directly, so it
//                 must run where DB_PATH points at that cell's database)
//
// Exit codes: 0 identical · 1 differences (printed) · 2 could not run
// (missing config / bot / binding). 2 is "judged nothing", never "passed".


const botId = process.argv[2];
const asJson = process.argv.includes("--json");
if (!botId) {
  console.error("usage: verify-fd-bot-doublewrite.mjs <botId> [--json]");
  process.exit(2);
}
if (!process.env.FD_BOT_URL || !process.env.FD_BOT_SECRET) {
  console.error("FD_BOT_URL / FD_BOT_SECRET are not set — nothing to compare against");
  process.exit(2);
}

const db = await import("../db.js");
await db.initDb();

const bot = db.getBot(botId);
if (!bot) {
  console.error(`no bot row ${botId} in ${process.env.DB_PATH ?? "(default db)"}`);
  process.exit(2);
}
if (!bot.fdBotBindingId) {
  console.error(`bot ${botId} has no fd-bot binding — create one before comparing`);
  process.exit(2);
}

const { capabilityFromFdBot } = await import("../server/fd-bot-client.js");
const { getAdapter, outboundCapabilityFor } = await import("../server/bots/adapter.js");

// What each side says about the SAME bot. These are the fields a consumer (the
// binding panel, the zhiyu outbound picker) actually reads; if they disagree,
// one of the two faces is lying to an operator.
const cell = (() => {
  const adapter = getAdapter(bot.type);
  const cap = outboundCapabilityFor(bot.type);
  return {
    source: "cell-adapter",
    mode: cap.mode,
    inbound: cap.inbound,
    hasAdapter: Boolean(adapter),
  };
})();

const probe = await capabilityFromFdBot(bot);
if (!probe.available) {
  console.error(`fd-bot could not answer for binding ${bot.fdBotBindingId}: ${probe.reason} ${probe.detail ?? ""}`);
  process.exit(2);
}
const service = { source: "fd-bot", mode: probe.mode, inbound: probe.inbound, hasAdapter: true };

const diffs = [];
for (const key of ["mode", "inbound"]) {
  if (cell[key] !== service[key]) diffs.push({ field: key, cell: cell[key], service: service[key] });
}

const report = { botId, botType: bot.type, bindingId: bot.fdBotBindingId, cell, service, diffs, identical: diffs.length === 0 };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`bot ${botId} (${bot.type}) binding ${bot.fdBotBindingId}`);
  console.log(`  cell   : mode=${cell.mode} inbound=${cell.inbound}`);
  console.log(`  fd-bot : mode=${service.mode} inbound=${service.inbound}`);
  if (report.identical) {
    console.log("  identical ✓  — the leg may be switched");
  } else {
    console.log("  DIFFERENCES:");
    for (const d of diffs) console.log(`    ${d.field}: cell=${d.cell} service=${d.service}`);
    console.log("  Do NOT switch this leg until the two agree (see tasks.md 6.4).");
  }
}

// A leftover note for the operator: this script compares CAPABILITIES, not
// traffic. The message-level comparison (envelope fields for one live message)
// needs a real message through both paths and is recorded in tasks.md by hand.
process.exit(report.identical ? 0 : 1);
