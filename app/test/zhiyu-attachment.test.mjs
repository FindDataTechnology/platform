// App room-attachment transport (openspec: zhiyu-room-attachments-and-voice).
//
// The mini-program and the app reach the SAME server door, and the shared state
// machine in @platform/core is covered by scripts/test-zhiyu-attachment-
// contract.mjs. What only THIS file can pin is the app's own byte transport:
//
//   • RN's FormData takes a {uri,name,type} descriptor, not a Blob — the wrong
//     shape uploads the literal "[object Object]" and the server stores garbage,
//     while typechecking and passing every lint rule;
//   • a refusal must throw with the server's message, because the composer
//     shows it as the chip's failure reason;
//   • the route carries the escaped room id, exactly once.
//
// It imports the SHIPPED transport module (Node strips the types) rather than
// re-implementing it — a copy would pass while the real call site was wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const { attachmentFormEntry, readUploadResult, roomAttachmentPath, e2eAttachmentPath, e2ePickedFile } = await import(
  path.join(ROOT, "src", "lib", "room-attachment-transport.ts")
);

test("the FormData entry is the RN descriptor triple, never a Blob", () => {
  const entry = attachmentFormEntry({ uri: "file:///tmp/a.pdf", name: "a.pdf", mimeType: "application/pdf" });
  assert.deepEqual(entry, { uri: "file:///tmp/a.pdf", name: "a.pdf", type: "application/pdf" });
  assert.ok(!(entry instanceof Blob), "a Blob here uploads [object Object] on a device");
});

test("a missing mimeType still sends a concrete type", () => {
  assert.equal(attachmentFormEntry({ uri: "u", name: "n" }).type, "application/octet-stream");
});

test("the room id is escaped into the path, exactly once", () => {
  assert.equal(roomAttachmentPath("zy_a/b c"), "/api/zhiyu/rooms/zy_a%2Fb%20c/attachments");
  // Already-encoded input must not become double-encoded by a second pass.
  assert.equal(roomAttachmentPath("zy_x"), "/api/zhiyu/rooms/zy_x/attachments");
});

test("a refusal throws the server's message (the chip shows it)", () => {
  assert.throws(() => readUploadResult({ ok: false, status: 413, body: { error: "房间附件总量已达上限" } }), /房间附件总量已达上限/);
});

test("an ok response without an attachment is a failure, not a silent success", () => {
  assert.throws(() => readUploadResult({ ok: true, status: 201, body: {} }), /HTTP 201/);
});

test("a shape-valid answer passes through", () => {
  const out = readUploadResult({ ok: true, status: 201, body: { attachment: { id: "att_1", status: "ready" } } });
  assert.equal(out.id, "att_1");
});

test("the app room page calls the shared machine and this transport", async () => {
  const page = await readFile(path.join(ROOT, "src", "app", "(tabs)", "zhiyu", "[roomId].tsx"), "utf8");
  assert.match(page, /applyAttachmentEvent/, "uses the shared state machine");
  assert.match(page, /attachmentCardModel/, "uses the shared card model");
  assert.match(page, /uploadRoomAttachment/, "uploads through the one transport");
  assert.match(page, /app-zy-attach/, "renders the attach control");
  assert.doesNotMatch(page, /state:\s*"(uploading|ready|opaque|failed)"\s*\|/, "must not declare its own state union");

  const api = await readFile(path.join(ROOT, "src", "lib", "zhiyu-api.ts"), "utf8");
  assert.match(api, /attachmentFormEntry\(opts\.file\)/, "the api builds the descriptor through the shared helper");
  assert.match(api, /roomAttachmentPath\(opts\.roomId\)/, "and the path through the shared helper");
});

// ── the picker seam (EXPO_PUBLIC_E2E_ATTACHMENT) ────────────────────────────
// The seam exists only because Maestro cannot drive Android's chooser. These
// assertions keep it from becoming a second behaviour: unset ⇒ null (production
// keeps the real picker), set ⇒ that exact path, and nothing about the upload
// changes either way.

test("the seam is OFF unless the env var is set", () => {
  assert.equal(e2eAttachmentPath({}), null);
  assert.equal(e2eAttachmentPath({ EXPO_PUBLIC_E2E_ATTACHMENT: "   " }), null, "whitespace is not a path");
});

test("the seam returns exactly the configured path", () => {
  assert.equal(e2eAttachmentPath({ EXPO_PUBLIC_E2E_ATTACHMENT: "/data/fixture.txt" }), "/data/fixture.txt");
});

test("an e2e picked file is a plain text fixture with a real name", () => {
  const f = e2ePickedFile("/tmp/maestro-fixture.txt");
  assert.equal(f.uri, "/tmp/maestro-fixture.txt");
  assert.equal(f.name, "maestro-fixture.txt", "the name comes from the path, not a fake");
  assert.equal(f.mimeType, "text/plain");
});

test("the page takes the seam only when it is set (production keeps the picker)", async () => {
  const page = await readFile(path.join(ROOT, "src", "app", "(tabs)", "zhiyu", "[roomId].tsx"), "utf8");
  assert.match(page, /e2eAttachmentPath\(\)/, "asks the seam");
  assert.match(page, /DocumentPicker\.getDocumentAsync/, "and keeps the real picker as the fallback");
});
