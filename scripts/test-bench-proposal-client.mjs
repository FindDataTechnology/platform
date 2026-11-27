#!/usr/bin/env node
// ── Bench proposal outlet tests (openspec: switch-fleet-proposals-to-domain-inbox §4) ──
//
// The outlet is what decides whether a round's report is trustworthy, so the
// tests pin the things a report can lie about:
//   • a refusal rendered as success (any 4xx must throw, with a usable kind)
//   • new vs idempotent hit conflated (created must survive the round trip)
//   • a machine retry of a human decision (semantic refusals are not retryable,
//     while 5xx/timeout are)
//   • the token leaking into a message or a report
//
// No sockets: the client takes a `transport` seam, and the MCP child is driven
// through toolSubmit with the same seam.
//
//   node --test scripts/test-bench-proposal-client.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const {
  BENCH_DOMAIN_ENV,
  BENCH_FLEET_REF_ENV,
  BENCH_FLEET_TOKEN_ENV,
  BENCH_MODE_ENV,
  BENCH_TOKEN_ENV,
  BENCH_URL_ENV,
  BenchProposalError,
  MODES,
  REFUSALS,
  authHeaders,
  proposalsTarget,
  resolveConfig,
  redact,
  submitProposal,
} = await import("../lib/bench-proposal-client.js");

const TOKEN = "bench-consumer-token-value-0123456789";
const ENV = {
  [BENCH_URL_ENV]: "http://bench.test",
  [BENCH_TOKEN_ENV]: TOKEN,
  [BENCH_DOMAIN_ENV]: "legal",
};

const DRAFT = {
  source: "fleet:fleet_1/post_deployer",
  kind: "company",
  externalKey: "ai-corp",
  body: "AI 公司条目",
  evidence: { url: "https://example.test/a" },
};

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

//: A transport that records the request and answers with one canned response.
function transportOf(status, body) {
  const seen = [];
  const transport = async (req) => {
    seen.push(req);
    return jsonResponse(status, body);
  };
  return { transport, seen };
}

//: 机器面：令牌代表一行登记，`lbk_` 那套头在这里一枚都不该出现。
const FLEET_TOKEN = "lbc_fleet-registration-token-0123456789";
const FLEET_REF = "fleet_1793422472811_i28xac";
const MACHINE_ENV = {
  [BENCH_URL_ENV]: "http://bench.test",
  [BENCH_DOMAIN_ENV]: "legal",
  [BENCH_MODE_ENV]: MODES.MACHINE,
  [BENCH_FLEET_TOKEN_ENV]: FLEET_TOKEN,
  [BENCH_FLEET_REF_ENV]: FLEET_REF,
};
const MACHINE_DRAFT = { ...DRAFT, source: `fleet:${FLEET_REF}/post_deployer` };

// ── 机器面（change bind-bench-proposal-identity-to-credential）────────────────

test("默认仍是会话面：只给会话凭据时地址与头都不变", async () => {
  assert.equal(resolveConfig(ENV).mode, MODES.SESSION);
  assert.equal(proposalsTarget("http://bench.test", "legal"), "http://bench.test/api/d/legal/proposals");
  const { transport, seen } = transportOf(201, { id: 1, state: "pending", external_key: "k" });
  await submitProposal(DRAFT, { env: ENV, transport });
  assert.equal(seen[0].url, "http://bench.test/api/d/legal/proposals");
  assert.equal(seen[0].mode, MODES.SESSION);
  // 会话面绝不出 `x-consumer-token`（那是机器面的头）；本夹具的令牌非 `lbk_` 前缀，
  // 所以它走 Bearer —— 这条同时钉住「模式没有把两套头混起来」。
  const sessionHeaders = authHeaders(seen[0].token, seen[0].mode);
  assert.equal(sessionHeaders["x-consumer-token"], undefined);
  assert.deepEqual(Object.keys(sessionHeaders), ["authorization"]);
});

test("机器面：只发 X-Consumer-Token，且地址走 /api/v1/distribution", async () => {
  const { transport, seen } = transportOf(201, { id: 7, state: "pending", external_key: "k" });
  await submitProposal(MACHINE_DRAFT, { env: MACHINE_ENV, transport });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://bench.test/api/v1/distribution/legal/proposals");
  assert.equal(seen[0].mode, MODES.MACHINE);
  // 这一条是判据的核心：两套面不可互换，同时带两枚头会让「是谁」取决于服务端先看哪个。
  assert.deepEqual(authHeaders(FLEET_TOKEN, MODES.MACHINE), { "x-consumer-token": FLEET_TOKEN });
  assert.equal(authHeaders(FLEET_TOKEN, MODES.MACHINE)["x-api-key"], undefined);
  assert.equal(authHeaders(FLEET_TOKEN, MODES.MACHINE).authorization, undefined);
});

