// ── Tuning scorecard: the owner's objects × the bench's verdict ledger ───────
//
// add-bench-verdict-read-face. The TuningPage used to show skill candidates and
// their LOCAL eval_report — a per-skill JSON only this cell knows about, in a
// vocabulary nobody else shares. The bench now keeps a unified verdict ledger
// (subject / ruler / gate / outcome / baseline / provisional); this route makes
// it visible to the person who owns the objects.
//
// Three properties, each of them a failure mode of the read face's first draft:
//
//   • PURE READ. Opening the page must not run an evaluation — evaluations cost
//     a judge lane and, sometimes, human gold. Nothing here triggers one.
//
//   • ONE LIST CALL, filtered here. Asking the peer once per subject would be N
//     round trips for a page; more importantly, the peer caps its rows, so N
//     calls could each succeed and still leave holes. One bounded read plus a
//     local filter is both cheaper and easier to reason about.
//
//   • THE PEER'S WORDS SURVIVE. `outcome` (three states, including
//     `inconclusive`) and `provisional` are passed through untouched. The
//     `inconclusive` rows are counted SEPARATELY from failures — collapsing them
//     into "not passing" is exactly the self-deception the ledger exists to stop,
//     and a scorecard that does it is worse than no scorecard.
//
// Unconfigured ⇒ `available:false` with a reason. Never an empty list pretending
// to be "no verdicts yet"; those two states send the owner to different places.

import { Router } from "express";
import * as dbModule from "../db.js";
import { listVerdicts } from "../lib/bench-ops-client.js";

/** Subject kinds this deployment can own. The bench side is generic; these are
 *  the object families a 壹座 cell actually holds. */
const OWNED_SUBJECT_KINDS = Object.freeze(["pack", "preset", "skill"]);

const VERDICT_LIMIT = 200;

