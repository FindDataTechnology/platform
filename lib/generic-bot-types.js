// Generic bot type registry (openspec: add-mixed-fleet-packs-and-market-consolidation,
// spec pack-bot-units, task 2.2).
//
// Packs may only REFERENCE a generic bot type by name — they never carry a bot
// implementation, channel parameters, or credentials (design D1). This file is
// the single source for that type set, consumed by the faces that must never
// disagree:
//   - the manifest validator (lib/pack-manifest.js — imported by BOTH the
//     gateway's publish prevalidation and the cell's install validation, so
//     "unknown generic type" is rejected identically on both sides),
//   - the read-only list endpoints (server/routes/bots.js — the install face
//     and the catalog face list the very same objects),
//   - the bot runtime (server/bots.js resolves a materialized row's platform
//     adapter; a row whose type names a generic type never runs an
//     implementation from the pack, only the platform's own adapters).
//
// CONSTRAINT: lib/pack-manifest.js is imported by the gateway process, so this
// module must stay a dependency-free constants file — no adapter imports, no
// runtime state, no side effects.

export const GENERIC_BOT_TYPES = [
  {
    // v1's only generic type (design D1): a plain channel — outbound message
    // delivery plus an inbound event source. With a mounted pack skill the
    // inbound turn is answered through that skill's session context first
    // (server/bots.js injects the mounted skill into the turn prompt); without
    // one it is a bare channel bot. Delivery/verification reuse the four
    // platform adapters via the operator's platform binding
    // (credentials.platform); the webhook trust boundary is untouched.
    type: "channel",
    name: "Channel",
    description:
      "通道收发：出站投递消息，入站作为事件源；挂载技能后，入站消息先经该技能的会话作答。" +
      " Outbound delivery + inbound event source; with a mounted skill, inbound messages are answered through that skill's session first.",
    supportsSkillMount: true,
  },
];

export const GENERIC_BOT_TYPE_NAMES = GENERIC_BOT_TYPES.map((t) => t.type);

export function isGenericBotType(name) {
  return GENERIC_BOT_TYPE_NAMES.includes(name);
}

// ── Pack-bot row metadata ────────────────────────────────────────────────────
//
// A pack-materialized bot is a row in the SAME bots table the operator's bots
// use, and that table has no pack columns — so the pack bookkeeping (owning
// pack id, mounted skill, generic type) rides INSIDE the row's credentials
// JSON under this reserved key. Platform adapters read only their own named
// credential keys, so a reserved underscore key never collides; the bots face
// masks it out of every browser-facing shape (server/bots.js maskBot).
// Shared by pack-store.js (writes/reads it) and server/bots.js (reads it).
export const PACK_BOT_CREDENTIAL_KEY = "_pack";

// The metadata object for a bot row's credentials, or null for a plain
// operator-created bot. Shape: { packId, skill (string|null), generic }.
export function packBotMeta(credentials) {
  const meta = credentials?.[PACK_BOT_CREDENTIAL_KEY];
  return meta && typeof meta === "object" ? meta : null;
}