test("机器面缺 BENCH_FLEET_TOKEN：配置类错误且零请求", async () => {
  const env = { ...MACHINE_ENV };
  delete env[BENCH_FLEET_TOKEN_ENV];
  const { transport, seen } = transportOf(201, {});
  await assert.rejects(submitProposal(MACHINE_DRAFT, { env, transport }), (err) => {
    assert.equal(err.kind, REFUSALS.CONFIG);
    assert.match(err.message, /BENCH_FLEET_TOKEN/);
    return true;
  });
  assert.equal(seen.length, 0);
});

test("模式名拼错是配置错误，不许静默退回会话面", () => {
  assert.throws(
    () => resolveConfig({ ...ENV, [BENCH_MODE_ENV]: "machin" }),
    (err) => err.kind === REFUSALS.CONFIG && /machin/.test(err.message),
  );
});

test("自称不是自己：本地拒绝、零请求、消息给出正确的 ref", async () => {
  const { transport, seen } = transportOf(201, {});
  await assert.rejects(
    submitProposal({ ...MACHINE_DRAFT, source: "fleet:fleet_someone_else/post_deployer" }, {
      env: MACHINE_ENV,
      transport,
    }),
    (err) => {
      assert.equal(err.kind, REFUSALS.IDENTITY);
      assert.equal(err.retryable, false);
      assert.match(err.message, new RegExp(`fleet:${FLEET_REF}/`));
      assert.match(err.message, /请求未发送/);
      return true;
    },
  );
  assert.equal(seen.length, 0, "本地判据必须先于网络");
});

test("没给 BENCH_FLEET_REF 时不本地判（把判定留给对端 403）", async () => {
  const env = { ...MACHINE_ENV };
  delete env[BENCH_FLEET_REF_ENV];
  const { transport, seen } = transportOf(403, { detail: "source 必须形如 fleet:x/<post>" });
  await assert.rejects(submitProposal(MACHINE_DRAFT, { env, transport }), (err) => {
    assert.equal(err.kind, REFUSALS.FORBIDDEN);
    return true;
  });
  assert.equal(seen.length, 1);
});

test("机器面的 403 不说「不是本域专家」——该改的是 source", async () => {
  const { transport } = transportOf(403, { detail: "source 必须形如 fleet:fleet_A/<post>" });
  await assert.rejects(submitProposal(MACHINE_DRAFT, { env: MACHINE_ENV, transport }), (err) => {
    assert.equal(err.kind, REFUSALS.FORBIDDEN);
    assert.match(err.message, /机器面拒绝/);
    assert.doesNotMatch(err.message, /expert member/);
    assert.match(err.message, /fleet_A/);
    return true;
  });
});

test("机器面的令牌不出现在拒绝消息里", async () => {
  const { transport } = transportOf(403, { detail: `bad token ${FLEET_TOKEN}` });
  await assert.rejects(submitProposal(MACHINE_DRAFT, { env: MACHINE_ENV, transport }), (err) => {
    assert.ok(!String(err.message).includes(FLEET_TOKEN));
    assert.ok(!String(err.detail).includes(FLEET_TOKEN));
    assert.match(String(err.message), /\[redacted\]/);
    return true;
  });
});

// ── config ───────────────────────────────────────────────────────────────────

test("missing config names the env vars and sends nothing", async () => {
  const { transport, seen } = transportOf(200, {});
  for (const missing of [BENCH_URL_ENV, BENCH_TOKEN_ENV, BENCH_DOMAIN_ENV]) {
    const env = { ...ENV };
    delete env[missing];
    await assert.rejects(
      () => submitProposal(DRAFT, { env, transport }),
      (err) => {
        assert.equal(err.kind, REFUSALS.CONFIG);
        assert.match(err.message, new RegExp(missing));
        assert.equal(err.retryable, false);
        return true;
      },
    );
  }
  assert.equal(seen.length, 0, "a config failure must not reach the network");
});

test("no default domain is ever invented", () => {
  const env = { ...ENV };
  delete env[BENCH_DOMAIN_ENV];
  assert.throws(() => resolveConfig(env), /BENCH_PROPOSAL_DOMAIN/);
});

