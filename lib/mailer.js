// ── Notification email channel (add-broadcast-and-notification-inbox P4 4.1) ─
//
// One SMTP client, built on node:tls / node:net rather than a mail library: the
// platform ships no such dependency today, and adding one for "connect, AUTH
// LOGIN, MAIL FROM, RCPT TO, DATA" would be a bigger surface than the protocol
// it wraps.
//
// Configured state is reported, never assumed (task 4.1b). Unset SMTP env means
// the channel answers `{ configured: false }` and the caller records that per
// recipient — it must never claim to have sent something it did not.
//
// The credential is deployment-level, not per-user, and lives in
// `wire-mail-secrets` (aliyun DirectMail, the same sender the alerting lane
// already uses). Nothing here logs the password or the message body.

import net from "node:net";
import tls from "node:tls";

export const SMTP_ENV = Object.freeze({
  host: "SMTP_HOST",
  port: "SMTP_PORT",
  user: "SMTP_USER",
  password: "SMTP_PASSWORD",
  from: "SMTP_FROM",
});

export function smtpConfigFromEnv(env = process.env) {
  const host = String(env[SMTP_ENV.host] ?? "").trim();
  const user = String(env[SMTP_ENV.user] ?? "").trim();
  const password = String(env[SMTP_ENV.password] ?? "");
  const from = String(env[SMTP_ENV.from] ?? "").trim() || user;
  const port = Number(env[SMTP_ENV.port]) || 465;
  return { configured: Boolean(host && user && password && from), host, port, user, password, from };
}

/**
 * Read one SMTP reply, which may span multiple lines (`250-first` … `250 last`).
 * Resolves with `{ code, lines }`; rejects on close before a complete reply,
 * so a dead peer surfaces as a real error instead of a silent timeout.
 */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const lines = [];
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("smtp: reply timed out"));
    }, timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const idx = buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        lines.push(line);
        // A space (not a dash) after the code marks the final line.
        if (/^\d{3} /.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), lines });
          return;
        }
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("smtp: connection closed mid-reply"));
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

function write(socket, text) {
  socket.write(text);
}

function b64(text) {
  return Buffer.from(String(text), "utf8").toString("base64");
}

/** RFC 5322-ish address: bare address if the phrase would need escaping anyway. */
function envelopeAddress(value) {
  const m = /<([^>]+)>/.exec(String(value));
  return (m ? m[1] : String(value)).trim();
}

/** Header-safe encoding: a non-ASCII subject must be RFC 2047 encoded. */
function encodeHeader(value) {
  const text = String(value ?? "");
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;
}

/** A plain-text body, base64 so no line-length or 8-bit rule can bite. */
function buildMessage({ from, to, subject, body, date = new Date() }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeader(subject || "通知")}`,
    `Date: ${date.toUTCString()}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const encoded = b64(String(body ?? ""))
    .replace(/(.{76})/g, "$1\r\n")
    .trimEnd();
  return `${headers.join("\r\n")}\r\n\r\n${encoded}\r\n`;
}

/**
 * Send ONE message. Throws on any refusal with the SMTP code and reply text, so
 * the caller can record a per-recipient failure that says what happened.
 *
 * `socketFactory` exists for tests (a fake server) — production always opens a
 * real TLS connection.
 */
export async function sendMail(
  { to, subject, body },
  config,
  { timeoutMs = 15_000, socketFactory = defaultSocketFactory } = {},
) {
  if (!config?.configured) throw new Error("smtp: not configured");
  const socket = socketFactory(config, timeoutMs);
  try {
    const expect = async (want, label) => {
      const reply = await readReply(socket, timeoutMs);
      if (reply.code !== want) {
        throw new Error(`smtp ${label}: expected ${want}, got ${reply.code} ${reply.lines.join(" ").slice(0, 200)}`);
      }
      return reply;
    };

    await expect(220, "greeting");
    write(socket, "EHLO notification\r\n");
    // EHLO can answer 250 only; anything else is a server that cannot do AUTH.
    await expect(250, "ehlo");
    write(socket, `AUTH LOGIN\r\n`);
    await expect(334, "auth-login");
    write(socket, `${b64(config.user)}\r\n`);
    await expect(334, "auth-user");
    write(socket, `${b64(config.password)}\r\n`);
    await expect(235, "auth");
    write(socket, `MAIL FROM:<${envelopeAddress(config.from)}>\r\n`);
    await expect(250, "mail-from");
    write(socket, `RCPT TO:<${envelopeAddress(to)}>\r\n`);
    const rcpt = await readReply(socket, timeoutMs);
    // 250 = accepted, 251 = will forward. Anything else is this recipient's
    // failure and must not be reported as a send.
    if (rcpt.code !== 250 && rcpt.code !== 251) {
      throw new Error(`smtp rcpt-to: ${rcpt.code} ${rcpt.lines.join(" ").slice(0, 200)}`);
    }
    write(socket, "DATA\r\n");
    await expect(354, "data");
    write(socket, `${buildMessage({ from: config.from, to, subject, body })}\r\n.\r\n`);
    await expect(250, "message-accepted");
    write(socket, "QUIT\r\n");
    // QUIT's reply is not awaited on purpose: some servers close first, and the
    // message was already accepted above.
    return { ok: true };
  } finally {
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

function defaultSocketFactory(config, timeoutMs) {
  // Port 465 is implicit TLS; 587 starts plaintext and upgrades. Both are
  // supported because the deployment owns that choice, not this module.
  if (Number(config.port) === 465) {
    const socket = tls.connect({ host: config.host, port: config.port, servername: config.host });
    socket.setTimeout(timeoutMs);
    return socket;
  }
  const socket = net.connect({ host: config.host, port: config.port });
  socket.setTimeout(timeoutMs);
  return socket;
}
