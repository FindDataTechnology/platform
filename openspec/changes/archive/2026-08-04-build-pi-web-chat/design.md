## Context

pi-agent is a terminal-based coding agent with an SDK (`@earendil-works/pi-coding-agent`) that provides programmatic access. The goal is to wrap it in a web server so users can interact with pi through a browser chat interface. The project is greenfield — no existing codebase.

## Goals / Non-Goals

**Goals:**
- Provide a real-time chat UI accessible from any browser
- Stream agent responses, tool calls, and thinking output via WebSocket
- Support multi-turn conversation with a single pi session
- Keep the stack minimal: Express + ws + vanilla HTML/CSS/JS

**Non-Goals:**
- Multi-user authentication or session persistence
- File system browsing (the agent works in the server's cwd)
- Mobile-optimized responsive design
- Production deployment hardening

## Decisions

### 1. Express + ws over a full-stack framework

**Choice:** Plain Express with `ws` for WebSocket, vanilla HTML/CSS/JS for frontend.

**Why:** Zero build step, single `node server.js` to run. The pi SDK is already Node.js, so adding a framework like Next.js would add unnecessary complexity. Vanilla frontend avoids bundlers and lets users hack on the UI directly.

**Alternatives considered:** Next.js (too heavy for a demo), Vite (adds build step), Python/FastAPI (can't use pi SDK directly).

### 2. Single in-memory session per server instance

**Choice:** One `AgentSession` created at server startup, shared across all WebSocket connections.

**Why:** Simplest model. The user opens one browser tab and chats. No need for session management, auth, or multi-tenancy. The `SessionManager.inMemory()` avoids file I/O.

**Trade-off:** All browser tabs share the same conversation. Clear on disconnect? Acceptable for a demo.

### 3. WebSocket for streaming, REST for health check

**Choice:** All chat communication goes over a single WebSocket connection. A simple GET `/` serves the static page.

**Why:** pi's SDK emits events (text_delta, tool_execution_start, etc.) that map naturally to WebSocket messages. No need for SSE or polling.

**Protocol:** JSON messages with `{ type: "prompt", text: "..." }` from client, `{ type: "text", delta: "..." }`, `{ type: "tool_start", name: "..." }`, etc. from server.

### 4. Read-only tools by default

**Choice:** Expose only `read`, `bash`, `grep`, `find`, `ls` tools.

**Why:** A web-exposed agent should not write or edit files by default. Users can modify `server.js` to enable `edit`/`write` if they trust their environment.

## Risks / Trade-offs

- **Tool execution in server cwd** → Agent can read any file the server process can access. Mitigation: run the server in a sandboxed directory or container.
- **No authentication** → Anyone on the network can use the agent. Mitigation: bind to `localhost` only by default.
- **Single session, no persistence** → Refresh loses conversation. Mitigation: acceptable for v1 demo; session persistence can be added later.
- **WebSocket reconnection** → Client reconnects on disconnect but loses event stream context. Mitigation: simple reconnect logic in frontend.