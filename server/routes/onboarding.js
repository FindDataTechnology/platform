// Intent-onboarding routes (openspec: intent-onboarding). Self-service: the
// questionnaire's answers, the provisioning plan the user confirms, and the
// activation that runs it. Mounted from misc.js next to the roles/layout
// routes; every path is scoped to the REQUESTING identity (the preference
// table is per-cell, and a cell can host several identities).
//
// The role write goes through the same assignment storage the admin surface
// uses (role-system), with one hard rule the self channel enforces: it writes
// business roles only and preserves the existing admin flag verbatim — a
// self-service answer is never a privilege escalation.

import * as packStore from "../../pack-store.js";
import { fetchLatestPackVersion, resolvePackReferences } from "../pack-manifest-source.js";
import { readyRoles } from "../../packages/core/src/lib/recipes.ts";
import {
  buildPlan,
  currentAssignment,
  effectiveIntent,
  needsQuestionnaire,
  selfAssignment,
  validateAnswers,
  writeIntent,
  roleDrift,
  writeSelfAssignment,
} from "../onboarding.js";
import { parseStoredAssignments, resolveAssignment } from "../roles.js";

export function registerOnboardingRoutes(ctx) {
  const { app, db, broadcast } = ctx;

  // 无会话形态（`AUTH_MODE=none`，机房版/桌面版的**唯一**形态）没有 req.user。
  // 以前这里返回 null，于是 `POST /api/onboarding/answers` 一律 400
  // "No identity on the request"，而 `needsQuestionnaire` 只看「答过没有」——
  // 结果：引导页永远跳过不了，**所有设置页被永久挡住**（2026-11-19 真机实测）。
  //
  // 用「本机唯一的主人」这个既有约定补齐：与 `AUTH_MODE=none` 下建团队落
  // `ownerEmail: "owner@local"` 是同一口径，系统里因此只有一套「谁是主人」的直觉。
  // 有会话时行为不变。
  const emailOf = (req) => req.user?.email ?? (ctx.authEnabled ? null : "owner@local");

  // The assignment document writer (single-process deployments only; hosted
  // cells write through the gateway — see writeSelfAssignment).
  const readDoc = () => (db.isDbReady() ? parseStoredAssignments(db.getDeploymentConfig("roles.assignments")) : null);
  const writeAssignment = (email, assignment) => {
    const doc = readDoc() ?? { assignments: {}, default: null };
    const normalized = String(email || "").trim().toLowerCase();
    const neutral = assignment.primary === "standard" && !assignment.secondary.length && !assignment.admin;
    if (neutral) delete doc.assignments[normalized];
    else doc.assignments[normalized] = assignment;
    db.setDeploymentConfig("roles.assignments", JSON.stringify(doc));
  };

  // Build the plan for a role: resolve the recipe's pack REFERENCES (authored
  // display names) to this deployment's ids, then hand the map to buildPlan.
  // The viewer rides along so the market answers with the user's own
  // visibility — an invisible pack resolves to nothing and is reported
  // unavailable rather than failing the run.
  //
  // The first build only supplies the refs to resolve; it is NOT the answer.
  // (Its packs all read "unavailable" — nothing is resolved yet — so its
  // `degraded` flag says nothing about the final plan.)
  const planFor = async (role, viewer) => {
    const installed = db.isDbReady() ? db.listInstalledPacks().map((p) => p.packId) : [];
    const marketplaceOff = process.env.PACK_MARKETPLACE !== "1";
    const skeleton = buildPlan({ role, installed, marketplaceOff });
    if (!skeleton || marketplaceOff || !skeleton.packs.length) return skeleton;
    const resolved = await resolvePackReferences({
      refs: skeleton.packs.map((p) => p.ref),
      viewer,
      localMarket: ctx.localPackMarket ?? null,
    }).catch((e) => {
      console.warn(`[onboarding] pack reference resolution failed: ${e?.message || e}`);
      return {};
    });
    return buildPlan({ role, installed, marketplaceOff, resolved });
  };

  // Profile read: what the questionnaire should render, plus the ready-role
  // list (the server decides readiness — the client never guesses).
  app.get("/api/onboarding/profile", (req, res) => {
    const email = emailOf(req);
    const intent = effectiveIntent({ db, email });
    // Divergence probe (2026-11-16). The questionnaire's answer and the
    // user's business role live in TWO stores — the intent profile is
    // per-cell, the assignment is the gateway's — and nothing used to compare
    // them. A gateway write that failed left `answeredAt` set while the role
    // stayed `standard`, permanently, with no surface able to see it (live
    // case: aloadtree@gmail.com answered [stock, legal] on 2026-10-16 and was
    // still `fallback` a month later; the landing feature then could not
    // explain why a "legal" user landed on /chat).
    //
    // This reports the mismatch so an operator can see it and a retry can be
    // aimed at it. It is deliberately read-only: repairing belongs to the
    // answers route's own path, which re-asserts both halves.
    // `req.user.roles` is this request's RESOLVED assignment (server/auth.js
    // composes it from the gateway's stamped header, else this cell's own
    // store) — the same value /api/config's layout chain reads. Re-resolving
    // here with `resolveAssignment` would read the env again and, under the
    // hosted harness, answer 503; it would also be a second opinion that can
    // disagree with what the page actually rendered.
    const assignment = req.user?.roles ?? { primary: "standard", secondary: [] };
    res.json({
      profile: {
        roles: intent.roles,
        note: intent.note,
        skipped: intent.skipped,
        answeredAt: intent.answeredAt,
        source: intent.source,
      },
      needsQuestionnaire: needsQuestionnaire({ db, email }),
      readyRoles: readyRoles(),
      // The two stores disagree: the answer never reached the role store.
      roleDrift: roleDrift({ intent, assignment }),
    });
  });

  // Answers: profile + role assignments in ONE write. Returns the provisioning
  // plan so the confirmation list the user sees is exactly what would run.
  app.post("/api/onboarding/answers", async (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database unavailable" });
    const result = validateAnswers(req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    const email = emailOf(req);
    if (!email) return res.status(400).json({ error: "No identity on the request" });

    // The build path records intent and NO roles (add-team-building-first-run
    // 4.2). It must not write an assignment, re-resolve the layout, or mark the
    // profile skipped — the door (team-building-first-run) takes over from here.
    if (result.value.wantsTeam) {
      const wantsTeamProfile = {
        roles: [],
        note: result.value.note,
        skipped: false,
        answeredAt: new Date().toISOString(),
        wantsTeam: true,
      };
      writeIntent({ db, email }, wantsTeamProfile);
      return res.json({ role: null, wantsTeam: true, plan: null, layoutPreset: null });
    }

    const profile = {
      roles: result.value.roles,
      note: result.value.note,
      skipped: result.value.skipped,
      answeredAt: new Date().toISOString(),
      wantsTeam: false,
    };

    // Set on the non-skip path; read again when reporting the assignment.
    let hosted = { hosted: false };

    if (!profile.skipped) {
      // Hosted deployments keep assignments in the gateway's store, and its
      // headers outrank anything stored here — so the gateway write is the
      // load-bearing half and comes FIRST. A failure is surfaced rather than
      // stored behind, because a cell-local answer the browser never sees is
      // exactly the silent breakage this path exists to prevent.
      hosted = await writeSelfAssignment({ email, roles: profile.roles }).catch((e) => ({ error: e?.message || String(e) }));
      if (hosted?.error) {
        // Keep the answer, fail the write (2026-11-16). The previous shape
        // threw the whole answer away on a gateway hiccup, so a user who
        // retried later started from an empty questionnaire — and if the
        // write failed without the browser noticing, the profile said
        // "answered: legal" while the role stayed `standard` forever (live
        // case: aloadtree@gmail.com, profile [stock, legal] from 2026-10-16,
        // role still fallback). Storing the intent makes that divergence
        // DETECTABLE (the profile route reports it as `roleDrift`) instead of invisible,
        // and the retry path re-asserts the same roles, so keeping it is
        // never a wrong answer — just an answer whose role write is pending.
        writeIntent({ db, email }, profile);
        console.warn(`[onboarding] gateway role write failed for ${email}: ${hosted.error} (intent kept; role pending)`);
        return res.status(502).json({ error: "Your role selection could not be saved. Please try again." });
      }
      if (!hosted.hosted) {
        // Single-process deployment: this cell IS the authority.
        const current = resolveAssignment({ user: { email }, db });
        writeAssignment(email, selfAssignment(profile.roles, current));
      }
      writeIntent({ db, email }, profile);
    } else {
      writeIntent({ db, email }, profile);
    }

    const primary = result.value.skipped ? currentAssignment({ db, email }).primary : result.value.roles[0];
    res.json({
      profile,
      assignment: result.value.skipped
        ? currentAssignment({ db, email })
        : // The gateway's answer when hosted: it is what the headers will say.
          (hosted?.hosted ? { primary, secondary: profile.roles.slice(1), admin: false } : resolveAssignment({ user: { email }, db })),
      plan: result.value.skipped ? null : await planFor(primary, req.user ?? null),
    });
  });

  // Activation: install the recipe's packs (idempotent), select the recipe's
  // default expert, and report each item's outcome. Add-only: nothing is ever
  // uninstalled, and re-activation with unchanged answers changes nothing.
  app.post("/api/onboarding/provision", async (req, res) => {
    if (!db.isDbReady()) return res.status(503).json({ error: "Database unavailable" });
    const email = emailOf(req);
    if (!email) return res.status(400).json({ error: "No identity on the request" });

    const intent = effectiveIntent({ db, email });
    const role = intent.roles[0];
    if (!role) return res.status(400).json({ error: "Answer the questionnaire first" });
    const viewer = req.user ?? (ctx.authEnabled ? null : { email: ctx.cellUserEmail || "owner@local", groups: [] });
    const plan = await planFor(role, viewer);
    if (!plan) return res.status(400).json({ error: `No recipe for role '${role}'` });
    const results = [];

    for (const item of plan.packs) {
      if (item.status === "installed") {
        results.push({ packId: item.packId, name: item.name, status: "already-installed" });
        continue;
      }
      if (item.status === "unavailable") {
        // The recipe names a pack this deployment cannot resolve for this
        // viewer (absent, or invisible under admission). Reported explicitly
        // so the outcome list is honest, and never fatal to the rest (D5).
        results.push({ packId: null, ref: item.ref, name: item.name, status: "unavailable" });
        continue;
      }
      try {
        const { version, manifest } = await fetchLatestPackVersion({
          packId: item.packId,
          viewer,
          localMarket: ctx.localPackMarket ?? null,
        });
        // The install itself is injectable for the same reason switchAgentTo
        // is: pack-store binds the process-wide db module, so a route test can
        // only exercise this path if the route names the seam.
        const install = ctx.installPackHook ?? packStore.installPack;
        await install({
          packId: item.packId,
          version,
          manifest,
          user: req.user,
          // Server-driven installs carry no interactive acknowledgment; a
          // script-bearing pack answers "script-confirm-required" and is
          // reported as such rather than forced through (the user can install
          // it from the market dialog with the explicit confirm).
          confirm: false,
          hooks: {
            onMcpChanged: () => {
              broadcast({ type: "extensions_changed", resource: "mcp", action: "pack-install", name: manifest?.name || item.packId });
              ctx.dshUpdateMcp?.(ctx.runtimeMcpOverlay, req.user?.groups ?? null, req.user?.email ?? undefined).catch((e) =>
                console.warn(`[onboarding] dsh MCP update failed: ${e.message}`),
              );
            },
            onCatalogChanged: () => {
              broadcast({ type: "catalog_changed" });
              void ctx.syncCatalogAgentPresets?.();
            },
          },
        });
        results.push({ packId: item.packId, name: item.name, status: "installed", version });
      } catch (err) {
        // One failing item never blocks the rest (design D5).
        results.push({
          packId: item.packId,
          name: item.name,
          status: "failed",
          error: err?.message || String(err),
          ...(err?.code ? { code: err.code } : {}),
        });
      }
    }

    if (results.some((r) => r.status === "installed")) {
      await ctx.dshUpdateSkills?.().catch((e) => console.warn(`[onboarding] skills patch update failed: ${e.message}`));
    }

    // Default expert last: the packs' personas must exist before the selection
    // names one. `switchAgent` owns the restart + persistence; a failure here
    // is reported, never fatal to the installs that already landed.
    //
    // Four states, and they MUST NOT be collapsed (add-team-building-first-run
    // 1.5): "this deployment has no such expert" is a DEPLOYMENT SHAPE (a
    // self-hosted cell with no cloud catalog), while "the switch threw" is a
    // FAULT. Reporting both as `failed` leaves a newcomer unable to tell "what
    // should I do" from "the platform is broken". A missing expert substitutes
    // the built-in local agent and says so with both ids.
    let expert = { status: "skipped" };
    if (plan.defaultExpert) {
      const catalogIds = ctx.catalogChatAgentIds?.() ?? null;
      const present = catalogIds ? catalogIds.has(plan.defaultExpert) : null;
      if (present === false && plan.defaultExpert !== "local") {
        // Not in this deployment's merged catalog ⇒ cannot be selected at all.
        // Selecting `local` is the honest substitute (it is always present).
        expert = { status: "substituted", requested: plan.defaultExpert, selected: "local", reason: "expert-not-in-catalog" };
        try {
          let reason = null;
          const switched = await ctx.switchAgentTo?.("local", null, {
            user: viewer,
            onError: (m) => {
              reason = m;
            },
          });
          if (switched === false) {
            expert = { status: "failed", requested: plan.defaultExpert, ...(reason ? { error: reason } : {}) };
          }
        } catch (err) {
          expert = { status: "failed", requested: plan.defaultExpert, error: err?.message || String(err) };
        }
      } else {
        try {
          // No websocket on this channel: the switch applies through the return
          // value and the catalog broadcast (switchAgentTo's `user` option is the
          // actor for the visibility check the socket would otherwise supply;
          // `onError` recovers the reason so a failure is reported, not guessed).
          let reason = null;
          const switched = await ctx.switchAgentTo?.(plan.defaultExpert, null, {
            user: viewer,
            onError: (m) => {
              reason = m;
            },
          });
          expert =
            switched === false
              ? { status: "failed", ...(reason ? { error: reason } : {}) }
              : { status: "selected", id: plan.defaultExpert };
        } catch (err) {
          expert = { status: "failed", error: err?.message || String(err) };
        }
      }
    }

    res.json({ role, results, expert, layoutPreset: plan.layoutPreset });
  });
}
