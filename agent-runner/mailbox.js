// ── Seat mailbox poller (add-desktop-fleet-runner ④) ────────────────────────
//
// The desktop runner's outbound half of the mailbox protocol: poll the
// facade's per-seat box over the same fleet prefix telemetry reports through,
// run each task's turn against the LOCAL hosting of that agent, and settle
// the result back. Pure egress: the seat never listens for tasks. A task for
// an agent this seat does not host settles failed immediately (distribution
// drift, not a retry candidate).

export function createMailboxPoller({
  manager,
  registryClient,
  url, // the fleet base (per-seat credentialed), e.g. https://…/api/wanxing/v1/fleet
  token,
  pollSecs = 30,
  fetchImpl = null,
  log = null,
}) {
  const say = log ?? (() => {});
  const doFetch = fetchImpl ?? ((u, i) => fetch(u, i));
  const base = () => String(url || "").replace(/\/+$/, "");
  let timer = null;
  let busy = false;

  async function settle(taskId, ok, text) {
    try {
      const r = await doFetch(`${base()}/mailbox/result`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: taskId, ok, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) say(`settle ${taskId} -> HTTP ${r.status} (will not retry: the task stays delivered)`);
    } catch (e) {
      say(`settle ${taskId} failed: ${e?.message || e}`);
    }
  }

  // One pass: pull → run each turn serially (the seat's budget is one
  // machine's) → settle. Failures settle failed; a pass never throws.
  async function pass() {
    let tasks = [];
    try {
      const r = await doFetch(`${base()}/mailbox`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 401) {
        say("mailbox credential rejected — seat revoked or rotated; polling continues (config may change on restart)");
        return;
      }
      if (!r.ok) {
        say(`mailbox pull -> HTTP ${r.status}`);
        return;
      }
      tasks = (await r.json()).tasks ?? [];
    } catch (e) {
      say(`mailbox pull failed: ${e?.message || e}`);
      return;
    }
    for (const t of tasks) {
      try {
        const out = await runTask(t);
        await settle(t.taskId, true, out);
        say(`task ${t.taskId} done (${out.length} chars)`);
      } catch (e) {
        await settle(t.taskId, false, String(e?.message || e));
        say(`task ${t.taskId} failed: ${e?.message || e}`);
      }
    }
  }

  // Find the agent's LIVE entry among this seat's served slice and run the
  // turn on it. agentPath is the registry's canonical path — the local
  // entries carry the same paths.
  async function runTask(t) {
    const entries = await registryClient.listServedAgents();
    const entry = entries.find((e) => e.path === t.agentPath);
    if (!entry) {
      throw new Error(`this seat does not host ${t.agentPath} (task not retried)`);
    }
    const sessionId = `mailbox-${t.taskId}`;
    const out = await manager.turn(entry, sessionId, t.text, { kind: "message" });
    return out.text ?? "";
  }

  return {
    pass,
    start() {
      if (timer || !base() || !token) return;
      void pass();
      timer = setInterval(() => {
        if (busy) return;
        busy = true;
        pass().finally(() => { busy = false; });
      }, Math.max(5, pollSecs) * 1000);
      timer.unref?.();
      say(`mailbox poller armed (${base()}, every ${pollSecs}s)`);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

