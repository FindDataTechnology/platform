// Stand-in "server" for scripts/test-test-server.mjs: a plain HTTP server that
// never exits on its own. Env switches let tests exercise the teardown ladder:
//   TRAP_TERM=1  ignore SIGTERM (simulates a wedged server → SIGKILL rung)
//   SPAWN_CHILD=1 spawn a child sleeper (simulates a gateway's dsh cell —
//                 dies only if the kill reaches the whole process group)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.TRAP_TERM === "1") process.on("SIGTERM", () => console.log("[sleeper] SIGTERM ignored"));

if (process.env.SPAWN_CHILD === "1") {
  const self = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "test-sleeper.mjs")];
  const child = spawn(process.execPath, self, { stdio: "ignore" });
  console.log(`child ${child.pid}`);
}

const server = createServer((_req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify(server.address())));
