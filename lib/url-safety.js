// url-safety.js — the one address judgement every user-influenced destination
// passes through (openspec: add-user-supplied-credentials, design D5).
//
// Why this exists at all: paas had ZERO URL validation. `llm-providers.js`
// only regex-checked the scheme. That was survivable while only an admin could
// type a URL; the moment a user can, the server becomes their proxy into
// private networks and cloud metadata endpoints.
//
// The registry side has this machinery in Python (EGRESS_UPSTREAM_PROFILE, DNS
// pinning). This is the JS twin, and it must stay a twin: a destination the
// registry refuses must not be reachable through paas either.
//
// `100.64.0.0/10` is in the deny list deliberately. It is not a generic
// private range — it is THIS deployment's mesh (the CGNAT block the cluster and
// its datastores sit in; see PORTS.md for the live addresses). The block is the
// RFC 6598 constant, not a host address, so it does not drift when a node moves.
// A generic SSRF library would miss it.

import { lookup } from "node:dns/promises";
import net from "node:net";

export class UrlSafetyError extends Error {
  constructor(message, { kind } = {}) {
    super(message);
    this.name = "UrlSafetyError";
    this.kind = kind ?? "unsafe";
  }
}

// Cloud metadata: the two shapes that matter for this deployment's regions.
const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata"]);
const METADATA_IPS = new Set(["169.254.169.254", "100.100.100.200", "fd00:ec2::254"]);

function ipv4ToInt(ip) {
  return ip.split(".").reduce((acc, oct) => ((acc << 8) + Number(oct)) >>> 0, 0);
}

const DENY_V4 = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "this deployment's mesh"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local / cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.168.0.0", 16, "private"],
  ["192.0.0.0", 24, "IETF protocol assignments"],
  ["198.18.0.0", 15, "benchmarking"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"],
];

function classifyV4(ip) {
  const n = ipv4ToInt(ip);
  for (const [base, bits, why] of DENY_V4) {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((n & mask) === (ipv4ToInt(base) & mask)) return why;
  }
  return null;
}

function classifyV6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower === "::") return "unspecified";
  if (/^f[cd]/.test(lower)) return "unique-local";
  if (/^fe[89ab]/.test(lower)) return "link-local";
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice("::ffff:".length);
    if (net.isIPv4(v4)) return classifyV4(v4);
  }
  return null;
}

/** Classify a literal address; returns the deny reason or null. */
export function classifyIp(ip) {
  if (net.isIPv4(ip)) {
    if (METADATA_IPS.has(ip)) return "cloud metadata";
    return classifyV4(ip);
  }
  if (net.isIPv6(ip)) {
    if (METADATA_IPS.has(ip.toLowerCase())) return "cloud metadata";
    return classifyV6(ip);
  }
  return "not an IP literal";
}

/**
 * Validate a URL that came from (or could be influenced by) a user.
 *
 * @param {string} raw                     the candidate URL
 * @param {object} [opts]
 * @param {boolean} [opts.allowHttp]       permit plain http (dev / localhost deployments)
 * @param {boolean} [opts.resolveHost]     resolve DNS and re-check every address (default true)
 * @param {number}  [opts.timeoutMs]       DNS budget
 * @returns {Promise<{url: URL, addresses: string[]}>}
 * @throws {UrlSafetyError}
 */
export async function assertSafeUrl(raw, { allowHttp = false, resolveHost = true, timeoutMs = 4000 } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new UrlSafetyError("not a valid URL", { kind: "malformed" });
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UrlSafetyError(`scheme ${url.protocol} not allowed`, { kind: "scheme" });
  }
  if (url.protocol === "http:" && !allowHttp) {
    throw new UrlSafetyError("plain http not allowed for user-supplied endpoints", { kind: "scheme" });
  }
  if (url.username || url.password) {
    // Credentials in the URL would be logged and would bypass the field model.
    throw new UrlSafetyError("credentials in the URL are not allowed", { kind: "credentials" });
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");

  if (METADATA_HOSTS.has(host.toLowerCase())) {
    throw new UrlSafetyError("cloud metadata host is not allowed", { kind: "metadata" });
  }
  // Loopback names are refused without a DNS round-trip: they are unambiguous,
  // and a resolver hiccup must not turn a refusal into a pass.
  if (/^(localhost|.*\.localhost)$/i.test(host)) {
    throw new UrlSafetyError(`loopback host ${host} is not allowed`, { kind: "address" });
  }

  // Literal address: judge it directly, no DNS involved.
  if (net.isIP(host)) {
    const why = classifyIp(host);
    if (why) throw new UrlSafetyError(`address ${host} is ${why}`, { kind: "address" });
    return { url, addresses: [host] };
  }

  if (!resolveHost) return { url, addresses: [] };

  // Hostname: resolve now and judge EVERY answer. A name that later resolves
  // somewhere else is caught at use time by calling this again (design D5 —
  // the write-time check alone is not sufficient protection).
  let records;
  try {
    records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), timeoutMs)),
    ]);
  } catch (error) {
    throw new UrlSafetyError(`cannot resolve ${host}: ${error.message}`, { kind: "dns" });
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new UrlSafetyError(`cannot resolve ${host}`, { kind: "dns" });
  }
  const addresses = records.map((r) => r.address);
  for (const addr of addresses) {
    const why = classifyIp(addr);
    if (why) throw new UrlSafetyError(`${host} resolves to ${addr} (${why})`, { kind: "address" });
  }
  return { url, addresses };
}

/**
 * Whether a redirect target may be followed. Same judgement as the initial URL;
 * the caller re-validates instead of trusting the first answer.
 */
export async function assertSafeRedirect(raw, opts) {
  return assertSafeUrl(raw, opts);
}