test("a draft missing its identity is refused before the network", async () => {
  const { transport, seen } = transportOf(200, {});
  await assert.rejects(
    () => submitProposal({ ...DRAFT, externalKey: "  " }, { env: ENV, transport }),
    (err) => err.kind === REFUSALS.CONFIG && /externalKey/.test(err.message),
  );
  assert.equal(seen.length, 0);
});

// ── the happy paths ──────────────────────────────────────────────────────────

test("a new row reports created:true and posts the documented shape", async () => {
  const { transport, seen } = transportOf(200, {
    id: 42,
    state: "pending",
    external_key: "ai-corp",
    evidence_digest: "abc",
    created: true,
  });
  const out = await submitProposal(DRAFT, { env: ENV, transport });
  assert.deepEqual(out, {
    id: 42,
    state: "pending",
    externalKey: "ai-corp",
    evidenceDigest: "abc",
    created: true,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "http://bench.test/api/d/legal/proposals");
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].token, TOKEN);
  assert.deepEqual(Object.keys(seen[0].body).sort(), [
    "body",
    "evidence",
    "external_key",
    "kind",
    "source",
    "submitted_by",
  ]);
});

test("an idempotent hit is created:false, not a failure", async () => {
  const { transport } = transportOf(200, {
    id: 42,
    state: "pending",
    external_key: "ai-corp",
    evidence_digest: "abc",
    created: false,
  });
  const out = await submitProposal(DRAFT, { env: ENV, transport });
  assert.equal(out.created, false);
});

test("a peer without the created flag counts as new, never as a silent hit", async () => {
  const { transport } = transportOf(200, { id: 7, state: "pending" });
  const out = await submitProposal(DRAFT, { env: ENV, transport });
  assert.equal(out.created, true);
});

// ── refusals: each must be its own kind, and none may look like success ──────

const REFUSAL_CASES = [
  [400, { detail: "提案必须携带依据" }, REFUSALS.EVIDENCE, false],
  [400, { detail: "kind 'office' 不在模板 v1 词表内：entity_types=[…]" }, REFUSALS.VOCABULARY, false],
  [400, { detail: "同键已驳回，需新证据" }, REFUSALS.NEEDS_EVIDENCE, false],
  [401, { detail: "invalid api key" }, REFUSALS.AUTH, false],
  [403, { detail: "无该域权限" }, REFUSALS.FORBIDDEN, false],
  [503, { detail: "upstream down" }, REFUSALS.SERVER, true],
];

for (const [status, body, kind, retryable] of REFUSAL_CASES) {
  test(`${status} ${kind} is thrown, classified and ${retryable ? "" : "not "}retryable`, async () => {
    const { transport } = transportOf(status, body);
    await assert.rejects(
      () => submitProposal(DRAFT, { env: ENV, transport }),
      (err) => {
        assert.ok(err instanceof BenchProposalError);
        assert.equal(err.kind, kind);
        assert.equal(err.retryable, retryable);
        assert.equal(err.status, status);
        return true;
      },
    );
  });
}

test("a timeout is retryable and says so", async () => {
  const transport = async () => {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  };
  await assert.rejects(
    () => submitProposal(DRAFT, { env: ENV, transport }),
    (err) => err.kind === REFUSALS.TIMEOUT && err.retryable === true,
  );
});

test("a refused draft leaves no success behind", async () => {
  const { transport } = transportOf(400, { detail: "提案必须携带依据" });
  let returned = null;
  try {
    returned = await submitProposal(DRAFT, { env: ENV, transport });
  } catch {
    // expected
  }
  assert.equal(returned, null, "a 400 must never resolve to a result object");
});

// ── credential discipline ────────────────────────────────────────────────────

test("the token never appears in a refusal message or its detail", async () => {
  // A peer that echoes the credential back (worst case: it put it in an error).
  const { transport } = transportOf(403, {
    detail: `无该域权限 (credential ${TOKEN} is not a member)`,
  });
  await assert.rejects(
    () => submitProposal(DRAFT, { env: ENV, transport }),
    (err) => {
      assert.ok(!err.message.includes(TOKEN), `leaked in message: ${err.message}`);
      assert.ok(!String(err.detail).includes(TOKEN), "leaked in detail");
      // The peer's echo is kept (redacted) — dropping it would hide why a human
      // needs to fix the credential.
      assert.match(err.message, /\[redacted\]/);
      assert.match(err.detail, /\[redacted\]/);
      return true;
    },
  );
});

test("redact refuses to shred on short secrets", () => {
  assert.equal(redact("a text with the word of", "of"), "a text with the word of");
  assert.equal(redact("token abcdefgh1234 here", "abcdefgh1234"), "token [redacted] here");
});

