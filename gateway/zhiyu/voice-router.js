// ── Voice routing decision (openspec: add-voice-routing, group 1 + 2) ────────
//
// A room message that came out of a meeting recording has to answer one
// question: whose agent should hear it? Three signals can answer, and they are
// ranked, because when they disagree the human's explicit choice must win:
//
//   1. mention      — the speaker said 「@X」 out loud (or typed it in the
//                     transcript). Nothing outranks an explicit address.
//   2. attribution  — the voice lane says who spoke, and that person has their
//                     own team in this room. Their words go to their agent.
//   3. intent       — nobody was named and no attribution applies, so match the
//                     utterance against the room's CALLABLE teams only.
//
// Two rules make this safe rather than clever:
//
//   • SHORT-CIRCUIT (1.2): once a higher path resolves, the candidate set stops
//     growing. 「@张三 预算怎么样」 must not also wake 李四's team because the
//     word 预算 matched it — that is how a meeting ends up billing four agents
//     for one question.
//   • NO GUESSING (2.4): an `anonymous` attribution never takes the default
//     path. It lands as `needs_confirmation` with the reason, because the cost
//     of asking is one click and the cost of guessing is a private conversation
//     delivered to the wrong colleague.
//
// This file is deliberately pure: no DB, no store, no clock (1.3). The room
// router passes in what it knows; everything here is a function of its inputs,
// which is what makes the whole matrix testable.
//
// The `@` lexer lives here (2.1) and the room router imports it, so 「与既有 @
// 词法一致」 is not a claim about two implementations agreeing — there is one.

/** Why a decision came out the way it did. Stable strings: they land in logs. */
export const ROUTE_BASIS = Object.freeze(["mention", "attribution", "intent", "broadcast", "needs_confirmation"]);

/** Priority order. Earlier wins; a later path never widens an earlier result. */
export const ROUTE_PRIORITY = Object.freeze(["mention", "attribution", "intent"]);

/** The certainties that may take the default-recipient path (2.2/2.4). */
export const ATTRIBUTION_CERTAIN = Object.freeze(["session", "bound"]);

/**
 * The `@` name list for one roster entry — display and alias, split on `,` and
 * `/`. Moved verbatim out of room-router so both callers share one rule.
 */
