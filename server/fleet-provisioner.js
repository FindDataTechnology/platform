// Fleet template provisioner (agent-fleet-templates).
//
// Pure orchestration over the existing single-writer surfaces — fleets-db,
// catalog, clusters store, reconcile — never a direct write into another
// module's storage. Contract (design D3/D4/D5 + unique-post fix):
//   dedup    : a live fleet from the same pack for the same owner returns as-is
//   resolve  : per-post target resolution with per-post degradation — a missing
//              incumbent still gets its POST (vacant, listed in `missing`)
//   conflict : a persona/cluster target already on duty (any live fleet, or an
//              earlier post IN THIS BATCH) never gets a second post — the post
//              is born with an EMPTY targetId sentinel (staffable via swap,
//              listed in `conflicts` with the occupying fleet/post). a2a/tool/
//              bot are exempt (external execution / stateless calls / channel
//              signal sources carry no attribution ambiguity).
//   orchestration : the template's orchestration section lands as the fleet's
//              initial orchestration — refs rewritten to member ids, validated
//              and stored through the SAME write-face path (never a second
//              format); re-provisioning dedups before any write, so the
//              owner's later rewrites are never clobbered
//   paused   : the fleet is created all-paused; materialized tasks park too;
//              the owner starts it explicitly (install never auto-runs)
import { parseFleetTemplate, resolveFleetTemplateParams } from "./fleet-template.js";
import { validateOrchestration } from "./fleet-orchestration.js";
// The pack's `process` axis becomes the pack memory root's policy (add-pack-
// memory-declaration 4.1). Landing a team must never depend on memory being
// reachable, so this call is degrade-open by construction and its outcome is
// reported rather than thrown.
import { landPackMemoryPolicy } from "./pack-memory-policy-landing.js";

