// ── Steward control-plane client (add-cell-lifecycle, chapter 1) ───────────
//
// Used by the Electron UI to attach to a resident steward (and by tests).
// Discovery reads <dataDir>/steward.json; attach verifies the socket accepts
// and the peer speaks a supported protocolVersion major. Anything less is
// reported, never repaired silently — `createStewardClient` callers decide
// whether to fall back to the embedded supervisor.

import net from "node:net";
import fs from "node:fs";
import crypto from "node:crypto";
import { STEWARD_PROTOCOL_VERSION } from "../lib/cell-lifecycle.js";

export function readStewardDiscovery(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(new URL(`file://${dataDir}/steward.json`), "utf8"));
  } catch {
    try { return JSON.parse(fs.readFileSync(`${dataDir}/steward.json`, "utf8")); }
    catch { return null; }
  }
}

export function createStewardClient({ socket, timeoutMs = 3000 }) {
  const request = (op, params = {}) =>
    new Promise((resolve, reject) => {
      const conn = net.createConnection(socket);
      const timer = setTimeout(() => { conn.destroy(); reject(new Error("steward request timed out")); }, timeoutMs);
      let buf = "";
      conn.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        clearTimeout(timer);
        try {
          const msg = JSON.parse(buf.slice(0, nl));
          conn.end();
          if (!msg.ok) return reject(new Error(msg.error ?? "steward request failed"));
          resolve(msg.result ?? msg);
        } catch (e) { reject(e); }
      });
      conn.on("error", (e) => { clearTimeout(timer); reject(e); });
      conn.on("connect", () => {
        conn.write(JSON.stringify({ id: crypto.randomUUID(), op, protocolVersion: STEWARD_PROTOCOL_VERSION, params }) + "\n");
      });
    });
  return { request };
}

// Attach discipline (spec): discovery present + socket answers hello + major
// version supported. Returns { ok, reason?, client?, discovery }.
export async function attachSteward(dataDir, { timeoutMs = 2000 } = {}) {
  const discovery = readStewardDiscovery(dataDir);
  if (!discovery?.socket) return { ok: false, reason: "no-steward-json" };
  const client = createStewardClient({ socket: discovery.socket, timeoutMs });
  try {
    const hello = await client.request("hello");
    const major = Number(hello?.protocolVersion);
    if (!Number.isFinite(major) || Math.trunc(major) !== STEWARD_PROTOCOL_VERSION) {
      return { ok: false, reason: `unsupported-protocol(${hello?.protocolVersion})`, discovery };
    }
    return { ok: true, client, discovery };
  } catch (e) {
    return { ok: false, reason: e.message ?? "connect failed", discovery };
  }
}
