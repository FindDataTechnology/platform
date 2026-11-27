#!/usr/bin/env node
// Move bot credentials from cell `bots` rows into fd-bot bindings
// (adopt-fd-bot-transport 6.3 migration path).
//
// DRY RUN BY DEFAULT. `--apply` is required to write anything, and it writes to
// fd-bot only — the cell rows are never modified here. Switching a row to the
// fd-bot transport stays a separate, explicit act (`db.setBotTransport`), because
// the whole point of the migration plan is "create + verify, then switch".
//
// What it cannot do: invent credentials. A platform whose adapter expects fields
// this script does not know how to send is refused with the missing keys named.
//
// Usage:
//   node scripts/migrate-bots-to-fd-bot.mjs                 # dry run, all bots
//   node scripts/migrate-bots-to-fd-bot.mjs --bot <id>      # one bot
//   node scripts/migrate-bots-to-fd-bot.mjs --apply         # create bindings
//
// Exit codes: 0 planned/applied · 1 some bot refused · 2 could not run.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const onlyBot = args.includes("--bot") ? args[args.indexOf("--bot") + 1] : null;

if (!process.env.FD_BOT_URL || !process.env.FD_BOT_SECRET) {
  console.error("FD_BOT_URL / FD_BOT_SECRET are not set — nothing to migrate into");
  process.exit(2);
}
// The subscriber URL is where fd-bot pushes envelopes. Without it the binding
// would be created and immediately undeliverable, which is worse than no binding.
if (!process.env.FD_BOT_SUBSCRIBER_URL) {
  console.error(
    "FD_BOT_SUBSCRIBER_URL is not set (e.g. http://platform:3100/api/bots/events).\n" +
      "A binding with no reachable subscriber accepts messages and delivers none.",
  );
  process.exit(2);
}

const db = await import("../db.js");
await db.initDb();
const { createBinding } = await import("../server/fd-bot-client.js");
const { getAdapter } = await import("../server/bots/adapter.js");

const rows = db.listBots().filter((b) => (onlyBot ? b.id === onlyBot : true));
if (!rows.length) {
  console.error(onlyBot ? `no bot row ${onlyBot}` : "this cell has no bot rows");
  process.exit(2);
}

const plan = [];
for (const bot of rows) {
  const adapter = getAdapter(bot.type);
  const problems = [];
  if (!adapter) problems.push(`no adapter for type "${bot.type}"`);
  if (bot.transport === "fd-bot" && bot.fdBotBindingId) {
    problems.push(`already on fd-bot (binding ${bot.fdBotBindingId})`);
  }
  // Refuse rather than send a partial credential set: fd-bot validates required
  // fields and would answer 400, but naming them here points at the right row.
  const missing = (adapter?.credentialFields ?? [])
    .filter((f) => f.required !== false && !String(bot.credentials?.[f.key] ?? "").trim())
    .map((f) => f.key);
  if (missing.length) problems.push(`credentials incomplete: ${missing.join(", ")}`);

  plan.push({
    botId: bot.id,
    name: bot.name,
    type: bot.type,
    platform: adapter?.platform ?? null,
    enabled: bot.enabled,
    problems,
  });
}

console.log(`fd-bot migration plan (${apply ? "APPLY" : "dry run"}) — ${plan.length} bot row(s)\n`);
let refused = 0;
for (const p of plan) {
  if (p.problems.length) {
    refused += 1;
    console.log(`  ✗ ${p.name} (${p.botId}) ${p.type}`);
    for (const why of p.problems) console.log(`      ${why}`);
    continue;
  }
  console.log(`  · ${p.name} (${p.botId}) ${p.type} → binding on fd-bot`);
  if (!apply) continue;
  try {
    const created = await createBinding({
      platform: p.platform,
      // Credentials travel once, over the bearer-authenticated management API.
      credentials: db.getBot(p.botId).credentials,
      subscriberUrl: process.env.FD_BOT_SUBSCRIBER_URL,
      // The subscriber's own token, so rotating it rotates both sides at once.
      deliveryToken: process.env.BOTS_EVENTS_TOKEN || null,
      label: p.name,
    });
    console.log(`      created ${created.id} (transport still 'legacy' — switch explicitly)`);
  } catch (err) {
    refused += 1;
    console.log(`      FAILED: ${err.message}`);
  }
}

console.log(
  `\n${apply ? "Applied" : "Planned"} ${plan.length - refused}/${plan.length}. ` +
    "Switching a row is a separate step (db.setBotTransport) after verify-fd-bot-doublewrite passes.",
);
process.exit(refused ? 1 : 0);
