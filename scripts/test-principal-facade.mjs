#!/usr/bin/env node
// Test script for the principal facade profile (add-principal-facade)
// Covers the manifest `facade` block validation: shape, in-pack references,
// delegation list bounds, stance, and the no-block-unchanged guarantee.

import { validatePackManifest } from "../lib/pack-manifest.js";

console.log("=== Principal Facade Manifest Validation Tests ===\n");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  Error: ${err.message}`);
    failed++;
  }
}

// A minimal valid facade manifest, cloned per test so mutations stay local.
function facadeManifest(overrides = {}) {
  return {
    name: "寻数门面",
    description: "和寻数聊：企业、项目、产品能力",
    skills: [
      { name: "corpus-company", description: "企业语料", content: "# 企业" },
      { name: "corpus-projects", description: "项目语料", content: "# 项目" },
    ],
    agents: [
      {
        id: "reception",
        name: "寻数接待",
        persona: "你是寻数的接待角色",
        serving: { protocol: "a2a" },
      },
    ],
    facade: {
      reception: "reception",
      corpus: ["corpus-company", "corpus-projects"],
    },
    ...overrides,
  };
}

function expectError(manifest, needle) {
  const errors = validatePackManifest(manifest);
  const hit = errors.some((e) => e.error.includes(needle));
  if (!hit) {
    throw new Error(`expected an error containing '${needle}', got: ${JSON.stringify(errors)}`);
  }
}

// ── Valid shapes ─────────────────────────────────────────────────────────────

test("Valid facade block passes (minimal: reception + corpus)", () => {
  const errors = validatePackManifest(facadeManifest());
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

test("Valid facade with delegation list (in-pack + a2a) and explicit stance", () => {
  const m = facadeManifest();
  m.agents.push({ id: "specialist", name: "专家", persona: "专家角色", serving: { protocol: "a2a" } });
  m.facade.delegation = [
    { kind: "in-pack", ref: "specialist" },
    { kind: "a2a", ref: "packs/doc-studio/v2/researcher" },
  ];
  m.facade.stance = "hosted";
  const errors = validatePackManifest(m);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

test("Empty delegation array is legal (pure reception)", () => {
  const m = facadeManifest();
  m.facade.delegation = [];
  const errors = validatePackManifest(m);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

// ── Shape violations ─────────────────────────────────────────────────────────

test("Non-object facade rejected", () => {
  expectError(facadeManifest({ facade: "yes" }), "facade must be an object");
});

test("Unknown facade key rejected with the allowlist", () => {
  const m = facadeManifest();
  m.facade.identity = "官方寻数";
  expectError(m, "facade has unknown key 'identity' (only reception, corpus, delegation, stance)");
});

// ── Reception ────────────────────────────────────────────────────────────────

test("Reception referencing a missing agent rejected", () => {
  const m = facadeManifest();
  m.facade.reception = "ghost";
  expectError(m, "facade.reception references 'ghost', which is not declared in manifest.agents");
});

test("Reception without a serving contract rejected", () => {
  const m = facadeManifest();
  m.agents[0].serving = undefined;
  expectError(m, "must carry a serving contract");
});

// ── Corpus ───────────────────────────────────────────────────────────────────

test("Empty corpus rejected", () => {
  const m = facadeManifest();
  m.facade.corpus = [];
  expectError(m, "facade.corpus must be a non-empty array");
});

test("Corpus referencing a foreign skill rejected", () => {
  const m = facadeManifest();
  m.facade.corpus = ["corpus-company", "not-in-pack"];
  expectError(m, "facade.corpus references 'not-in-pack', which the pack itself does not declare in skills");
});

test("Duplicate corpus entry rejected", () => {
  const m = facadeManifest();
  m.facade.corpus = ["corpus-company", "corpus-company"];
  expectError(m, "facade.corpus declares 'corpus-company' twice");
});

// ── Delegation ───────────────────────────────────────────────────────────────

test("Illegal delegation kind rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = [{ kind: "cluster", ref: "x" }];
  expectError(m, "delegation kind must be one of in-pack, a2a");
});

test("Delegation entry with unknown key rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = [{ kind: "a2a", ref: "x", note: "why" }];
  expectError(m, "delegation entry has unknown key 'note' (only kind, ref)");
});

test("In-pack delegation referencing a missing agent rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = [{ kind: "in-pack", ref: "ghost" }];
  expectError(m, "in-pack delegation references 'ghost', which is not declared in manifest.agents");
});

test("Reception self-delegation rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = [{ kind: "in-pack", ref: "reception" }];
  expectError(m, "the reception role may not delegate to itself");
});

test("Duplicate (kind, ref) delegation pair rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = [
    { kind: "a2a", ref: "same-target" },
    { kind: "a2a", ref: "same-target" },
  ];
  expectError(m, "delegation declares 'same-target' (a2a) twice");
});

test("Delegation list over the ceiling rejected", () => {
  const m = facadeManifest();
  m.facade.delegation = Array.from({ length: 9 }, (_, i) => ({ kind: "a2a", ref: `t-${i}` }));
  expectError(m, "facade.delegation must be an array of at most 8 entries");
});

test("a2a ref accepts path-shaped market references", () => {
  const m = facadeManifest();
  m.facade.delegation = [{ kind: "a2a", ref: "packs/doc-studio/v2/researcher" }];
  const errors = validatePackManifest(m);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

// ── Stance ───────────────────────────────────────────────────────────────────

test("Non-hosted stance rejected in v1", () => {
  const m = facadeManifest();
  m.facade.stance = "caller-pays";
  expectError(m, 'facade.stance must be "hosted" when present (v1)');
});

// ── No-block guarantee ───────────────────────────────────────────────────────

test("A manifest without the facade block validates exactly as before", () => {
  const m = facadeManifest();
  delete m.facade;
  const errors = validatePackManifest(m);
  if (errors.length > 0) {
    throw new Error(`Expected no errors, got: ${JSON.stringify(errors)}`);
  }
});

test("An invalid pack is invalid with and without the facade block identically", () => {
  const broken = facadeManifest();
  broken.name = "";
  delete broken.facade;
  const without = JSON.stringify(validatePackManifest(broken));
  const withBlock = JSON.stringify(validatePackManifest(facadeManifest({ ...broken, facade: facadeManifest().facade })));
  // The message stays the contract; the validator's stable error-code pass
  // (add-agent-builder-workspace) may add a `code` field beside it, so the
  // baseline matches on the message rather than the exact JSON shape.
  if (!without.includes("name must be a non-empty string of at most 80 characters")) {
    throw new Error(`unexpected baseline errors: ${without}`);
  }
  // The facade block itself is valid, so adding it changes nothing here.
  if (without !== withBlock) {
    throw new Error(`facade block altered unrelated errors: ${withBlock}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