export function createTuningVerdictRoutes(app, ctx = null) {
  // Injection seam, same shape and same reason as the client's `transport=`:
  // the tests must drive every branch (unconfigured / peer refusal / mixed
  // outcomes) without a socket and without a real cell DB. Defaults are the
  // production collaborators.
  const deps = {
    getDb: () => dbModule.getDb(),
    listVerdicts,
    ...(ctx?.benchVerdictDeps ?? {}),
  };

  const resolveUser = (req) =>
    req.user ?? (ctx?.authEnabled ? null : { email: ctx?.cellUserEmail || "owner@local", groups: [] });
  const requireUser = (req, res) => {
    const user = resolveUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return null;
    }
    return user;
  };

  /**
   * `{kind: Set<key>}` of the subjects this cell holds.
   *
   * Ownership is NOT filtered per email for presets and skills, and that is a
   * statement about the storage, not an oversight: `user_presets` and
   * `custom_skills` have no owner column (single-user cell semantics — the
   * hosted deployment gives each user their own cell). Only `skill_candidates`
   * records `proposed_by`, so only that table can be narrowed.
   *
   * Writing `WHERE created_by = ?` against a table that has no such column is
   * how this route's first draft failed; the honest shape is to filter where
   * the data supports it and say so where it does not.
   */
  function ownedSubjects(user) {
    const byKind = { pack: new Set(), preset: new Set(), skill: new Set() };
    const email = String(user?.email ?? "").trim();
    const db = deps.getDb();

    const collect = (sql, kind, params = []) => {
      try {
        for (const row of db.prepare(sql).all(...params)) {
          if (row?.name) byKind[kind].add(String(row.name));
        }
      } catch {
        // An absent table (old cell, auth-off install) contributes nothing.
        // That is an honest empty, not a reason to fail the whole read.
      }
    };

    collect("SELECT name FROM user_presets", "preset");
    collect("SELECT name FROM custom_skills", "skill");
    if (email) {
      collect("SELECT name FROM skill_candidates WHERE proposed_by = ?", "skill", [email]);
    }
    return byKind;
  }

  function benchConfig() {
    const url = String(process.env.BENCH_URL ?? "").trim();
    const token = String(process.env.BENCH_CONSUMER_TOKEN ?? "").trim();
    const domain = String(process.env.BENCH_PROPOSAL_DOMAIN ?? "").trim();
    const missing = [
      ["BENCH_URL", url], ["BENCH_CONSUMER_TOKEN", token], ["BENCH_PROPOSAL_DOMAIN", domain],
    ].filter(([, v]) => !v).map(([k]) => k);
    return { url, token, domain, missing };
  }

  /**
   * Per-subject rollup: latest verdict, its delta against the baseline, and
   * whether it may be compared at all.
   *
   * The three comparison states come straight from the peer's rules, re-derived
   * here only because the peer returns rows, not pairs:
   *   • no baseline recorded        → `no-baseline`  ("this establishes one")
   *   • baseline's digest differs   → `ruler-migrated` ("not comparable")
   *   • same digest                 → `comparable`, with `delta` = pass-count
   *                                   difference, which is the only arithmetic
   *                                   two all-pass verdicts support
   *
   * `delta` is null unless comparable. A number shown next to an incomparable
   * pair is worse than no number: it invites exactly the comparison the digest
   * exists to forbid.
   */
  function summarizeSubjects(rows) {
    const byKey = new Map();
    for (const v of rows) {
      const key = `${v.subject_kind}:${v.subject_key}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(v);
    }
    const out = [];
    for (const [key, list] of byKey) {
      // Rows arrive newest-first from the peer; sort defensively so a feed that
      // changes order does not silently make "latest" mean "first in the page".
      const ordered = [...list].sort((x, y) => Number(y.id) - Number(x.id));
      const latest = ordered[0];
      const baseline = latest.baseline_run_id
        ? ordered.find((r) => Number(r.id) === Number(latest.baseline_run_id)) ?? null
        : null;
      let comparison = "no-baseline";
      let delta = null;
      if (baseline) {
        if (!baseline.ruler_digest || baseline.ruler_digest !== latest.ruler_digest) {
          comparison = "ruler-migrated";
        } else {
          comparison = "comparable";
          delta = Number(latest.n_passed ?? 0) - Number(baseline.n_passed ?? 0);
        }
      }
      out.push({
        subject: key,
        kind: latest.subject_kind,
        key: latest.subject_key,
        version: latest.subject_version,
        latestId: latest.id,
        outcome: latest.outcome,
        provisional: latest.provisional === true,
        baselineId: baseline ? baseline.id : null,
        comparison,
        delta,
      });
    }
    return out;
  }

  const router = Router();
  // Expose the handler map so tests can drive it without an HTTP server. Same
  // technique as the MCP child's exported handlers.
  router.__handlers = {};

  const verdictsHandler = async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;

    const ownedByKind = ownedSubjects(user);
    const ownedCount = Object.values(ownedByKind).reduce((n, set) => n + set.size, 0);
    const cfg = benchConfig();
    if (cfg.missing.length) {
      // Named, not generic: "该面未上线" and "缺哪个环境变量" have different fixes.
      return res.json({
        available: false,
        reason: `未配置 ${cfg.missing.join(", ")}`,
        owned: ownedCount,
        verdicts: [],
        counts: { pass: 0, fail: 0, inconclusive: 0 },
      });
    }

    let listed;
    try {
      listed = await deps.listVerdicts({ limit: VERDICT_LIMIT }, { env: process.env });
    } catch (err) {
      // The peer said something usable (not_deployed / auth / forbidden). Pass it
      // through with its kind so the page can say WHICH fix is needed.
      return res.json({
        available: false,
        reason: String(err?.message ?? err),
        kind: String(err?.kind ?? ""),
        owned: ownedCount,
        verdicts: [],
        counts: { pass: 0, fail: 0, inconclusive: 0 },
      });
    }

    // Filter to the user's own subjects. Rows whose subject_kind is not one of
    // the owned families are dropped rather than matched by key alone: "builder"
    // as a preset key and "builder" as a pack key are different objects.
    const mine = (listed?.verdicts ?? []).filter((v) => {
      const kind = String(v?.subject_kind ?? "");
      // Matching on key alone would merge "builder" the preset with "builder"
      // the pack — different objects, different rulers, same string.
      if (!OWNED_SUBJECT_KINDS.includes(kind)) return false;
      return ownedByKind[kind]?.has(String(v?.subject_key ?? "")) === true;
    });

    // `inconclusive` counted on its own. A scorecard that reports "3 未通过" when
    // two of them merely could not be judged teaches the owner to mistrust the
    // number in the wrong direction.
    const counts = { pass: 0, fail: 0, inconclusive: 0 };
    for (const v of mine) {
      const o = String(v?.outcome ?? "");
      if (o in counts) counts[o] += 1;
    }

    // Separates two very different "nothing to show" states, both measured on
    // production 2026-11-18: the peer held 6 rows and ALL of them were legacy —
    // written before verdicts carried a subject/ruler identity. Reporting that
    // as "you have no verdicts" is technically true and practically misleading:
    // "no evaluations ever ran" and "evaluations ran, but before they had
    // identities" lead the owner to different next steps.
    const peerRows = Array.isArray(listed?.verdicts) ? listed.verdicts : [];
    const unattributed = peerRows.filter(
      (v) => !v?.subject_kind || !v?.subject_key,
    ).length;

    res.json({
      available: true,
      asOf: new Date().toISOString(),
      owned: ownedCount,
      peerRows: peerRows.length,
      unattributed,
      verdicts: mine,
      counts,
      provisionalCount: mine.filter((v) => v?.provisional === true).length,
      subjects: summarizeSubjects(mine),
    });
  };

  router.__handlers.get = { path: "/verdicts", handler: verdictsHandler };
  router.get("/verdicts", verdictsHandler);

  app.use("/api/tuning", router);
}
