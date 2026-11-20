// ── personal-domain-map unit tests (widen-deputy-to-personal-domains 1.1-1.3) ─

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DOMAIN_MAP,
  SOURCES,
  activeMappings,
  domainFor,
  normalizeDomainMap,
} from "./personal-domain-map.js";

describe("defaults", () => {
  it("every source is mapped and disabled by default", () => {
    assert.equal(DEFAULT_DOMAIN_MAP.length, 3);
    for (const entry of DEFAULT_DOMAIN_MAP) {
      assert.equal(entry.enabled, false, "an upgrade must not start routing personal matters");
    }
  });

  it("maps the three starting sources to the expected domains", () => {
    const bySource = Object.fromEntries(DEFAULT_DOMAIN_MAP.map((e) => [e.source, e.domain]));
    assert.equal(bySource["cross-line-blocker"], "ops");
    assert.equal(bySource["supplier-thread"], "external-comms");
    assert.equal(bySource["people-schedule"], "advancement");
  });

  it("nothing routes anywhere until enabled", () => {
    for (const source of SOURCES) {
      assert.equal(domainFor(DEFAULT_DOMAIN_MAP, source), null);
    }
    assert.deepEqual(activeMappings(DEFAULT_DOMAIN_MAP), []);
  });
});

describe("normalizeDomainMap", () => {
  it("fills missing entries from the defaults", () => {
    const { ok, map } = normalizeDomainMap([{ source: "people-schedule", enabled: true }]);
    assert.equal(ok, true);
    assert.equal(map.length, 3);
    assert.equal(map.find((e) => e.source === "people-schedule").enabled, true);
    assert.equal(map.find((e) => e.source === "people-schedule").domain, "advancement");
    assert.equal(map.find((e) => e.source === "ops" || e.source === "cross-line-blocker").enabled, false);
  });

  it("rejects an unknown source instead of storing a mapping that never fires", () => {
    const { ok, error } = normalizeDomainMap([{ source: "cross-line-blokcer", enabled: true }]);
    assert.equal(ok, false);
    assert.match(error, /unknown domain-map source/);
  });

  it("rejects an unknown target domain", () => {
    const { ok, error } = normalizeDomainMap([{ source: "supplier-thread", domain: "ext-comms" }]);
    assert.equal(ok, false);
    assert.match(error, /unknown domain in map/);
  });

  it("lets a source be re-pointed to another real domain", () => {
    const { ok, map } = normalizeDomainMap([{ source: "supplier-thread", domain: "advancement", enabled: true }]);
    assert.equal(ok, true);
    assert.equal(domainFor(map, "supplier-thread"), "advancement");
  });

  it("treats a non-boolean enabled as off, never as on", () => {
    const { ok, map } = normalizeDomainMap([{ source: "supplier-thread", enabled: "yes" }]);
    assert.equal(ok, true);
    assert.equal(domainFor(map, "supplier-thread"), null);
  });

  it("rejects a non-array payload", () => {
    assert.equal(normalizeDomainMap({ "cross-line-blocker": "ops" }).ok, false);
  });
});

describe("domainFor", () => {
  it("returns the enabled domain", () => {
    const { map } = normalizeDomainMap([{ source: "cross-line-blocker", enabled: true }]);
    assert.equal(domainFor(map, "cross-line-blocker"), "ops");
  });

  it("returns null for an unknown source and for a disabled one", () => {
    const { map } = normalizeDomainMap([{ source: "cross-line-blocker", enabled: true }]);
    assert.equal(domainFor(map, "nope"), null);
    assert.equal(domainFor(map, "supplier-thread"), null);
  });

  it("activeMappings lists only the live ones", () => {
    const { map } = normalizeDomainMap([
      { source: "cross-line-blocker", enabled: true },
      { source: "supplier-thread", enabled: false },
      { source: "people-schedule", enabled: true },
    ]);
    assert.deepEqual(
      activeMappings(map).map((e) => e.source).sort(),
      ["cross-line-blocker", "people-schedule"],
    );
  });
});
