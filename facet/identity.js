// Facet identity resolution (add-facet-platform 2.2): one user key, two
// arrival channels. The proxy channel is armed only when the shared internal
// credential is configured AND the request presents it — a forwarded-identity
// header without the token is ignored (spec: forged forwarded identity is
// refused; the public domain must not let anyone mint identities).

import { timingSafeEqual } from "node:crypto";

export function proxyIdentity(req, expectedToken) {
  const got = String(req.headers["x-facet-token"] || "");
  if (!expectedToken || !got || got.length !== expectedToken.length) return null;
  if (!timingSafeEqual(Buffer.from(got), Buffer.from(expectedToken))) return null;
  try {
    const doc = JSON.parse(Buffer.from(String(req.headers["x-facet-user"] || ""), "base64url").toString("utf8"));
    if (typeof doc?.email !== "string" || !doc.email) return null;
    if (!Array.isArray(doc.groups)) return null;
    return { email: doc.email, groups: doc.groups.filter((g) => typeof g === "string") };
  } catch {
    return null;
  }
}

export function createResolveUser({ expectedToken, sessionAuth }) {
  return function resolveUser(req) {
    const viaProxy = proxyIdentity(req, expectedToken);
    if (viaProxy) return viaProxy;
    return sessionAuth ? sessionAuth(req) : null;
  };
}
