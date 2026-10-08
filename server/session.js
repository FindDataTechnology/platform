import path from "node:path";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const STATE_TTL_MS = 10 * 60 * 1000;

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function mac(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function validSignature(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = value;
  }
  return cookies;
}

export function signSession(payload, secret) {
  const body = encode(payload);
  return `${body}.${mac(body, secret)}`;
}

export function verifySignedCookie(value, secret, now = Date.now()) {
  if (typeof value !== "string") return null;
  const index = value.lastIndexOf(".");
  if (index < 1) return null;
  const body = value.slice(0, index);
  const signature = value.slice(index + 1);
  if (!validSignature(signature, mac(body, secret))) return null;
  const payload = decode(body);
  if (!payload || typeof payload !== "object") return null;
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) return null;
  return payload;
}

export function verifySessionCookie(value, secret, now = Date.now()) {
  const payload = verifySignedCookie(value, secret, now);
  if (!payload) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;
  if (!Array.isArray(payload.groups) || payload.groups.some((g) => typeof g !== "string")) return null;
  return payload;
}

async function readOrCreateSecret(file, secret) {
  try {
    await writeFile(file, secret, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(file, 0o600).catch(() => {});
}

export async function resolveSessionSecret({ env = process.env, dataDir = env.PLATFORM_DATA_DIR || "" } = {}) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  const dir = dataDir ? path.join(dataDir, "auth") : path.join(path.resolve("auth"));
  const file = path.join(dir, "session-secret");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const secret = randomBytes(32).toString("base64url");
    await readOrCreateSecret(file, secret);
    return secret;
  }
}

export function sessionCookie(name, payload, secret, ttlMs, secure = false) {
  const expires = new Date(Date.now() + ttlMs);
  const secureFlag = secure ? "; Secure" : "";
  return `${name}=${signSession(payload, secret)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secureFlag}`;
}

export function clearCookie(name, secure = false) {
  const secureFlag = secure ? "; Secure" : "";
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT${secureFlag}`;
}

export { STATE_TTL_MS };