export function namesFor(entry) {
  const names = [entry?.display, entry?.alias]
    .flatMap((s) => String(s ?? "").split(/[,/]/))
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Resolve `@name` hits against a roster (seats and/or teams).
 *
 * Case-insensitive substring, exactly as the room router has always done: a
 * stricter tokeniser would silently stop matching 「@DeepResearch，」 with a
 * full-width comma, and every existing transcript has that shape.
 */
export function matchMentions(text, roster = []) {
  const content = String(text ?? "").toLowerCase();
  if (!content.includes("@")) return [];
  const hits = [];
  const seen = new Set();
  for (const entry of roster) {
    if (!entry || seen.has(entry.id)) continue;
    const names = entry.names ?? namesFor(entry);
    for (const name of names) {
      const needle = String(name).toLowerCase();
      if (needle && content.includes(`@${needle}`)) {
        hits.push(entry);
        seen.add(entry.id);
        break;
      }
    }
  }
  return hits;
}

/**
 * Is this team reachable right now? Visibility and callability are separate
 * facts (a listed team at its daily ceiling is visible but not callable), and a
 * candidate must satisfy both before it can be addressed (2.3).
 */
export function teamCallable(team) {
  if (!team) return { ok: false, because: "not_found" };
  if (team.visible === false) return { ok: false, because: "not_visible" };
  if (team.callable === false) return { ok: false, because: team.reason ?? "not_callable" };
  if (team.quotaExceeded === true) return { ok: false, because: "quota_exceeded" };
  return { ok: true, because: null };
}

/** The teams a given member owns/operates inside this room (2.2). */
function teamsOfMember(roomTeams, memberId) {
  if (!memberId) return [];
  return roomTeams.filter((t) => t && t.ownerMemberId && t.ownerMemberId === memberId);
}

/** Crude intent match: a team's declared tags appearing in the utterance. */
function intentMatches(utterance, roomTeams) {
  const text = String(utterance ?? "").toLowerCase();
  if (!text) return [];
  return roomTeams.filter((team) => {
    const tags = Array.isArray(team?.tags) ? team.tags : [];
    return tags.some((tag) => {
      const t = String(tag ?? "").trim().toLowerCase();
      return t.length > 0 && text.includes(t);
    });
  });
}

/**
 * Decide who an utterance is for.
 *
 * @param utterance   the text (already transcribed; the `@` lexer reads it)
 * @param attribution { certainty: "session"|"bound"|"anonymous", memberId? }
 * @param roomTeams   [{ id, ref, display, names?, ownerMemberId, tags?, visible, callable, reason?, quotaExceeded? }]
 * @param roomSeats   [{ id, kind, display, names?, teamId? }] — mentionable seats
 * @param roomPolicy  { allowBroadcast?: boolean, meetingMode?: boolean }
 * @returns { recipients, basis, candidates, reason }
 *   `recipients`  — what to dispatch to (teams and/or seats), in stable order
 *   `candidates`  — what was CONSIDERED, so the trail can explain a non-choice
 */
export function decideAddressee({ utterance = "", attribution = null, roomTeams = [], roomSeats = [], roomPolicy = {} }) {
  const policy = roomPolicy ?? {};
  const teams = Array.isArray(roomTeams) ? roomTeams.filter(Boolean) : [];
  const seats = Array.isArray(roomSeats) ? roomSeats.filter(Boolean) : [];

  // ── 1. an explicit address outranks everything ───────────────────────────
  // Kind is normalized here rather than trusted from the caller: a team object
  // that forgot `kind: "team"` used to be treated as a seat and sailed past the
  // callability gate — the exact bug this normalization makes impossible.
  const roster = [
    ...seats.map((s) => ({ ...s, kind: s.kind ?? "agent" })),
    ...teams.map((t) => ({ ...t, kind: "team" })),
  ];
  const mentions = matchMentions(utterance, roster);
  if (mentions.length) {
    // A named seat that stands for a team resolves to that team; a named team
    // resolves to itself. Naming something the room cannot call is not a
    // dispatch — it is an answerable refusal.
    const recipients = [];
    const blocked = [];
    for (const hit of mentions) {
      if (hit.kind === "team") {
        const gate = teamCallable(hit);
        if (gate.ok) recipients.push(hit);
        else blocked.push({ id: hit.id, because: gate.because });
        continue;
      }
      const team = hit.teamId ? teams.find((t) => t.id === hit.teamId) : null;
      if (team) {
        const gate = teamCallable(team);
        if (gate.ok) recipients.push(team);
        else blocked.push({ id: team.id, because: gate.because });
      } else {
        // A seat with no team behind it still answers — it is the seat that
        // does the work. Blocking it would make 「@前台」 silently do nothing.
        recipients.push(hit);
      }
    }
    if (recipients.length) {
      return {
        recipients,
        basis: "mention",
        candidates: recipients,
        reason: blocked.length
          ? `点名命中 ${recipients.length} 个；另有 ${blocked.length} 个点名对象当前不可调（${blocked.map((b) => b.because).join(",")}）`
          : "点名命中",
      };
    }
    return {
      recipients: [],
      basis: "needs_confirmation",
      candidates: [],
      reason: `点名对象当前都不可调（${blocked.map((b) => b.because).join(",")}）`,
      blocked,
    };
  }

  // ── 2. the speaker's own team ────────────────────────────────────────────
  // `null` attribution means the attribution feature is not in play at all (a
  // typed message); `certainty: "anonymous"` means we looked and could not tell.
  // Those are different facts and they end differently: the first keeps the
  // legacy broadcast, the second must ask (2.4).
  const known = attribution !== null && attribution !== undefined;
  const certainty = known ? String(attribution.certainty ?? "anonymous") : null;
  const memberId = known ? (attribution.memberId ?? null) : null;
  // Why the attribution path did not resolve. Kept so the final answer can say
  // it out loud instead of quietly falling through to a broadcast (2.2).
  let attributionMiss = null;
  // Two different misses, and they end differently:
  //   owned-but-blocked — there WAS a target and the budget/visibility blocked it;
  //                       broadcasting would spend OTHER teams' budget answering
  //                       outside their remit, so we ask instead.
  //   owns-nothing      — the speaker has no seat in this room at all; the room's
  //                       normal broadcast is the right home for their words.
  let ownedButBlocked = false;
  if (ATTRIBUTION_CERTAIN.includes(certainty) && memberId) {
    const owned = teamsOfMember(teams, memberId);
    const callableOwned = owned.filter((t) => teamCallable(t).ok);
    if (callableOwned.length) {
      return {
        recipients: callableOwned,
        basis: "attribution",
        candidates: callableOwned,
        reason: `归属为该成员（${certainty}），派给他自己的 ${callableOwned.length} 个团队`,
      };
    }
    ownedButBlocked = owned.length > 0;
    attributionMiss = owned.length
      ? `该成员有 ${owned.length} 个团队但当前都不可调`
      : "该成员在本房间没有自己的团队";
  }

  // ── 3. narrow by intent inside the callable set ──────────────────────────
  const callable = teams.filter((t) => teamCallable(t).ok);
  const matched = intentMatches(utterance, callable);
  if (matched.length) {
    // Meeting mode asks for ONE answer unless several were named explicitly
    // (3.4). Picking the first is deterministic, and the reason says so.
    const chosen = policy.meetingMode ? matched.slice(0, 1) : matched;
    return {
      recipients: chosen,
      basis: "intent",
      candidates: matched,
      reason: policy.meetingMode
        ? `会议模式：意图命中 ${matched.length} 个，只叫 1 个`
        : `意图命中 ${matched.length} 个可调团队`,
    };
  }

  // ── 4. nothing resolved ──────────────────────────────────────────────────
  if (certainty === "anonymous") {
    // An uncertain speaker must be ASKED, never guessed at — and the guess here
    // would be the worst kind: broadcast to the whole room.
    return {
      recipients: [],
      basis: "needs_confirmation",
      candidates: [],
      reason: "归属不确定，且没有点名或意图可依；不广播",
    };
  }
  if (ownedButBlocked) {
    return {
      recipients: [],
      basis: "needs_confirmation",
      candidates: [],
      reason: `${attributionMiss}；也没有点名或意图可依。不广播：那会花别人的预算答不属于他们的题`,
    };
  }
  if (policy.allowBroadcast === false) {
    return { recipients: [], basis: "needs_confirmation", candidates: [], reason: "本房间未开启广播征询" };
  }
  // The unchanged legacy behaviour: ask everyone who is eligible. The reason
  // carries the missed attribution path, so a broadcast that happened because
  // "the speaker had no team here" is distinguishable afterwards.
  const broadcast = seats.filter((s) => s.kind !== "facade" || s.presence !== "listening");
  return {
    recipients: broadcast,
    basis: "broadcast",
    candidates: broadcast,
    reason: attributionMiss ? `无点名也无意图命中；${attributionMiss}，按既有广播征询` : "无点名、无归属、无意图命中，按既有广播征询",
  };
}

/**
 * Meeting mode's extra guard (3.4): may this decision produce more than one
 * answer?
 *
 * Explicitly addressed (mention) or explicitly invited (broadcast) may answer
 * as many times as it addressed. An inferred intent match must not: 「预算怎么样」
 * matched three teams is a reason to ask ONE of them, not three.
 */
export function allowsMultipleAnswers({ basis, recipients, roomPolicy }) {
  if (!roomPolicy?.meetingMode) return true;
  if (basis === "mention" || basis === "broadcast") return true;
  if (basis === "intent") return recipients.length <= 1;
  return true;
}

/**
 * Read the routing trail (add-voice-routing 6.2).
 *
 * Read-only and honest about what it cannot know: there is no ground truth for
 * "was this the right addressee", so `reassignRate` is a PROXY for misrouting
 * (a human moved it afterwards), not a measurement of it. `needsConfirmationRate`
 * is the third number worth watching — it says how often the lane had to ask
 * instead of route, which is where the labelled data comes from.
 */
export function summarizeRouteDecisions(rows = []) {
  const decisions = [];
  let reassigned = 0;
  let cancelled = 0;
  for (const row of rows) {
    const event = String(row?.meta?.event ?? "");
    if (event === "route_decision") decisions.push(row);
    else if (event === "route_reassigned") reassigned += 1;
    else if (event === "route_cancelled") cancelled += 1;
  }
  const byBasis = Object.fromEntries(ROUTE_BASIS.map((b) => [b, 0]));
  for (const row of decisions) {
    const basis = String(row?.meta?.kind ?? "");
    if (basis in byBasis) byBasis[basis] += 1;
  }
  const total = decisions.length;
  const rate = (n) => (total === 0 ? 0 : Number((n / total).toFixed(4)));
  return {
    decisions: total,
    byBasis,
    reassigned,
    cancelled,
    /** Proxy for misrouting: a human moved the addressee afterwards. */
    reassignRate: rate(reassigned),
    cancelRate: rate(cancelled),
    /** How often the room had to ask instead of route. */
    needsConfirmationRate: rate(byBasis.needs_confirmation ?? 0),
    /** Said out loud so a later reader does not mistake a proxy for truth. */
    note: "reassignRate 是误派的可观测代理，不是真值；真值需要人工标注",
  };
}
