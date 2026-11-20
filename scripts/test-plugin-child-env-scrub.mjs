// Unit tests — child-env credential scrub (change harden-plugin-supply-gates,
// task 3.3).
// Run: node --test scripts/test-plugin-child-env-scrub.mjs
//
// The build gate refuses platform credentials in DECLARATIONS; this is the
// runtime half. A supplied bundle runs inside the dsh child, so inheriting the
// platform's env would hand it the platform's identity — and make the build gate
// decorative. Before this change only LLM_API_KEY was scrubbed.

import { test } from "node:test";
import assert from "node:assert/strict";

// Import AFTER the module graph is fixed; buildScrubbedEnv reads process.env at
// CALL time, so per-test env mutation is safe here (unlike the path constants).
const { buildScrubbedEnv } = await import("../dsh-profile.js");
const { isPlatformCredentialKey, PLATFORM_CREDENTIAL_KEY_NAMES, PLATFORM_CREDENTIAL_KEY_PREFIXES } = await import(
  "../lib/platform-credential-keys.js"
);

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("platform credential keys are absent from the child env", () => {
  const hostile = {
    FACET_INTERNAL_TOKEN: "facet-secret",
    PACK_USAGE_TOKEN: "usage-secret",
    SUB2API_ADMIN_KEY: "placeholder", // low-entropy on purpose: the real gate this
    // fixture feeds is "is the KEY scrubbed", and a secret-shaped literal here only
    // trips the public-snapshot leak scan (gitleaks generic-api-key).
    MARKET_COOKIE: "cookie",
    LLM_API_KEY: "llm-key",
    LLM_PROVIDER_KEY_ACME: "provider-key",
  };
  withEnv(hostile, () => {
    const env = buildScrubbedEnv();
    assert.ok(env, "a hostile env must produce a scrubbed copy");
    for (const key of Object.keys(hostile)) {
      assert.equal(env[key], undefined, `${key} must not reach the child`);
    }
  });
});

test("only the platform's own keys are removed; everything else survives", () => {
  withEnv({ FACET_INTERNAL_TOKEN: "x", TAVILY_API_KEY: "t", PATH: process.env.PATH ?? "/usr/bin" }, () => {
    const env = buildScrubbedEnv();
    assert.ok(env);
    assert.equal(env.TAVILY_API_KEY, "t", "a server's own API key is not platform material");
    assert.ok(env.PATH, "the child still needs a PATH");
  });
});

test("a clean env returns null (the spawn keeps its inherited env untouched)", () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) {
      if (isPlatformCredentialKey(key)) delete process.env[key];
    }
    assert.equal(buildScrubbedEnv(), null);
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("the matcher covers every declared name and the provider prefix", () => {
  for (const key of PLATFORM_CREDENTIAL_KEY_NAMES) assert.equal(isPlatformCredentialKey(key), true, key);
  for (const prefix of PLATFORM_CREDENTIAL_KEY_PREFIXES) {
    assert.equal(isPlatformCredentialKey(prefix), true);
    assert.equal(isPlatformCredentialKey(`${prefix}_SOMETHING`), true);
  }
  assert.equal(isPlatformCredentialKey("TAVILY_API_KEY"), false);
  assert.equal(isPlatformCredentialKey(""), false);
});
