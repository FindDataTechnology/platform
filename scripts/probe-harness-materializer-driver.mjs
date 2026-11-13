#!/usr/bin/env node
// probe-harness-materializer-driver.mjs — the add-harness-materializer
// production probe's LAPTOP-side driver (tasks 4.2 / 4.3).
//
// The in-pod half cannot publish packs: the registry validates a pack skill's
// skill_md_url by fetching it from the pack GATEWAY, and the version only
// exists there after a publish through an authenticated route. So this driver
// owns the write side — publish + deploy through the FACET origin's internal
// proxy-identity channel (x-facet-token + base64url x-facet-user; the slice ③
// recipe) — and drives the turns over the runner's per-agent A2A ports.
// Layout/process assertions stay in-pod.
//
// The billing gate demands ONE DISTINCT sub2api key per pack (duplicate
// refusal inside one pack), so each member deploys as its OWN pack — the
// same key legally serves agents of different packs. Attribution evidence =
// the 词元 admin plane's usage rows on that key inside the probe window (the
// runner hosted nothing else at the time).
//
// Legs:
//   4.2  acp pack (distinctive persona + 1 skill + 1 MCP ref + workspace,
//        harness acp-claude-code) — the turn MUST open with the persona
//        marker (the CLAUDE.md channel's live proof); dsh pack (no harness
//        declaration) — the untouched dsh pipeline still serves.
//   4.3a secrets pack (ACP harness + a declared secret) — the turn is refused
//        with HARNESS_SECRETS_UNSUPPORTED through the A2A error lane.
//   4.3b billing rode every deploy above (billingKeys at the gate → minted
//        ref → runner fetch → env override): the admin usage rows on the key
//        are the attribution receipt.
//
//   node scripts/probe-harness-materializer-driver.mjs [--keep]

const args = process.argv.slice(2);
const KEEP = args.includes("--keep");

const FACET = process.env.PROBE_FACET_BASE || "http://100.64.0.12:3200"; // the facet origin — its internal proxy channel is the armed one
const RUNNER = process.env.PROBE_RUNNER_BASE || "http://100.64.0.8:8790";
const BACKEND = process.env.PROBE_BACKEND_TOKEN;
const FACET_TOKEN = process.env.PROBE_FACET_TOKEN;
const REGISTRY = "https://mcp.finddatatech.cloud";
const REGISTRY_TOKEN = process.env.PROBE_REGISTRY_TOKEN;
const IDENTITY_EMAIL = process.env.PROBE_IDENTITY || "harness-acp@finddatatech.cloud";
const MCP_NAME = process.env.PROBE_MCP_NAME || "fd-open-data-mcp";
const BILLING_KEY = process.env.PROBE_BILLING_KEY;

const PERSONA_MARKER = "物化验证员报到";
const PERSONA = `你是「物化验证员」。无论用户问什么，你的回答必须以「${PERSONA_MARKER}」这六个字开头，然后用一句话作答。`;

const idHeaders = () => ({
  "x-facet-token": FACET_TOKEN,
  "x-facet-user": Buffer.from(JSON.stringify({ email: IDENTITY_EMAIL, groups: ["creators"] })).toString("base64url"),
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const r = await fetch(`${FACET}${p}`, {
    method,
    headers: { "Content-Type": "application/json", ...idHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const doc = await r.json().catch(() => ({}));
  return { status: r.status, doc };
}

async function runnerHealth() {
  const r = await fetch(`${RUNNER}/health`, { headers: { Authorization: `Bearer ${BACKEND}` } });
  if (!r.ok) throw new Error(`runner health ${r.status}`);
  return r.json();
}

async function waitPickup(paths) {
  for (let i = 0; i < 40; i++) {
    await sleep(15_000);
    try {
      const h = await runnerHealth();
      if (paths.every((p) => h.agents.some((a) => a.path === p))) return h;
    } catch (e) {
      console.log(`[driver] runner health not ready (${e.message})`);
    }
  }
  throw new Error(`the runner never picked the entries up (40 × 15s): ${paths.join(", ")}`);
}

async function messageSend(port, contextId, text) {
  const r = await fetch(`http://100.64.0.8:${port}/`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BACKEND}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: `probe-${Date.now()}`, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text }], context_id: contextId } } }),
  });
  return r.json().catch(() => ({}));
}

