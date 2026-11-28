// ── Broadcast pull loop, cell side (add-broadcast-and-notification-inbox 2.2/2.3) ─
//
// Each cell pulls the broadcasts it has not consumed yet and writes one
// notification for each of its OWN recipients. Pull rather than push because
// the center then needs no knowledge of who is running where (design D3).
//
// Why the cursor is a SEQUENCE, not a timestamp: cell clocks disagree, and a
// timestamp cursor turns that disagreement into silently skipped or duplicated
// broadcasts. `seq` is assigned by the one process that records broadcasts.
//
// Why the cursor advances only after the writes are committed: a cell that
// crashes mid-page must re-read that page. That is safe because delivery is
// idempotent — `(broadcast_id, recipient_id)` is unique — so "re-read and
// ignore the dupes" is the recovery path rather than a repair script.
//
// Delivery here is LOCAL ONLY (a row in this cell's `notifications`). External
// channels (email / IM) are P4 and hang off the same per-recipient loop.

import { createNotificationStore } from "../lib/broadcast-store.js";

export const CURSOR_KEY = "broadcast.cursor";

/**
 * @param {object} deps
 * @param {object} deps.db                     cell db handle
 * @param {string} deps.cellId                 this cell's identity (spawner's user dir)
 * @param {string} deps.ownerEmail             the identity this cell serves
 * @param {() => string} deps.gatewayBase      resolved per call (env can reload)
 * @param {() => string} deps.gatewaySecret
 * @param {typeof fetch} [deps.fetchImpl]
 */
