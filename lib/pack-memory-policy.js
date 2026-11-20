// ── Pack memory policy: declaration → the pack root's policy doc ────────────
//
// Task 4.1 of add-pack-memory-declaration. This module is the COMPILE step only:
// it turns a pack declaration into the document the memory service's `/policy`
// face accepts, together with the root that document belongs to. It performs no
// I/O — the write itself (and the token that may perform it) belongs to the
// caller, because that is where authorization lives.
//
// Two facts this file exists to pin down, both measured rather than assumed:
//
//  · The root is `d-<packId>`, NOT `d-<fleetId>`. A member's namespace is
//    `d/<pack>/<agent>` (yongyi-client's memoryNamespaceFor), so a pack's root is
//    shared by every team landed from that pack — including teams of different
//    owners (the fleet dedupe key is pack + owner, so two owners really can share
//    one root). Writing a per-fleet policy would create two contradictory
//    documents under one root; keying by pack makes that unrepresentable.
//  · Only what the pack DECLARED goes into the document. Materializing the
//    platform defaults here would turn "the platform default is on" into "this
//    team declared on" — the read face would then show a declaration nobody
//    wrote, and a later default change would silently fail to reach the team.
//
// `store` / `read` / `write` are absent from the document on purpose: they are
// executed on the member's own path (injection + host reconciliation) and have no
// meaning in the root's process policy. They are still VALIDATED here — a typo in
// any axis is a typo — but they are not carried, and not refused either: refusing
// them would fail materialization for every pack that declares a read scope, i.e.
// most of them. The read face is where those axes are reported; this file only
// answers "what, if anything, does the pack root's policy document say".

import { MEMORY_AXIS_KEYS, validateMemoryBlock } from "./pack-memory.js";

/**
 * The process sub-keys a policy document can carry.
 *
 * Derived from the axis definition rather than retyped: a fourth copy of this
 * vocabulary is exactly the drift the parity gate exists to prevent, and that gate
 * already compares `memory.process`'s key set against the root module's.
 */
export const POLICY_KEYS = MEMORY_AXIS_KEYS.process;

/**
 * The root key for a pack's memory. One root per pack, never per fleet — see the
 * header. Kept as a function so callers cannot hand-type the separator.
 *
 * @param {string} packId
 * @returns {string|null} `d-<packId>`, or null when there is no pack
 */
export function packMemoryRootKey(packId) {
  const id = typeof packId === "string" ? packId.trim() : "";
  if (!id) return null;
  // A pack id reaches here from a manifest; refuse one that would change the
  // namespace's shape (a slash would address a member, a dot could escape the
  // root prefix).
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  return `d-${id}`;
}

/**
 * Compile a declaration into the policy document for the pack root.
 *
 * @param {unknown} declaration the four-axis block (pack-level or agent-level)
 * @param {{packId: string}} where
 * @returns {{ok: true, rootKey: string, doc: object, empty: boolean}
 *          | {ok: false, errors: Array<{error: string, path?: string, code: string}>}}
 *   `empty` = the pack declared no process axis at all. The caller MUST NOT write
 *   in that case: an empty document is the CLEAR operation in the /policy face,
 *   so writing one would delete a policy a sibling team put there (same root!).
 */
export function compilePackMemoryPolicy(declaration, { packId } = {}) {
  const rootKey = packMemoryRootKey(packId);
  if (!rootKey) {
    return { ok: false, errors: [{ error: "a pack memory root needs a valid packId", path: "packId", code: "pack_id_invalid" }] };
  }
  const errors = validateMemoryBlock(declaration, "memory");
  if (errors.length > 0) return { ok: false, errors };

  const block = declaration && typeof declaration === "object" ? declaration : {};

  // Fixed key order, declaration order discarded: the same declaration must
  // serialize identically every time, because the write is compared for
  // idempotency (task 4.2) and a reshuffled body would look like a change.
  const source = block.process && typeof block.process === "object" ? block.process : {};
  const doc = {};
  for (const key of POLICY_KEYS) {
    if (source[key] !== undefined) doc[key] = source[key];
  }
  return { ok: true, rootKey, doc, empty: Object.keys(doc).length === 0 };
}

/**
 * Whether two compilations of the same pack would produce the same write.
 *
 * The materialization path runs on every pod start, so it must be able to skip a
 * redundant PUT: the memory service treats a write as a row update, but a
 * needless write still bumps `updated_at` and makes "when did this change" — the
 * only audit trail the table has — unreadable.
 */
export function isSamePolicyWrite(a, b) {
  if (!a || !b) return false;
  if (a.rootKey !== b.rootKey) return false;
  return JSON.stringify(a.doc) === JSON.stringify(b.doc);
}
