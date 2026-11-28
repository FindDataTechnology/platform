// ── S3 (SigV4) upload — the recording sink (add-ai-native-meeting 4.2) ───────
//
// Recordings land in the deployment's S3-compatible store (RustFS). paas has no
// AWS SDK by policy — the same reason the LiveKit token and the egress client
// are hand-rolled: every SDK is bundle weight in the image and a dependency to
// patch. SigV4 over `node:crypto` is about forty lines and was verified against
// the live RustFS instance before this file existed (PUT of a 1 MiB object →
// 200, and a signed ListBuckets → 200).
//
// SCOPE AND TRUST: credentials stay here, on the platform. The worker holds NO
// storage key — it POSTs audio to a machine-door endpoint and this module writes
// the object. That is the same rule the STT/TTS lane follows: the process that
// touches media is never the process that holds the credential.
import crypto from "node:crypto";

const sha256hex = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const hmac = (key, msg) => crypto.createHmac("sha256", key).update(msg).digest();

/** RFC 3986 encoding SigV4 requires for the canonical URI. */
function uriEncode(str) {
  return String(str)
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * PUT one object.
 *
 * @param {object} args
 * @param {string} args.endpoint    e.g. http://rustfs.internal:9000 (no trailing slash)
 * @param {string} args.bucket
 * @param {string} args.key         object key (may contain slashes)
 * @param {Buffer} args.body
 * @param {string} args.accessKey
 * @param {string} args.secretKey
 * @param {string} [args.region]    default us-east-1 (RustFS accepts any)
 * @param {string} [args.contentType]
 * @param {number} [args.timeoutMs]
 * @returns {Promise<{ok:boolean, status:number, error?:string}>}
 */
export async function s3PutObject({
  endpoint,
  bucket,
  key,
  body,
  accessKey,
  secretKey,
  region = "us-east-1",
  contentType = "application/octet-stream",
  timeoutMs = 60000,
}) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (!base || !bucket || !key) throw new Error("s3PutObject needs endpoint, bucket and key");
  if (!accessKey || !secretKey) throw new Error("s3PutObject needs credentials");

  const u = new URL(base);
  const host = u.host;
  const canonicalUri = `${uriEncode(bucket)}/${uriEncode(key)}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20261125T001234Z
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body);

  // Signed headers, lowercase and sorted — SigV4 is unforgiving about order.
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  // Path-style: `/<bucket>/<key>`. RustFS (like MinIO) is happy with it and it
  // avoids per-bucket DNS, which does not exist on an IP endpoint.
  const canonicalRequest = `PUT\n/${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(Buffer.from(canonicalRequest, "utf8"))}`;

  let signingKey = hmac(Buffer.from(`AWS4${secretKey}`, "utf8"), dateStamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, "s3");
  signingKey = hmac(signingKey, "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/${canonicalUri}`, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization,
      },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return { ok: false, status: r.status, error: String(text).slice(0, 300) };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET one object's bytes. Used by the authorised download path — the bucket is
 * never public, so a non-participant cannot reach the file at all.
 */
export async function s3GetObject({
  endpoint, bucket, key, accessKey, secretKey, region = "us-east-1", timeoutMs = 60000,
}) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (!base || !bucket || !key) throw new Error("s3GetObject needs endpoint, bucket and key");
  const u = new URL(base);
  const host = u.host;
  const canonicalUri = `${uriEncode(bucket)}/${uriEncode(key)}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(Buffer.alloc(0)); // empty body for GET

  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders =
    `host:${host}\n` + `x-amz-content-sha256:${payloadHash}\n` + `x-amz-date:${amzDate}\n`;
  const canonicalRequest = `GET\n/${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256hex(Buffer.from(canonicalRequest, "utf8"))}`;

  let signingKey = hmac(Buffer.from(`AWS4${secretKey}`, "utf8"), dateStamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, "s3");
  signingKey = hmac(signingKey, "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/${canonicalUri}`, {
      headers: {
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, status: r.status, body: Buffer.from(await r.arrayBuffer()) };
  } catch (e) {
    return { ok: false, status: 0, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}