export function createBroadcastPuller({
  db,
  cellId,
  ownerEmail,
  gatewayBase,
  gatewaySecret,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  // External channels (P4). Each is optional and independent: a recipient with
  // no email configuration, or no bound IM channel, still gets their inbox row
  // (task 4.3 — degrading to the inbox is a normal state, not an error).
  channels = {},
  // Wake hook (design D4). Resolves AFTER this cycle's rows are committed and
  // the cursor has moved, so a wake can never see a half-written inbox. Absent
  // = `wake: "none"` behaviour, which is the default and the common case.
  wake = null,
}) {
  const store = createNotificationStore({ db, now });
  const owner = String(ownerEmail ?? "").trim().toLowerCase();

  function readCursor() {
    try {
      return Number(db.prepare("SELECT value FROM deployment_config WHERE key = ?").get(CURSOR_KEY)?.value) || 0;
    } catch {
      return 0;
    }
  }

  function writeCursor(seq) {
    db.prepare(
      `INSERT INTO deployment_config (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(CURSOR_KEY, String(seq), now());
  }

  /**
   * One pull cycle. Returns { pulled, delivered, failed, cursor }.
   *
   * A failure to reach the gateway leaves the cursor untouched and rethrows, so
   * the caller's next tick retries the same page — a broadcast is never lost to
   * a transient network error.
   */
  async function pullOnce() {
    const base = String(gatewayBase() ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("gateway base url is not configured");
    if (!owner) return { pulled: 0, delivered: 0, failed: 0, cursor: readCursor() };

    const since = readCursor();
    const wakeable = [];
    const res = await fetchImpl(
      `${base}/api/broadcast/pending?since=${encodeURIComponent(since)}&cell=${encodeURIComponent(cellId)}`,
      { headers: { "x-cloud-gateway-secret": String(gatewaySecret() ?? "") } },
    );
    if (!res.ok) throw new Error(`gateway answered ${res.status}`);
    const { broadcasts = [] } = await res.json();

    let delivered = 0;
    let failed = 0;
    let maxSeq = since;
    for (const b of broadcasts) {
      // This cell only materializes the shell of a broadcast; whether THIS
      // owner is among the recipients decides if they get a row. A cell serves
      // one owner, so the recipient set is filtered to exactly them.
      const mine = (b.recipients ?? []).filter((r) => String(r).trim().toLowerCase() === owner);
      let ok = 0;
      if (mine.length > 0) {
        const r = store.deliverToRecipients({
          broadcastId: b.id,
          recipients: mine,
          recipientKind: "user",
          source: "broadcast",
          title: b.title ?? "",
          body: b.body ?? "",
        });
        ok = r.ok;
        delivered += r.ok;
        failed += r.fail;
        // External channels run AFTER the row is durable — the inbox is the
        // source of truth, and a failed email must never cost the notification.
        if (r.ok > 0) {
          const ch = await deliverExternal({ owner, broadcast: b });
          if (ch.failed > 0) failed += ch.failed;
        }
        if (r.fail > 0) {
          // Report the failure and hold the cursor on this broadcast so the
          // next tick retries it. Advancing past a failed delivery would make
          // the broadcast vanish for this recipient with nothing recording why.
          await reportReceipt({ id: b.id, ok, fail: r.fail }).catch(() => {});
          break;
        }
      }
      if (ok > 0 && (b.wake === "batch" || b.wake === "immediate")) wakeable.push(b);
      maxSeq = Math.max(maxSeq, Number(b.seq) || 0);
      // Report even when this owner was not a recipient: the center's counters
      // are per-cell totals, and a broadcast that reached nobody here is a fact
      // the issuer should be able to see rather than infer from silence.
      await reportReceipt({ id: b.id, ok, fail: 0 }).catch(() => {});
    }
    writeCursor(maxSeq);

    // Waking is DELIBERATELY after the cursor write: a wake that arrives while
    // the notification rows are still uncommitted would show the agent an empty
    // inbox and burn the one turn the operator paid for.
    let woke = 0;
    if (wakeable.length && typeof wake === "function") {
      const mode = wakeable.some((b) => b.wake === "immediate") ? "immediate" : "batch";
      try {
        await wake({ mode, broadcasts: wakeable, delivered });
        woke = mode === "immediate" ? wakeable.length : 1;
      } catch (err) {
        // A failed wake costs a turn, not the notification: the rows and the
        // cursor are already durable, so the next agent interaction still sees
        // them. Reported rather than rethrown so the pull cycle does not retry
        // and re-deliver.
        return { pulled: broadcasts.length, delivered, failed, cursor: maxSeq, woke: 0, wakeError: err?.message ?? String(err) };
      }
    }

    return { pulled: broadcasts.length, delivered, failed, cursor: maxSeq, woke };
  }

  /**
   * Report delivery back to the center so `ok_count` reflects reality. Best
   * effort: a lost report costs a number on an admin screen, while withholding
   * the notification row would cost the recipient their message — so this never
   * throws into the delivery path.
   */
  async function reportReceipt({ id, ok, fail }) {
    const base = String(gatewayBase() ?? "").replace(/\/+$/, "");
    if (!base) return;
    await fetchImpl(`${base}/api/broadcast/${encodeURIComponent(id)}/receipt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud-gateway-secret": String(gatewaySecret() ?? "") },
      body: JSON.stringify({ cellId, ok, fail }),
    });
  }

  /**
   * Fan one broadcast out to this owner's external channels.
   *
   * Returns `{ sent, failed, skipped }`. `skipped` is the honest answer when no
   * channel exists for this recipient: the notice is in the inbox, and saying
   * "not sent anywhere else" is different from "sending failed".
   */
  async function deliverExternal({ owner, broadcast }) {
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    const title = broadcast.title || "通知";
    const body = broadcast.body || "";

    if (typeof channels.email === "function") {
      try {
        const r = await channels.email({ to: owner, subject: title, body });
        if (r?.sent) sent += 1;
        else skipped += 1;
        if (r?.failed) failed += 1;
      } catch (err) {
        // A channel failure is that recipient's result, not a cycle abort.
        console.warn(`[broadcast] email to ${owner} failed: ${err?.message || err}`);
        failed += 1;
      }
    } else {
      skipped += 1;
    }
    if (typeof channels.im === "function") {
      try {
        const r = await channels.im({ to: owner, text: `${title}\n${body}` });
        if (r?.sent) sent += 1;
      } catch (err) {
        console.warn(`[broadcast] im to ${owner} failed: ${err?.message || err}`);
      }
    }
    return { sent, failed, skipped };
  }

  return { pullOnce, readCursor, writeCursor, store };
}
