// Thin client for the connection projection that already exists
// (GET /api/connections — connection-center), read here for its door grouping
// (converge-line-identity-and-keys 4.2).
//
// Why not a dedicated endpoint: the connection state has exactly one read face.
// A second one would drift, and the drifting side is always the one nobody
// looks at. This module therefore only *reshapes* what the existing route
// already answers — per-connection state, plus the door grouping the route now
// carries additively.
//
// Labels are NOT taken from the payload: the server sends Chinese display names
// (`name`), which would break locale parity for the other four locales. The UI
// maps ids through its own copy.

export type DoorId = "customer-key" | "member-assertion" | "third-party";

/** Server-side connection states (kept verbatim — no re-derivation here). */
export type ConnectionState = "connected" | "stale" | "disconnected" | "not-configured";

export interface Connection {
  id: string;
  name: string;
  state: ConnectionState;
  reason?: string | null;
  door?: DoorId | null;
  /** connector only: resolved binding ledger summary. */
  bindingSummary?: { packs: number; need: number; unresolved: number } | null;
  /** search only. */
  userKey?: boolean;
}

export interface MemberLine {
  line: string;
  enabled: boolean;
  jitPolicy: string;
  exchangeUrl: string | null;
  ownTrack: string | null;
}

export interface DoorGroups {
  order: DoorId[];
  doors: { id: DoorId; connections: string[] }[];
  memberAssertion: { declared: boolean; enabled: boolean; lines: MemberLine[] };
  /** ids the classification table did not cover — surfaced, never swallowed. */
  unclassified: string[];
}

export interface ConnectionsPayload {
  connections: Connection[];
  doors: DoorGroups;
}

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function fetchConnections(): Promise<ConnectionsPayload> {
  return fetch("/api/connections", { credentials: "same-origin" }).then(jsonOrThrow);
}
