// ── action-registry unit tests (add-line-boards-and-action-gate) ─────────────

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  filterKnownArgs,
  getAction,
  listActions,
  isRegistered,
  requiredArgsFor,
  riskToTierMap,
  tierForRisk,
  validateArgs,
  RISK,
} from "./action-registry.js";

describe("action-registry", () => {
  it("getAction returns correct entry for known id", () => {
    const action = getAction("facet.pack.publish");
    assert.ok(action);
    assert.equal(action.id, "facet.pack.publish");
    assert.equal(action.line, "facet");
    assert.equal(action.risk, RISK.publish);
    assert.equal(action.target, "cloud");
  });

  it("getAction returns null for unknown id", () => {
    const action = getAction("unknown.action");
    assert.strictEqual(action, null);
  });

  it("listActions filters by line", () => {
    const facetActions = listActions({ line: "facet" });
    assert.equal(facetActions.length, 4);
    facetActions.forEach((a) => { assert.equal(a.line, "facet"); });

    const wanxingActions = listActions({ line: "wanxing" });
    assert.equal(wanxingActions.length, 5);
    wanxingActions.forEach((a) => { assert.equal(a.line, "wanxing"); });
  });

  it("listActions filters by target", () => {
    const cloudActions = listActions({ target: "cloud" });
    // All actions except deploy are cloud-only; deploy has target=any
    assert.ok(cloudActions.length >= 8);
    cloudActions.forEach((a) => {
      assert.ok(a.target === "cloud" || a.target === "any");
    });
  });

  it("isRegistered returns true for registered actions", () => {
    assert.ok(isRegistered("facet.pack.publish"));
    assert.ok(isRegistered("wanxing.agent.deploy"));
  });

  it("isRegistered returns false for unregistered actions", () => {
    assert.ok(!isRegistered("fake.tool"));
  });

  it("riskToTierMap returns all mappings", () => {
    const map = riskToTierMap();
    assert.deepEqual(Object.keys(map).sort(), [
      "cost",
      "destructive",
      "publish",
      "read",
      "write",
    ]);
  });

  it("tierForRisk maps each risk to correct tier", () => {
    assert.equal(tierForRisk(RISK.read), "auto");
    assert.equal(tierForRisk(RISK.write), "inline");
    assert.equal(tierForRisk(RISK.destructive), "second");
    assert.equal(tierForRisk(RISK.cost), "second");
    assert.equal(tierForRisk(RISK.publish), "async");
    assert.equal(tierForRisk("unknown"), "unknown");
  });

  it("all nine v1 actions are present and consistent", () => {
    const expectedIds = [
      "facet.pack.publish",
      "facet.pack.visibility",
      "facet.pack.curation",
      "facet.agent.toggle",
      "wanxing.agent.pause",
      "wanxing.agent.resume",
      "wanxing.callers.add",
      "wanxing.callers.remove",
      "wanxing.agent.deploy",
    ];
    expectedIds.forEach((id) => {
      const action = getAction(id);
      assert.ok(action, `missing action: ${id}`);
      assert.ok(isRegistered(id));
      assert.ok(["read", "write", "destructive", "cost", "publish"].includes(action.risk));
      assert.ok(["cloud", "desktop", "any"].includes(action.target));
      assert.equal(typeof action.impact, "function");
      assert.equal(typeof action.preflight, "function");
    });
  });
});

// ── validate-propose-arg-keys ───────────────────────────────────────────────
// The model's first try was `packId`/`packName` on facet.pack.visibility: the
// keys passed through untouched, the impact read「包「undefined」」and a pending
// row nobody could approve was left behind. These pin the declarations to the
// tools' real parameter names and the normalization that lands the habitual
// spellings on them.