// deps: { db, resolveExisting({kind,id}) => boolean|object, rosterPresetId,
//         reconcile(fleetId), catalogAgentIds(): Set<string> }
export async function provisionFleetFromTemplate({
  packId,
  version,
  manifest,
  ownerEmail,
  deps,
  now = Date.now(),
  // 参数槽（agent-fleet-templates delta）：调用者提供 {name: value}；缺省槽
  // 走默认值、必填槽缺失按 params-invalid 如实 422（分类留在 error 字段，
  // 层路由转成口径）。无参数槽的模板 behavior 与落地前逐字节一致。
  params = null,
}) {
  let parsed = parseFleetTemplate(manifest);
  if (!parsed.ok) return { ok: false, error: `invalid fleet template: ${parsed.error}` };
  let template = parsed.template;
  if (template.params) {
    const resolved = resolveFleetTemplateParams(template, params ?? {});
    if (!resolved.ok) {
      return { ok: false, code: "params-invalid", error: "invalid template params", errors: resolved.errors };
    }
    // 结构闸后置：替换后的模板必须自己重新通过整条解析链（cron/形状/编排
    // 各项位置检查都是在 placeholder 处被有意延期的）。
    parsed = parseFleetTemplate({ ...manifest, fleet: resolved.resolved.template });
    if (!parsed.ok) return { ok: false, code: "params-invalid", error: `template params leave an invalid template: ${parsed.error}` };
    template = parsed.template;
  }

  // Dedup anchor (D5): same pack + same owner + still live → the existing
  // fleet is the answer; re-installing a pack must not mint a twin.
  const existing = deps.db.findFleetByTemplate(packId, ownerEmail);
  if (existing) return { ok: true, fleet: existing, deduped: true };

  const missing = [];
  const conflicts = [];
  const resolved = [];
  // Targets claimed by earlier posts of THIS batch — the cross-fleet check
  // below can't see them yet (this fleet doesn't exist), so intra-template
  // duplicates are caught here. Keyed kind:id (persona/cluster ids may
  // collide as strings). a2a never claims.
  const claimed = new Set();

  for (const m of template.members) {
    let targetKind = null;
    let targetId = null;
    let degraded = false;
    let conflict = null;

    if (m.target.kind === "pack-preset") {
      // The pack's own agent, materialized by the install chain — resolve
      // against the live catalog by preset id.
      targetKind = "persona";
      targetId = m.target.presetId;
      if (!deps.catalogAgentIds().has(m.target.presetId)) {
        degraded = true;
      }
    } else if (m.target.kind === "auditor") {
      // 审计官（2026-11-10）：模板能声明它，落地就必须真是它。缺了这一支，
      // targetKind 会回落到 "persona"——模板里的审计官被静默建成普通 persona，
      // 岗位还在、名字还在，但「会唱反调」这件事没了，且没有任何报错。
      // 解析链与 persona 相同（它就是受约束的 persona），差别在工具面与准入。
      targetKind = "auditor";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "persona", id: m.target.id });
    } else if (m.target.kind === "existing-persona") {
      targetKind = "persona";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "persona", id: m.target.id });
    } else if (m.target.kind === "existing-cluster") {
      targetKind = "cluster";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "cluster", id: m.target.id });
    } else if (m.target.kind === "existing-a2a") {
      targetKind = "a2a";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "a2a", id: m.target.id });
    } else if (m.target.kind === "tool") {
      // Tool posts (add-tool-posts / mixed-fleet D4): the target IS the
      // "server::tool" name — routability is judged at resolution time,
      // honestly; a dead server still gets its post (vacant, in `missing`).
      targetKind = "tool";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "tool", id: m.target.id });
    } else if (m.target.kind === "bot") {
      // Bot targets (mixed-fleet D4): a pack bot or an incumbent bot id —
      // resolved against the bots store; a missing instance degrades the post
      // (same philosophy as a2a), never the fleet.
      targetKind = "bot";
      targetId = m.target.id;
      degraded = !deps.resolveExisting({ kind: "bot", id: m.target.id });
    }

    // Unique-post gate (fleet-core D8), same source as the 建岗/swap routes:
    // only LIVE targets can occupy — a degraded target is nobody's incumbent.
    // a2a/tool/bot are exempt (external execution / stateless calls / channel
    // signal sources carry no attribution ambiguity — the manual bot-post
    // route agrees wherever it already knows the kind).
    if (!degraded && targetKind !== "a2a" && targetKind !== "tool" && targetKind !== "bot") {
      const key = `${targetKind}:${targetId}`;
      if (claimed.has(key)) {
        conflict = { occupiedBy: null, intraTemplate: true };
      } else {
        const existing = deps.db.findPostByTarget(targetKind, targetId);
        if (existing) {
          conflict = {
            occupiedBy: {
              fleetId: existing.member.fleetId,
              fleetName: existing.fleet?.name ?? existing.member.fleetId,
              postTitle: existing.member.title,
            },
            intraTemplate: false,
          };
        }
      }
      if (conflict) {
        // Empty-string sentinel: the persona/cluster EXISTS so resolution
        // would succeed — vacancy must be structural. Every other write path
        // (建岗/swap) rejects empty targetIds, so only this path can mint one.
        targetId = "";
      } else {
        claimed.add(key);
      }
    }

    if (degraded) {
      // The post is still created (vacant by targetRef resolution) — the
      // structure is the template's value; the incumbent can be staffed later.
      missing.push({ ref: m.ref, title: m.title, kind: m.target.kind });
    } else if (conflict) {
      // Same degradation philosophy, different cause: the target is alive but
      // holds a post elsewhere. The post carries the template structure and
      // waits for 补岗; the incumbent keeps its single post.
      conflicts.push({ ref: m.ref, title: m.title, kind: m.target.kind, ...conflict });
    }
    resolved.push({
      member: m,
      targetKind: targetKind ?? "persona",
      targetId: targetId ?? m.target.id ?? m.ref,
    });
  }

  const fleet = deps.db.createFleet({
    id: `fleet_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: template.name,
    ownerEmail,
    // All-paused at birth INCLUDING the fleet layer: the cockpit shows the
    // 待启动 banner and the owner's start flips both layers (D3).
    state: "paused",
    sourceTemplate: { packId, version: version ?? null },
  });

  const idByRef = new Map();
  for (const r of resolved) {
    const id = `m_${now}_${Math.random().toString(36).slice(2, 8)}`;
    idByRef.set(r.member.ref, id);
  }
  for (const r of resolved) {
    deps.db.createMember({
      id: idByRef.get(r.member.ref),
      fleetId: fleet.id,
      title: r.member.title,
      parentId: r.member.parentRef ? (idByRef.get(r.member.parentRef) ?? null) : null,
      targetKind: r.targetKind,
      targetId: r.targetId,
      kpiSlots: r.member.kpiSlots ?? [],
      // ALL PAUSED at birth (D3): the owner reviews then starts the fleet.
      cadence: r.member.cadence ? { ...r.member.cadence, enabled: false } : null,
    });
  }

  // Orchestration lands with the fleet (mixed-fleet D3): the template speaks
  // member REFS, the fleet speaks member IDS — rewrite, then validate and
  // store through the SAME write-face path (one validator, one updateFleet
  // column — no second format). Edges reference posts, never the target
  // behind them, so a degraded/vacant post's edges land identically. The
  // dedup return above guarantees re-provisioning never rewrites this.
  let landedFleet = fleet;
  if (template.orchestration) {
    const idOf = (ref) => idByRef.get(ref) ?? ref;
    // A mode/constraints-only section (no edges key) is legal on the live
    // write face — it lands verbatim, no rewrite to attempt.
    const landed = {
      ...template.orchestration,
      ...(Array.isArray(template.orchestration.edges)
        ? {
            edges: template.orchestration.edges.map((e) => ({
              ...e,
              ...(typeof e.from === "string" && e.kind !== "trigger" && e.kind !== "event" ? { from: idOf(e.from) } : {}),
              ...(typeof e.to === "string" && e.kind !== "fanout" ? { to: idOf(e.to) } : {}),
              ...(Array.isArray(e.targets) ? { targets: e.targets.map(idOf) } : {}),
              ...(e.aggregate && typeof e.aggregate.judge === "string" ? { aggregate: { ...e.aggregate, judge: idOf(e.aggregate.judge) } } : {}),
            })),
          }
        : {}),
    };
    const check = validateOrchestration({ members: deps.db.listMembers(fleet.id), orchestration: landed });
    if (!check.ok) {
      return { ok: false, error: `invalid fleet template orchestration: ${check.errors[0].error}`, errors: check.errors };
    }
    landedFleet = deps.db.updateFleet(fleet.id, { orchestration: landed },
      { actor: fleet.ownerEmail ?? null, via: "fleet-provisioner:provisionFleet" }) ?? fleet;
  }

  // Converge the materialized tasks under the paused policy (they park).
  await deps.reconcile(fleet.id);

  // Pack memory policy (add-pack-memory-declaration 4.1): the declaration
  // compiles to ONE document under the pack's memory root — `d-<pack>`, shared
  // by every team landed from this pack, which is the storage's own granularity
  // and not something this change invents. `deps.syncMemoryPolicy` is an
  // injection seam so a test can observe the call without a memory service;
  // when it is absent the real landing runs, and any failure is reported in
  // `memoryPolicy` rather than failing the provision.
  const syncMemoryPolicy = typeof deps.syncMemoryPolicy === "function"
    ? deps.syncMemoryPolicy
    : (args) => landPackMemoryPolicy(args);
  const memoryPolicy = await syncMemoryPolicy({ packId, manifest, liveFleets: 1 }).catch((err) => ({
    ok: false,
    action: "failed",
    reason: String(err?.message ?? err),
  }));

  return {
    ok: true,
    fleet: landedFleet,
    memberIdByRef: Object.fromEntries(idByRef),
    missing,
    conflicts,
    pausedAtBirth: true,
    // Reported, never thrown: memory is a product surface, not a landing
    // dependency. Absent key would leave callers unable to tell "no declaration"
    // from "we did not try".
    memoryPolicy,
  };
}
