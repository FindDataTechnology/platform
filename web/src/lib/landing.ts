// Landing target rules (add-role-landing-board). Pure functions, in lib/ so
// node --test can import them directly — the gate component owns fetching and
// painting, this owns the decision (precedent: ./boardTabs.ts).
//
// The server already decided WHERE the user starts and already guaranteed it
// names a visible surface. The one thing it cannot know is whether a board's
// credential is connected, so that check — and only that check — lives here.

/** The board line a landing addresses, or null for a nav landing. */
export function boardLineOf(landing: string): string | null {
  const segments = landing.slice(1).split("/");
  const line = segments[1];
  return segments[0] === "boards" && segments.length === 2 && line ? line : null;
}

/** The nav slug a landing addresses, or null for a board landing. */
export function navSlugOf(landing: string): string | null {
  if (boardLineOf(landing)) return null;
  return landing.slice(1).split("/")[0] || null;
}

export interface LandingFacts {
  landing: string;
  /** Connection states by id (the `/api/connections` projection). */
  states: Record<string, string> | null;
  lineBoardsEnabled: boolean;
  /** The resolved primary navigation; null = an older server (no guard). */
  nav: string[] | null;
  /** `boardAvailable` from ./appCatalog — injected so this module stays pure. */
  boardAvailable: (line: string, states: Record<string, string> | null) => boolean;
  /** Whether the board needs a credential at all (BOARD_CREDENTIAL !== null). */
  needsCredential: (line: string) => boolean;
}

/**
 * Where a first visit actually goes.
 *
 * A board landing whose credential is NOT connected lands on `/apps`, not on
 * chat: the app center is where the connect action lives, so the user lands on
 * the page that unblocks the surface their role asked for. That is the whole
 * point of the role landing — a first screen that helps — and plain chat would
 * throw it away for exactly the users who have not connected yet.
 */
export function resolveLandingTarget(facts: LandingFacts): string {
  const { landing, states, lineBoardsEnabled, nav, boardAvailable, needsCredential } = facts;
  const line = boardLineOf(landing);
  if (line) {
    // The server already filtered on the boards switch; re-check, because a
    // client whose config predates the server's board list must not land 404.
    if (!lineBoardsEnabled) return "/chat";
    if (boardAvailable(line, states)) return landing;
    return needsCredential(line) ? "/apps" : "/chat";
  }
  const slug = navSlugOf(landing);
  if (nav && slug && !nav.includes(slug)) return "/chat";
  return landing;
}