const replyText = (doc) => {
  const parts = doc?.result?.message?.parts ?? doc?.result?.parts ?? [];
  return (Array.isArray(parts) ? parts : []).map((p) => p?.text ?? "").join("");
};

async function deployPack(manifest, extraBody = {}) {
  const pub = await api("POST", "/api/packs", { manifest });
  if (pub.status !== 200) throw new Error(`publish failed (${pub.status}): ${JSON.stringify(pub.doc).slice(0, 300)}`);
  const id = pub.doc?.id;
  const version = String(pub.doc?.version ?? "");
  const agentId = manifest.agents[0].id;
  const dep = await api("POST", `/api/packs/${id}/versions/${version}/deploy`, {
    runnerId: "runner-serving",
    billingKeys: { [agentId]: BILLING_KEY },
    ...extraBody,
  });
  const path = dep.doc?.deployed?.[0]?.agentPath ?? `/packs/${id}/${agentId}`;
  if (dep.status === 200) {
    console.log(`[driver] deployed ${agentId}: pack ${id} v${version} → ${path}`);
    return path;
  }
  // Known false negative (live finding 2026-10-15): the registry's register
  // route burns its full 30s card-scan timeout BEFORE nginx cuts the facet's
  // call at 30s — the entry row still lands (and the failed scan auto-DISABLES
  // it, the documented chicken-and-egg). Tolerate the 502/504, confirm the row,
  // re-enable through the toggle's re-probe side effect, and carry on.
  if (dep.status === 502 || dep.status === 504) {
    console.log(`[driver] deploy ${agentId} answered ${dep.status} (scan-timeout false negative) — polling for the row`);
    for (let i = 0; i < 6; i++) {
      await sleep(5_000);
      const r = await fetch(`${REGISTRY}/api/agents${path}`, { headers: { Authorization: `Bearer ${REGISTRY_TOKEN}` } });
      if (r.status === 200) {
        await fetch(`${REGISTRY}/api/agents${path}/toggle?enabled=true`, { method: "POST", headers: { Authorization: `Bearer ${REGISTRY_TOKEN}` } }).catch(() => {});
        console.log(`[driver] deployed ${agentId} (row confirmed + re-enabled): pack ${id} v${version} → ${path}`);
        return path;
      }
    }
    throw new Error(`deploy for ${id} neither answered nor landed (${dep.status})`);
  }
  throw new Error(`deploy failed for ${id} (${dep.status}): ${JSON.stringify(dep.doc).slice(0, 400)}`);
}

async function disable(path) {
  if (KEEP) return;
  await fetch(`${REGISTRY}/api/agents${path}/toggle?enabled=false`, { method: "POST", headers: { Authorization: `Bearer ${REGISTRY_TOKEN}` } }).catch(() => {});
  console.log(`[driver] disabled ${path}`);
}