describe("action args declarations", () => {
  it("every action pins its tool's parameter names; required and aliases stay inside them", () => {
    for (const action of listActions()) {
      assert.ok(Array.isArray(action.argKeys) && action.argKeys.length > 0, `${action.id} declares argKeys`);
      for (const key of requiredArgsFor(action.id)) {
        assert.ok(action.argKeys.includes(key), `${action.id}: required ${key} must be a declared key`);
      }
      for (const [key, aliases] of Object.entries(action.argAliases ?? {})) {
        assert.ok(action.argKeys.includes(key), `${action.id}: alias target ${key} must be a declared key`);
        assert.ok(Array.isArray(aliases) && aliases.length > 0, `${action.id}: aliases for ${key}`);
      }
      for (const field of action.userFilledArgs ?? []) {
        assert.ok(!action.argKeys.includes(field.key), `${action.id}: ${field.key} is user-filled, never a model arg`);
      }
    }
  });

  it("filterKnownArgs lands the model's habitual spellings on the tool's names", () => {
    // publish's `packId` spelling is what models reach for; visibility/curation take `id`
    assert.deepEqual(
      filterKnownArgs("facet.pack.visibility", { packId: "p1", packName: "x", visibility: "private" }),
      { id: "p1", visibility: "private" },
    );
    assert.deepEqual(filterKnownArgs("facet.pack.curation", { pack_id: "p1", featured: false }), { id: "p1", featured: false });
    // the verbatim key wins when an alias is also present
    assert.deepEqual(
      filterKnownArgs("facet.pack.visibility", { id: "real", packId: "alias", visibility: "public" }),
      { id: "real", visibility: "public" },
    );
    // wanxing fleet tools are snake_case; camelCase normalizes, extras drop
    assert.deepEqual(filterKnownArgs("wanxing.agent.pause", { packId: "pk", agentId: "ag", note: "x" }), {
      pack_id: "pk",
      agent_id: "ag",
    });
    assert.deepEqual(filterKnownArgs("wanxing.callers.remove", { pack_id: "pk", agent_id: "ag", userId: 7 }), {
      pack_id: "pk",
      agent_id: "ag",
      user_id: 7,
    });
    // and the one camelCase upstream parameter accepts its snake_case twin
    assert.deepEqual(filterKnownArgs("facet.pack.publish", { manifest: { name: "m" }, pack_id: "p1", version: "9" }), {
      manifest: { name: "m" },
      packId: "p1",
    });
  });

  it("validateArgs refuses a missing or blank required key and names the expected keys", () => {
    assert.deepEqual(validateArgs("facet.pack.visibility", { id: "p1", visibility: "private" }), { ok: true });
    const refused = validateArgs("facet.pack.visibility", { packName: "x", visibility: " " });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.missing, ["id", "visibility"]);
    assert.deepEqual(refused.argKeys, ["id", "visibility"]);
    // false and 0 are values, not absences
    assert.deepEqual(validateArgs("facet.agent.toggle", { path: "a/b", enabled: false }), { ok: true });
    assert.deepEqual(validateArgs("wanxing.callers.remove", { pack_id: "pk", agent_id: "ag", user_id: 0 }), { ok: true });
  });

  it("impact text never renders「undefined」for the model's first-try spellings", () => {
    const firstTries = [
      ["facet.pack.visibility", { packId: "p1", packName: "x", visibility: "private" }],
      ["facet.pack.curation", { packId: "p1", category: "finance" }],
      ["facet.pack.publish", { manifest: { name: "m", version: "2" } }],
      ["facet.agent.toggle", { path: "a/b", enabled: true }],
      ["wanxing.agent.pause", { packId: "pk", agentId: "ag" }],
      ["wanxing.agent.resume", { packId: "pk", agentId: "ag" }],
      ["wanxing.callers.add", { packId: "pk", agentId: "ag", email: "u@x.io" }],
      ["wanxing.callers.remove", { pack_id: "pk", agent_id: "ag", userId: 7 }],
      ["wanxing.agent.deploy", { packId: "pk", agentId: "ag", target: "cloud" }],
      ["wire.dataset.create", { name: "ds", csv_content: "a,b\n1,2" }],
      ["wire.dataset.correct", { datasetId: "ds_1", op: "update" }],
    ];
    for (const [id, raw] of firstTries) {
      const args = filterKnownArgs(id, raw);
      assert.deepEqual(validateArgs(id, args), { ok: true }, `${id} passes validation after normalization`);
      const text = getAction(id).impact(args);
      assert.ok(!/undefined/.test(text), `${id} impact leaked undefined: ${text}`);
    }
  });
});
