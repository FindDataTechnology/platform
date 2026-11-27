// TeamConsoleView — the facet's share page for one team's console
// (add-pack-console: facet-platform "谦面提供团队控制台分享页").
//
// Path-addressed (`/t/<slug>`), not hash-addressed: a shared link must look like
// a page, and the facet server's SPA fallback already serves index.html for any
// non-API GET, so no server route is needed.
//
// Two rules this file exists to keep:
//   · it mounts the SHARED `TeamConsole` with surface="share" — the same
//     component and the same view model the 壹座 page uses, so a block cannot
//     look different on the two hosts;
//   · it offers no write action. A share page is a reading surface: no start,
//     no pause, no dispatch, no decision answer.
//
// Degradation: the share page reads the facet's OWN fleet store (fleet-owns-its
// fleets). If the slug is not in this deployment's `fleets.db` the page says
// so — it does NOT fall back to proxying another host, because a deployment
// with no platform behind it must behave identically.

import { useEffect, useState } from "react";
import { TeamConsole } from "@/components/console/TeamConsole";

function slugFromPath(pathname: string): string | null {
  const match = /^\/t\/([^/?#]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export function TeamConsoleView() {
  const [slug, setSlug] = useState<string | null>(() => slugFromPath(window.location.pathname));

  // Plain anchors may change the path without a reload; keep the slug honest.
  useEffect(() => {
    const onPop = () => setSlug(slugFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  if (!slug) return null;
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6" data-testid="facet-team-console">
      <TeamConsole
        slug={slug}
        surface="share"
        // Direct read against this host's own fleet store (facet-owns-its-fleets
        // 3.1). `/api/fleets/by-slug/:slug/console` is the facet's API — no proxy
        // hop, so the page renders with 壹座 entirely down.
        endpoint={`/api/fleets/by-slug/${encodeURIComponent(slug)}/console`}
      />
    </div>
  );
}

export { slugFromPath };