// ── the MCP child ────────────────────────────────────────────────────────────

const { toolSubmit } = await import("../server/bench-proposal-mcp.js");

test("the tool reports 新增 vs 幂等命中 from created", async () => {
  const env = ENV;
  const mk = (created) => ({
    env,
    transport: async () =>
      jsonResponse(200, {
        id: 1,
        state: "pending",
        external_key: "ai-corp",
        evidence_digest: "d",
        created,
      }),
  });
  const fresh = await toolSubmit(
    {
      source: DRAFT.source,
      kind: "company",
      external_key: "ai-corp",
      body: "b",
      evidence: { u: 1 },
    },
    mk(true),
  );
  assert.equal(fresh.isError, undefined);
  const freshBody = JSON.parse(fresh.content[0].text);
  assert.equal(freshBody.created, true);
  assert.equal(freshBody.result, "新增");

  const repeat = await toolSubmit(
    {
      source: DRAFT.source,
      kind: "company",
      external_key: "ai-corp",
      body: "b",
      evidence: { u: 1 },
    },
    mk(false),
  );
  assert.equal(JSON.parse(repeat.content[0].text).result, "幂等命中");
});

test("the tool surfaces a refusal as an error carrying its kind", async () => {
  const out = await toolSubmit(
    {
      source: DRAFT.source,
      kind: "company",
      external_key: "k",
      body: "b",
      evidence: { u: 1 },
    },
    {
      env: ENV,
      transport: async () => jsonResponse(403, { detail: "无该域权限" }),
    },
  );
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /forbidden/);
});

// ── 本轮报告字段（§3.4）─────────────────────────────────────────────────────
//
// A round writes ONE line per draft. The two halves that must never be lost are
// (a) which refusal this was and (b) that the draft is still there. Both are
// asserted as fields, not as prose: a report line is a field read, and a failure
// that renders as "nothing happened" is how a round drops its own product.

test("a refusal comes back as a report-shaped failure that keeps the draft", async () => {
  const out = await toolSubmit(
    { source: DRAFT.source, kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    { env: ENV, transport: async () => jsonResponse(400, { detail: "提案必须携带依据" }) },
  );
  assert.equal(out.isError, true, "a refusal must never render as success");
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.result, "失败");
  assert.equal(body.kind, REFUSALS.EVIDENCE);
  assert.equal(body.retryable, false);
  assert.equal(body.draft_kept, true, "the draft must be reported as still kept");
  assert.match(body.message, /依据/);
});

