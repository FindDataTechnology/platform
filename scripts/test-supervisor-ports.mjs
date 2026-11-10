import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { Supervisor } from "../supervisor/lifecycle.js";

function supervisor(serverPort = null) {
  return new Supervisor({
    nodeBin: process.execPath,
    projectRoot: process.cwd(),
    serverPort,
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test("unset desktop port selects a dynamic free port", async () => {
  const instance = supervisor();
  await instance.start();
  try {
    assert.equal(typeof instance.serverPort, "number");
    assert.equal(await instance._portIsFree(instance.serverPort), true);
  } finally {
    await instance.stop();
  }
});

test("configured desktop port is honored", async () => {
  const port = await freePort();
  const instance = supervisor(port);
  await instance.start();
  try {
    assert.equal(instance.serverPort, port);
  } finally {
    await instance.stop();
  }
});

test("configured desktop port conflict fails before fallback", async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
  const instance = supervisor(port);
  try {
    await assert.rejects(instance.start(), new Error(`fixed server port ${port} is already in use`));
    assert.equal(instance.serverPort, port);
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});
