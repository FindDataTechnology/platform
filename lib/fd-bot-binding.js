// Create / re-create the fd-bot binding that backs a bot row
// (adopt-fd-bot-transport 6.1). Until this ran, NOTHING ever called
// createBinding: a bot could be switched to `transport='fd-bot'` by hand and the
// row would carry a binding id fd-bot had never minted.
//
// The subscriber URL is deliberately ID-FREE (`<base>/api/bots/events`): the
// binding's URL is fixed at creation, and the binding id does not exist until
// fd-bot answers — pointing the URL at `/api/bots/events/:id` would be circular.
// Routing rides the envelope's own `bindingId` instead (gateway/index.js reads
// it from the body and resolves the owning cell).
//
// Failure is never fatal to the bot: no configuration, an unsupported platform,
// or an fd-bot refusal leaves the row on `legacy` (loudly logged) so the
// in-cell adapter keeps carrying messages.

import * as db from "../db.js";
import { adapterForBot, validateCredentials } from "../server/bots/adapter.js";
import { createBinding, fdBotConfigured } from "../server/fd-bot-client.js";

// One line per deployment, not per bot: an unset PUBLIC_BASE_URL is a
// deployment fact and repeating it on every save buries the real warnings.
let warnedNoBase = false;

/**
 * Ensure `bot` has a live fd-bot binding. Returns the updated row, or null when
 * nothing was moved (not configured / unsupported / refused). `force` re-binds
 * an already-bound row (credentials changed) — the old binding is left on
 * fd-bot's side; there is no delete verb in the client, and a stale binding
 * nobody addresses is inert.
 */
export async function ensureFdBotBinding({ bot, publicBaseUrl, env = process.env, fetchImpl = null, force = false }) {
  const legacy = (reason) => {
    console.warn(`[fd-bot-binding] "${bot.name}" stays on legacy: ${reason}`);
    return db.setBotTransport(bot.id, "legacy");
  };
  if (!fdBotConfigured()) return null;
  const adapter = adapterForBot(bot);
  if (!adapter) return null; // awaiting-connection (pack bot) — nothing to bind yet
  if (validateCredentials(bot.type, bot.credentials)) return null; // incomplete credentials
  if (!publicBaseUrl) {
    if (!warnedNoBase) {
      warnedNoBase = true;
      console.warn("[fd-bot-binding] PUBLIC_BASE_URL is unset — fd-bot bindings cannot be created on this deployment");
    }
    return null;
  }
  if (!force && bot.transport === "fd-bot" && bot.fdBotBindingId) return bot;

  try {
    const created = await createBinding({
      // A generic `channel` row names its platform in credentials; a plain row
      // names it in `type` (same rule as adapterForBot).
      platform: bot.credentials?.platform || bot.type,
      credentials: bot.credentials,
      subscriberUrl: `${publicBaseUrl.replace(/\/+$/, "")}/api/bots/events`,
      // The subscriber's own token, so rotating BOTS_EVENTS_TOKEN rotates both
      // sides at once. Unset → the cell route is inert (404) and delivery
      // cannot work, so refuse the switch rather than create a dead binding.
      deliveryToken: String(env.BOTS_EVENTS_TOKEN || "").trim() || null,
      label: bot.id,
      fetchImpl,
    });
    const id = String(created?.id ?? "");
    if (!id) return legacy("fd-bot returned no binding id");
    return db.setBotTransport(bot.id, "fd-bot", id);
  } catch (err) {
    return legacy(`fd-bot refused the binding: ${err.message}`);
  }
}