test("the success and failure report lines share one field set", async () => {
  const ok = await toolSubmit(
    { source: DRAFT.source, kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    {
      env: ENV,
      transport: async () => jsonResponse(200, { id: 1, state: "pending", created: true }),
    },
  );
  const fail = await toolSubmit(
    { source: DRAFT.source, kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    { env: ENV, transport: async () => jsonResponse(500, { detail: "boom" }) },
  );
  const okBody = JSON.parse(ok.content[0].text);
  const failBody = JSON.parse(fail.content[0].text);
  // Both paths parse to an object carrying `result` — a post branches on the
  // value, never on the shape.
  assert.equal(okBody.result, "新增");
  assert.equal(failBody.result, "失败");
  assert.equal(failBody.retryable, true, "5xx stays retryable; the round may re-run it");
});

test("a locally rejected source is also a report-shaped failure", async () => {
  const out = await toolSubmit(
    { kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    { env: ENV, transport: async () => jsonResponse(200, {}) },
  );
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.result, "失败");
  assert.equal(body.kind, "config");
  assert.equal(body.draft_kept, true);
});

// ── 失败纪律（§4.2）──────────────────────────────────────────────────────────

test("同键同依据被驳回是 needs_evidence 且不可重试", async () => {
  // The peer's own words for this case; the round must stop machine-retrying it
  // (new evidence is a human judgement, not something a loop can discover).
  const { transport } = transportOf(400, { detail: "同键已驳回，需新证据" });
  await assert.rejects(
    () => submitProposal(DRAFT, { env: ENV, transport }),
    (err) =>
      err.kind === REFUSALS.NEEDS_EVIDENCE &&
      err.retryable === false &&
      err.status === 400,
  );
});

test("换依据可重提：客户端不按 evidence 拦第二次", async () => {
  // Refusal state is the peer's, not ours — so a second round carrying different
  // evidence must actually reach the network instead of being blocked by a local
  // cache we do not keep. Remembering a human decision locally is how a draft
  // gets stuck forever after one bad round.
  const seen = [];
  const transport = async (req) => {
    seen.push(req);
    return seen.length === 1
      ? jsonResponse(400, { detail: "同键已驳回，需新证据" })
      : jsonResponse(201, { id: 2, state: "pending", created: true });
  };
  await assert.rejects(
    () => submitProposal(DRAFT, { env: ENV, transport }),
    (err) => err.kind === REFUSALS.NEEDS_EVIDENCE,
  );
  const out = await submitProposal(
    { ...DRAFT, evidence: { url: "https://example.test/b" } },
    { env: ENV, transport },
  );
  assert.equal(seen.length, 2, "the second submission must reach the peer");
  assert.equal(out.created, true);
  assert.equal(seen[1].body.evidence.url, "https://example.test/b");
});

test("the failure report line never carries the token", async () => {
  const out = await toolSubmit(
    { source: DRAFT.source, kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    {
      env: ENV,
      transport: async () => jsonResponse(403, { detail: `无该域权限 (${TOKEN})` }),
    },
  );
  assert.equal(out.isError, true);
  assert.ok(!out.content[0].text.includes(TOKEN), "token leaked into the report line");
  assert.match(out.content[0].text, /\[redacted\]/);
});

// ── credential channel ───────────────────────────────────────────────────────

test("an lbk_ key rides X-API-Key and never Bearer", async () => {
  // Live probe 2026-11-08: the child held a valid lbk_ key but the client sent
  // `Authorization: Bearer`, and the peer 401s on a present-but-invalid Bearer
  // instead of falling through to the API key. Exactly one header must go out.
  const { authHeaders } = await import("../lib/bench-proposal-client.js");
  const h = authHeaders("lbk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
  assert.deepEqual(Object.keys(h), ["x-api-key"]);
  assert.equal(h.authorization, undefined, "Bearer must be absent for an api key");
});

test("a non-lbk_ token is treated as a Logto JWT", async () => {
  const { authHeaders } = await import("../lib/bench-proposal-client.js");
  const h = authHeaders("eyJhbGciOiJSUzI1NiJ9.payload.sig");
  assert.deepEqual(Object.keys(h), ["authorization"]);
  assert.equal(h.authorization, "Bearer eyJhbGciOiJSUzI1NiJ9.payload.sig");
  assert.equal(h["x-api-key"], undefined);
});

// ── the shipped config row ───────────────────────────────────────────────────

test("the example row forwards the session and machine vars via envRefs", () => {
  // dsh scrubs the MCP child env of credential-shaped names (KEY/PASSWORD/
  // SECRET/TOKEN), so an ambient BENCH_CONSUMER_TOKEN never reaches the child.
  // envRefs is the only sanctioned hop; a row that drops it degrades to
  // "target not configured" in production while looking correct here.
  const raw = JSON.parse(
    readFileSync(new URL("../mcp.example.json", import.meta.url), "utf8"),
  );
  const row = raw.mcpServers["bench-proposal"];
  assert.ok(row, "mcp.example.json must carry the bench-proposal row");
  assert.deepEqual(row.args, ["server/bench-proposal-mcp.js"]);
  const refs = row.envRefs ?? [];
  // 两套面各一项凭据：会话面（代表一个人）与机器面（代表一行登记）。少一项就是
  // 「切到那个模式后子进程拿不到凭据，而仓里看起来完全正确」。
  for (const name of [
    BENCH_URL_ENV,
    BENCH_DOMAIN_ENV,
    BENCH_TOKEN_ENV,
    BENCH_FLEET_TOKEN_ENV,
    BENCH_FLEET_REF_ENV,
    BENCH_MODE_ENV,
  ]) {
    assert.ok(refs.includes(name), `${name} must be forwarded via envRefs`);
  }
  // A KEY, not the word: the row's own comment explains that this token is an
  // `lbk_`-prefixed api key, so a bare substring check flags the documentation
  // and calls it a leaked credential — which is exactly what happened when
  // that comment landed (2026-11-08). A real key is the prefix plus a token
  // body, and that is what this pins.
  assert.ok(
    !/lbk_[A-Za-z0-9_-]{6,}/.test(JSON.stringify(row)),
    "no credential in the example",
  );
});

test("the tool refuses to invent a source", async () => {
  const out = await toolSubmit(
    { kind: "company", external_key: "k", body: "b", evidence: { u: 1 } },
    { env: ENV, transport: async () => jsonResponse(200, {}) },
  );
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /source is required/);
});
