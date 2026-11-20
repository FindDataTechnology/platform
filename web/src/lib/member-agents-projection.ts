// member-agents-projection — the pairing between a team document's two lists
// (complete-team-authoring-loop 2.2, design D2).
//
// A team document carries `fleet.members[]` (the roster the provisioner reads)
// and `agents[]` (the personas the pack ships). For a self-referencing member
// these two lists are the SAME namespace: `target.presetId` must equal an
// `agents[].id` — the closure the server gate enforces (批 1) and the
// provisioner resolves at install time. The workspace used to edit `agents[]`
// (three-bucket card) with no way to touch `fleet.members[]`, so a document
// created blank could never satisfy `fleet_members_empty`, and a document
// whose two lists drifted reported red only after 铸造.
//
// This module is the pure pairing used by the canvas's 加岗 action and the
// post drawer. Pure and React-free so its unit test reads the same bytes the
// component does.

export interface DocAgent {
  id: string;
  name?: string;
  persona?: string;
  [k: string]: unknown;
}

export interface DocMemberTarget {
  kind: "pack-preset" | "existing-persona" | "existing-cluster" | "existing-a2a" | "tool" | "bot";
  packId?: string;
  presetId?: string;
  id?: string;
}

export interface DocMember {
  ref: string;
  title: string;
  parentRef?: string | null;
  target: DocMemberTarget;
  cadence?: unknown;
  kpiSlots?: unknown[];
  [k: string]: unknown;
}

const SELF_PACK = "{{PACK_ID}}";

/** A slug safe for both a member `ref` and an agent `id`. */
export function slugify(input: string): string {
  const ascii = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii;
}

function uniqueId(base: string, taken: Set<string>): string {
  const root = base || "post";
  if (!taken.has(root)) return root;
  let n = 2;
  while (taken.has(`${root}-${n}`)) n += 1;
  return `${root}-${n}`;
}

/**
 * Add a post to BOTH lists, keeping the closure intact.
 *
 * The new member is self-referencing (`packId: {{PACK_ID}}`) with
 * `presetId` set to the id of the agent added alongside it — so a post created
 * here can never be the thing the closure gate rejects. The agent is a plain
 * persona the author then fills in (the same shape the 智能体作者 edits).
 *
 * Existing ids are never reused; a title that slugifies to an occupied id gets
 * a numeric suffix on BOTH sides so they stay equal.
 */
export function addPost(
  doc: { kind?: string; members?: DocMember[]; agents?: DocAgent[]; fleet?: { name?: string } },
  title: string,
): { member: DocMember; agent: DocAgent; members: DocMember[]; agents: DocAgent[] } {
  const members = [...(doc.members ?? [])];
  const agents = [...(doc.agents ?? [])];
  const taken = new Set<string>([
    ...agents.map((a) => a?.id).filter((x): x is string => typeof x === "string"),
    ...members.map((m) => m?.ref).filter((x): x is string => typeof x === "string"),
  ]);
  const id = uniqueId(slugify(title), taken);
  // The persona starts as an honest skeleton, not an empty string: pack
  // validation requires a non-empty persona (agents[i].persona), so a post
  // added here would otherwise make the document un-passable — the exact
  // "the GUI can't produce a green document" failure this batch removes.
  // The author edits this text (the three-bucket card edits the same record).
  const agent: DocAgent = { id, name: title, persona: `你是${title || id}。` };
  const member: DocMember = {
    ref: id,
    title,
    parentRef: null,
    target: { kind: "pack-preset", packId: SELF_PACK, presetId: id },
  };
  return { member, agent, members: [...members, member], agents: [...agents, agent] };
}

/**
 * Remove a post and its paired agent.
 *
 * Pairing is recognized by the SAME rule the closure gate uses: a
 * self-referencing member pairs with the agent whose id equals its presetId.
 * Removing a post whose target points elsewhere (a cross-pack or existing
 * persona reference) removes the post only — deleting the referenced agent
 * would be deleting something this document does not own.
 */
export function removePost(
  doc: { members?: DocMember[]; agents?: DocAgent[] },
  ref: string,
): { members: DocMember[]; agents: DocAgent[]; removedAgentId: string | null } {
  const members = [...(doc.members ?? [])];
  const agents = [...(doc.agents ?? [])];
  const victim = members.find((m) => m?.ref === ref);
  const nextMembers = members.filter((m) => m?.ref !== ref);
  const pairedId = pairedAgentIdOf(victim);
  const nextAgents = pairedId ? agents.filter((a) => a?.id !== pairedId) : agents;
  return { members: nextMembers, agents: nextAgents, removedAgentId: pairedId ?? null };
}

/** The agent id a member owns, or null when it points outside this document. */
export function pairedAgentIdOf(member: DocMember | undefined): string | null {
  if (!member || member.target?.kind !== "pack-preset") return null;
  const packId = member.target.packId;
  if (packId !== SELF_PACK && packId !== "{{PACK_ID:self}}") return null;
  const presetId = member.target.presetId;
  return typeof presetId === "string" && presetId.trim() ? presetId : null;
}

export interface PairingBreak {
  ref: string;
  presetId: string;
}

/**
 * Every self-referencing member whose presetId names no agent in this document.
 *
 * This is the client-side PREVIEW of the server's `fleet_preset_unresolved`
 * finding (批 1) — not a second gate. It exists so the canvas can mark the
 * broken post the instant an id is retyped, instead of waiting for a validate
 * round-trip. The authoritative verdict always comes from the server.
 */
export function pairingBreaks(doc: { members?: DocMember[]; agents?: DocAgent[] }): PairingBreak[] {
  const agentIds = new Set(
    (doc.agents ?? []).map((a) => a?.id).filter((x): x is string => typeof x === "string"),
  );
  const out: PairingBreak[] = [];
  for (const m of doc.members ?? []) {
    const paired = pairedAgentIdOf(m);
    if (paired && !agentIds.has(paired)) out.push({ ref: m.ref, presetId: paired });
  }
  return out;
}

/** Rename an agent on both sides so the pairing survives an id edit. */
export function renameAgent(
  doc: { members?: DocMember[]; agents?: DocAgent[] },
  fromId: string,
  toId: string,
): { members: DocMember[]; agents: DocAgent[] } {
  const members = (doc.members ?? []).map((m) => {
    if (pairedAgentIdOf(m) !== fromId) return m;
    return { ...m, target: { ...m.target, presetId: toId } };
  });
  const agents = (doc.agents ?? []).map((a) => (a?.id === fromId ? { ...a, id: toId } : a));
  return { members, agents };
}
