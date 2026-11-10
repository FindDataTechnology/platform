// ── Shared browser lane: which cell is this connection? ─────────────────────
//
// slim-browser-lane-footprint Requirement "cell 身份不由客户端自报": the shared
// service must decide the isolation boundary and the artifact owner from a
// deployment-trusted source, never from something the caller puts in the
// request. Everything a caller CAN write (headers, query string, JSON body) is
// therefore ignored — this module answers the question from the operating
// system's view of the connection:
//
//   peer socket (port pair) → socket inode (/proc/net/tcp{,6})
//     → owning pid (/proc/<pid>/fd → socket:[inode])
//       → cell (that pid's cwd/cmdline, then up to N ancestors)
//
// The last step reuses the memory face's attribution rule (cellIdFromText over
// the 16-hex directory under CELL_DATA_ROOT), so "which cell owns this path"
// has exactly one definition in the pod. `/proc` is Linux-only: on a macOS dev
// box or desktop app the resolver degrades to null and the caller falls back to
// a per-session scratch dir (never to a client-supplied claim).
//
// A caller inside the pod that knows a cell's path could still *read* its
// artifacts if it ran as the same uid — that is the same trust boundary the
// rest of the pod already has (cells share the container). What this module
// guarantees is narrower and is what the spec asks: a forged label in the
// request cannot move the isolation boundary or the artifact owner.

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { cellIdFromText, defaultCellsRoot } from "./proc-memory.js";

// An accepted connection's ports, from the server's own socket.
export function peerPortsOf(socket) {
  const remotePort = Number(socket?.remotePort);
  const localPort = Number(socket?.localPort);
  if (!Number.isFinite(remotePort) || !Number.isFinite(localPort)) return null;
  return { remotePort, localPort };
}

// /proc/net/tcp{,6} row → socket inode, for the row whose LOCAL port is our
// peer's ephemeral port and whose REMOTE port is ours (i.e. the peer's end).
// Fields: sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode.
function tablePath(netRoot, name) {
  return path.join(netRoot, name);
}

export function socketInodeForPeer({ remotePort, localPort, netRoot = "/proc/net" } = {}) {
  if (!Number.isFinite(remotePort) || !Number.isFinite(localPort)) return null;
  for (const name of ["tcp", "tcp6"]) {
    let raw;
    try {
      raw = readFileSync(tablePath(netRoot, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10) continue;
      const [localHex, localPortHex] = parts[1].split(":");
      const [, remotePortHex] = parts[2].split(":");
      const state = parts[3];
      if (state !== "01") continue; // 01 = ESTABLISHED
      if (Number.parseInt(localPortHex, 16) !== remotePort) continue;
      if (Number.parseInt(remotePortHex, 16) !== localPort) continue;
      const inode = Number(parts[9]);
      if (Number.isFinite(inode) && inode > 0) return { inode, localHex };
    }
  }
  return null;
}

// The pid holding `socket:[inode]`. One pass over /proc/<pid>/fd; processes
// that vanish mid-scan are skipped (a racing exit is not an error).
export function pidForSocketInode({ inode, procRoot = "/proc" } = {}) {
  if (!Number.isFinite(inode) || inode <= 0) return null;
  const needle = `socket:[${inode}]`;
  let pids;
  try {
    pids = readdirSync(procRoot).filter((d) => /^\d+$/.test(d));
  } catch {
    return null;
  }
  for (const pid of pids) {
    const fdDir = path.join(procRoot, pid, "fd");
    let fds;
    try {
      fds = readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        if (readlinkSync(path.join(fdDir, fd)) === needle) return Number(pid);
      } catch {
        /* closed between readdir and readlink */
      }
    }
  }
  return null;
}

function readCwd(procRoot, pid) {
  try {
    return readlinkSync(path.join(procRoot, String(pid), "cwd"));
  } catch {
    return null;
  }
}

function readCmdline(procRoot, pid) {
  try {
    return readFileSync(path.join(procRoot, String(pid), "cmdline"), "utf8")
      .split("\0")
      .filter(Boolean)
      .join(" ");
  } catch {
    return null;
  }
}

function readPpid(procRoot, pid) {
  try {
    const stat = readFileSync(path.join(procRoot, String(pid), "stat"), "utf8");
    // field[2] = ppid; comm may contain spaces/parens — split after the last ')'.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[1]);
  } catch {
    return null;
  }
}

// The cell a process belongs to, checking its own cwd/cmdline and then up to
// `maxAncestors` parents. The dsh child's own cwd can be the cell root's
// runtime dir (a clue) or /app (no clue) — the cell server one hop up always
// carries one, so a bounded walk is enough and avoids attributing by long
// process trees (re-parented satellites have no reliable ancestry, the same
// reason lib/proc-memory.js stops at one hop).
export function cellForPid({ pid, procRoot = "/proc", cellsRoot = defaultCellsRoot(), maxAncestors = 3 } = {}) {
  let current = Number(pid);
  const evidence = [];
  for (let hop = 0; hop <= maxAncestors && Number.isFinite(current) && current > 0; hop += 1) {
    const cwd = readCwd(procRoot, current);
    const cmdline = readCmdline(procRoot, current);
    const fromCwd = cellIdFromText(cwd, cellsRoot);
    const fromCmdline = fromCwd ? null : cellIdFromText(cmdline, cellsRoot);
    const cellId = fromCwd ?? fromCmdline;
    if (cellId) {
      return {
        cellId,
        pid: Number(pid),
        attributedVia: hop === 0 ? (fromCwd ? "cwd" : "cmdline") : `ancestor:${hop}:${fromCwd ? "cwd" : "cmdline"}`,
        evidence: [...evidence, { pid: current, cwd, matched: fromCwd ? "cwd" : "cmdline" }],
      };
    }
    evidence.push({ pid: current, cwd, matched: null });
    current = readPpid(procRoot, current);
  }
  return { cellId: null, pid: Number(pid), attributedVia: null, evidence };
}

// Full resolution for one accepted connection.
export function resolvePeerCell({ socket, procRoot = "/proc", netRoot = "/proc/net", cellsRoot = defaultCellsRoot() } = {}) {
  const ports = peerPortsOf(socket);
  if (!ports) return { cellId: null, reason: "no_peer_ports" };
  const sock = socketInodeForPeer({ ...ports, netRoot });
  if (!sock) return { cellId: null, reason: "peer_socket_not_found" };
  const pid = pidForSocketInode({ inode: sock.inode, procRoot });
  if (!pid) return { cellId: null, reason: "peer_pid_not_found" };
  const attributed = cellForPid({ pid, procRoot, cellsRoot });
  if (!attributed.cellId) return { cellId: null, reason: "peer_not_in_a_cell", pid, evidence: attributed.evidence };
  return {
    cellId: attributed.cellId,
    pid,
    attributedVia: attributed.attributedVia,
    evidence: attributed.evidence,
    workspaceDir: cellWorkspaceDir(attributed.cellId, cellsRoot),
  };
}

// The cell's authoritative workspace. gateway/spawner.js creates exactly
// `<dataRoot>/<userId16>/workspace` and pins it as the cell's AGENT_WORKSPACE —
// the directory its /api/files serves, which is why artifacts must land under
// it to be visible to (and only to) the owning cell.
export function cellWorkspaceDir(cellId, cellsRoot = defaultCellsRoot()) {
  if (!cellId) return null;
  return path.join(cellsRoot, cellId, "workspace");
}
