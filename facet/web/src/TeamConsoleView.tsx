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
// Degradation: when 壹座 is unreachable the shared component renders its own
// "temporarily unavailable" state. The market plane (pack browsing, detail,
// downloads) is a different code path and stays up — the independence promise
// in the facet-platform spec is about the market, and this page is explicitly
// the optional surface.

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
        // On the facet domain `/api/*` is the facet's own API; this proxy is the
        // one read path to 壹座's public console endpoint.
        endpoint={`/api/team-console/${encodeURIComponent(slug)}`}
      />
    </div>
  );
}

export { slugFromPath };
