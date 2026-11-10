// ── MCP auth capability table (add-universal-keyless-mcp-auth D3) ────────────
//
// Which connection lane a given client build actually honours. Three lanes:
//
//   L1 NATIVE   — the client performs the authorization flow itself from a
//                 pre-registered static client id written into its config.
//                 Nothing secret lands in any file.
//   L2 BROKERED — the CLI performs the flow and writes a short-lived access
//                 token into the client's static Authorization header. Needs no
//                 client-side OAuth support, so it covers every client that
//                 honours static headers — today, all of them.
//   L3 KEY      — the device-flow caller key (facet connect), for headless,
//                 scripted and enterprise-internal use.
//
// Every record MUST carry evidence: the probe that produced it, when, and the
// build it was taken against. A record without evidence is treated as ABSENT,
// never as false — an unevidenced "true" is exactly how the WorkBuddy lane was
// misjudged once already (a spec-level claim treated as a client-level fact).
//
// `stale` is derived at read time: if the installed build differs from the
// build named in the evidence, the record must not be used to pick L1.

export const LANE = Object.freeze({
  NATIVE: "L1",
  BROKERED: "L2",
  KEY: "L3",
});

export const LANE_LABEL = Object.freeze({
  L1: "L1 原生 OAuth（零凭据落盘）",
  L2: "L2 代持令牌（CLI 授权后写短令牌）",
  L3: "L3 调用键（wgk-，headless/CI）",
});

// probe           — script/function that produced the record
// at              — ISO date the probe last ran
// build           — the client build the probe ran against
// oauthClientId   — does the client's config→SDK auth mapping read a static
//                   client id? Established by reading the shipped client code,
//                   not by documentation.
// headerStatic    — does the client send a literal Authorization header from
//                   its config? Established by config-schema + 401→200 roundtrip.
// dcr             — does the client attempt dynamic client registration and
//                   succeed? We have no DCR, so a true here means the client
//                   can use the zero-config path; irrelevant for L1/L2.
export const CAPABILITIES = [
  {
    client: "workbuddy",
    versionRange: "5.9.x",
    headerStatic: true,
    oauthClientId: false,
    dcr: false,
    // 5.9.3 asar: parseMcpServerEntry keeps transport/trust fields only and
    // drops the oauth block; UserMcpProvider's toAuth$2 passes provider:{name}
    // only, so a user-file entry falls back to DCR (which we do not offer).
    // The connector/marketplace-template paths DO read descriptor.oauth.clientId
    // (toConnectorMcpItem → toAuth$1, toDependencyItem → toDependencyAuth) —
    // that is a different loader, not reachable from mcp.json.
    note: "用户级 mcp.json 加载器丢弃 oauth 块（连接器/模板路径才消费）",
    evidence: { probe: "probe-mcp-auth-lanes/static+protocol", at: "2026-10-30", build: "WorkBuddy 5.9.3 (app.asar)" },
  },
  {
    client: "CC",
    versionRange: "*",
    headerStatic: true,
    oauthClientId: null,
    dcr: null,
    note: "支持 --client-id/--callback-port，L1 待真机确认",
    evidence: { probe: "probe-mcp-auth-lanes/static", at: "2026-10-30", build: "claude CLI (header 真机往返)" },
  },
  {
    client: "cursor",
    versionRange: "*",
    headerStatic: true,
    oauthClientId: null,
    dcr: null,
    evidence: { probe: "probe-mcp-auth-lanes/static", at: "2026-10-30", build: "Cursor (header 写读+4001 往返)" },
  },
  {
    client: "zcode",
    versionRange: "*",
    headerStatic: true,
    oauthClientId: null,
    dcr: null,
    evidence: { probe: "probe-mcp-auth-lanes/static", at: "2026-10-30", build: "ZCode (header 写读)" },
  },
  {
    client: "codex",
    versionRange: "*",
    headerStatic: true,
    oauthClientId: null,
    dcr: null,
    evidence: { probe: "probe-mcp-auth-lanes/static", at: "2026-10-30", build: "codex CLI (http_headers 写读)" },
  },
  {
    client: "gemini-cli",
    versionRange: "*",
    headerStatic: true,
    oauthClientId: null,
    dcr: null,
    evidence: { probe: "probe-mcp-auth-lanes/static", at: "2026-10-30", build: "gemini CLI (headers 写读)" },
  },
];

const REQUIRED_EVIDENCE = ["probe", "at", "build"];

/** A record is usable only if it carries complete evidence. */
export function hasEvidence(rec) {
  if (!rec || typeof rec !== "object") return false;
  const ev = rec.evidence;
  if (!ev || typeof ev !== "object") return false;
  return REQUIRED_EVIDENCE.every((k) => typeof ev[k] === "string" && ev[k].trim().length > 0);
}

/**
 * Is this record stale for the installed build?
 * Only compareable when both sides name a build; a record with no version
 * information is usable but cannot license L1 (see selectLane).
 */
export function isStale(rec, installedBuild) {
  if (!installedBuild || !rec?.evidence?.build) return false;
  return !String(rec.evidence.build).includes(String(installedBuild));
}

/** Find the record for a client, optionally pinned to an installed build. */
export function findCapability(client, { installedBuild = null } = {}) {
  const rec = CAPABILITIES.find((c) => c.client === client) ?? null;
  if (!rec) return null;
  return { ...rec, usable: hasEvidence(rec), stale: isStale(rec, installedBuild) };
}

/**
 * Pick a lane. The order is a preference, not a guess:
 *   L1 only with evidence that the client consumes a static client id;
 *   L2 whenever the client honours static headers (verified);
 *   L3 otherwise, or when no browser is available.
 *
 * Returns { lane, reason, record } — the reason is what the CLI prints, so a
 * client-side limitation can never be mistaken for a server-side failure.
 */
export function selectLane(client, { installedBuild = null, hasBrowser = true, hasCallerKey = false } = {}) {
  const rec = findCapability(client, { installedBuild });
  if (!rec) {
    return {
      lane: hasBrowser ? LANE.BROKERED : hasCallerKey ? LANE.KEY : LANE.KEY,
      reason: `客户端「${client}」无能力表记录——按兜底走${hasBrowser ? "代持令牌（L2）" : "调用键（L3）"}`,
      record: null,
    };
  }
  if (!rec.usable) {
    return {
      lane: hasBrowser ? LANE.BROKERED : LANE.KEY,
      reason: `客户端「${client}」能力记录缺证据——不据此选 L1，走${hasBrowser ? "代持令牌（L2）" : "调用键（L3）"}`,
      record: rec,
    };
  }
  if (rec.stale) {
    return {
      lane: hasBrowser ? LANE.BROKERED : LANE.KEY,
      reason: `客户端「${client}」版本与证据不符（证据针对 ${rec.evidence.build}）——降级到${hasBrowser ? "代持令牌（L2）" : "调用键（L3）"}，该版本待复验`,
      record: rec,
    };
  }
  if (rec.oauthClientId === true && hasBrowser) {
    return { lane: LANE.NATIVE, reason: `客户端「${client}」经实证消费静态 client_id——走原生 OAuth（L1），零凭据落盘`, record: rec };
  }
  if (rec.headerStatic === true && hasBrowser) {
    return {
      lane: LANE.BROKERED,
      reason: `客户端「${client}」${rec.oauthClientId === false ? "不消费静态 client_id" : "未证实用原生 OAuth"}、但接受静态 Authorization 头——走代持令牌（L2）`,
      record: rec,
    };
  }
  return { lane: LANE.KEY, reason: `客户端「${client}」无可用免键道——走调用键（L3）`, record: rec };
}