async function main() {
  if (!BACKEND || !FACET_TOKEN || !REGISTRY_TOKEN || !BILLING_KEY) {
    throw new Error("env PROBE_BACKEND_TOKEN / PROBE_FACET_TOKEN / PROBE_REGISTRY_TOKEN / PROBE_BILLING_KEY required");
  }

  const skill = { name: "mat-probe-skill", description: "物化探针技能", content: "---\nname: mat-probe-skill\ndescription: 物化探针技能——验证 pack 技能落进 claude-code 原生技能目录\n---\n\n# 物化探针技能\n\n这是 add-harness-materializer 的生产验证技能体。\n" };

  // ── 4.2: the acp pack and the dsh pack ─────────────────────────────────────
  const acpPath = await deployPack({
    name: "物化验证·ACP（切片④）", visibility: "private", skills: [skill], mcpServers: [{ registryName: MCP_NAME }],
    agents: [{ id: "acp-member", name: "验证 ACP 物化", persona: PERSONA, serving: { protocol: "a2a", harness: "acp-claude-code", workspace: { enabled: true, quotaMb: 32 } } }],
  });
  const dshPath = await deployPack({
    name: "物化验证·dsh 零回归（切片④）", visibility: "private", skills: [], mcpServers: [],
    agents: [{ id: "dsh-member", name: "验证 dsh 零回归", persona: "你是简洁的助手，一句话作答。", serving: { protocol: "a2a" } }],
  });

  try {
    const health = await waitPickup([acpPath, dshPath]);
    const acpPort = health.agents.find((a) => a.path === acpPath)?.port;
    const dshPort = health.agents.find((a) => a.path === dshPath)?.port;

    const t0 = Date.now();
    const doc = await messageSend(acpPort, "mat-acp", "你是谁？请按你的设定回答。");
    const reply = replyText(doc);
    console.log(`[driver] acp-member turn → ${Math.round((Date.now() - t0) / 1000)}s: ${reply.slice(0, 160).replace(/\n/g, " ")}`);
    if (!reply.includes(PERSONA_MARKER)) {
      throw new Error(`the reply does not carry the persona marker '${PERSONA_MARKER}' — CLAUDE.md did not shape the agent (doc: ${JSON.stringify(doc).slice(0, 300)})`);
    }
    console.log(`[driver] ✓ PERSONA CHANNEL LIVE: the reply opens with the marker`);

    const t1 = Date.now();
    const doc2 = await messageSend(dshPort, "mat-dsh", "用一句话说明这是 dsh 侧的零回归验证。");
    const reply2 = replyText(doc2);
    console.log(`[driver] dsh-member turn → ${Math.round((Date.now() - t1) / 1000)}s: ${reply2.slice(0, 120).replace(/\n/g, " ")}`);
    if (!reply2.trim()) throw new Error(`the dsh member returned no text: ${JSON.stringify(doc2).slice(0, 300)}`);
    console.log(`[driver] ✓ DSH ZERO-REGRESSION`);
  } finally {
    await disable(acpPath);
    await disable(dshPath);
  }

  // ── 4.3a: the secrets refusal through the real error lane ─────────────────
  const secPath = await deployPack({
    name: "物化验证·secrets 拒绝（切片④）", visibility: "private", skills: [], mcpServers: [],
    agents: [{ id: "sec-member", name: "验证 secrets 拒绝", persona: "x", serving: { protocol: "a2a", harness: "acp-claude-code" } }],
  }, { secrets: { "sec-member": { probe_secret: "probe-not-a-real-upstream" } } });
  try {
    const health2 = await waitPickup([secPath]);
    const secPort = health2.agents.find((a) => a.path === secPath)?.port;
    const doc3 = await messageSend(secPort, "mat-sec", "ping");
    const errText = JSON.stringify(doc3?.error ?? doc3);
    console.log(`[driver] secrets turn → ${errText.slice(0, 300)}`);
    if (!/no controlled secrets channel/.test(errText)) {
      throw new Error("the A2A error lane did not surface the secrets refusal text");
    }
    console.log(`[driver] ✓ SECRETS FAIL-CLOSED through the real error lane`);
  } finally {
    await disable(secPath);
  }

  console.log(`\n[driver] ✓ LAPTOP-SIDE LEGS VERIFIED — run the in-pod verifier for layout/process assertions; attribution = 词元 usage rows on the probe key`);
}

try {
  await main();
} catch (e) {
  console.error(`\nDRIVER FAILED: ${e?.message || e}`);
  process.exitCode = 1;
}
