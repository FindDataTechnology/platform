// Tests for the notification email channel (P4 4.1/4.1b).
//
// The properties that matter:
//   · unconfigured is reported as unconfigured — never as a send;
//   · a refused recipient is an error naming the SMTP code, not a silent ok;
//   · a non-ASCII subject is RFC 2047 encoded (otherwise the mail client shows
//     mojibake for every Chinese notification title);
//   · the body is base64'd, so line length and 8-bit rules cannot break it.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { sendMail, smtpConfigFromEnv } from "./mailer.js";

const CONFIG = { configured: true, host: "h", port: 465, user: "u@x", password: "p", from: "u@x" };

/** A scripted SMTP server over an in-memory socket pair. */
function fakeServer({ rcpt = 250, auth = 235 } = {}) {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.write = (data) => {
    const line = String(data).trimEnd();
    script.push(line);
    // Answer the NEXT thing the client sends, driven by what it sent.
    queueMicrotask(() => {
      if (line.startsWith("EHLO")) socket.emit("data", "250-notification\r\n250 AUTH LOGIN\r\n");
      else if (line === "AUTH LOGIN") socket.emit("data", "334 VXNlcm5hbWU6\r\n");
      else if (line === Buffer.from("u@x").toString("base64")) socket.emit("data", "334 UGFzc3dvcmQ6\r\n");
      else if (line === Buffer.from("p").toString("base64")) socket.emit("data", `${auth} ok\r\n`);
      else if (line.startsWith("MAIL FROM")) socket.emit("data", "250 ok\r\n");
      else if (line.startsWith("RCPT TO")) socket.emit("data", `${rcpt} ${rcpt === 250 ? "ok" : "rejected"}\r\n`);
      else if (line === "DATA") socket.emit("data", "354 go\r\n");
      else if (line.endsWith("\r\n.")) socket.emit("data", "250 queued\r\n");
      else if (line === "QUIT") socket.emit("data", "221 bye\r\n");
    });
  };
  const script = [];
  const socketFactory = () => {
    queueMicrotask(() => socket.emit("data", "220 fake smtp\r\n"));
    return socket;
  };
  return { socketFactory, script };
}

test("unconfigured env reports not-configured rather than sending", () => {
  const config = smtpConfigFromEnv({});
  assert.equal(config.configured, false);
  assert.equal(smtpConfigFromEnv({ SMTP_HOST: "h", SMTP_USER: "u@x", SMTP_PASSWORD: "p" }).configured, true);
  // A from that falls back to the user is still configured.
  assert.equal(smtpConfigFromEnv({ SMTP_HOST: "h", SMTP_USER: "u@x", SMTP_PASSWORD: "p" }).from, "u@x");
});

test("sendMail: not configured throws by name, before opening a socket", async () => {
  await assert.rejects(() => sendMail({ to: "a@x", subject: "s", body: "b" }, smtpConfigFromEnv({})), /not configured/);
});

test("sendMail: a full handshake sends and returns ok", async () => {
  const { socketFactory, script } = fakeServer();
  const out = await sendMail({ to: "a@x", subject: "变更通知", body: "正文" }, CONFIG, { socketFactory });
  assert.equal(out.ok, true);
  const all = script.join("\n");
  assert.match(all, /^EHLO/m);
  assert.match(all, /^MAIL FROM:<u@x>$/m);
  assert.match(all, /^RCPT TO:<a@x>$/m);
  // The subject is RFC 2047 encoded (non-ASCII), and the body is base64.
  assert.match(all, /Subject: =\?UTF-8\?B\?/);
  assert.ok(all.includes(Buffer.from("正文").toString("base64")).valueOf());
});

test("sendMail: a rejected recipient throws with the SMTP code (never a silent ok)", async () => {
  const { socketFactory } = fakeServer({ rcpt: 550 });
  await assert.rejects(
    () => sendMail({ to: "a@x", subject: "s", body: "b" }, CONFIG, { socketFactory }),
    /smtp rcpt-to: 550/,
  );
});

test("sendMail: a bad auth answers a real error, not a timeout", async () => {
  const { socketFactory } = fakeServer({ auth: 535 });
  await assert.rejects(
    () => sendMail({ to: "a@x", subject: "s", body: "b" }, CONFIG, { socketFactory }),
    /smtp auth: expected 235, got 535/,
  );
});
