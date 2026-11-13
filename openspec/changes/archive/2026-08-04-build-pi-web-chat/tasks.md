## 1. Project Setup

- [x] 1.1 Initialize package.json with dependencies: express, ws, @earendil-works/pi-coding-agent, @earendil-works/pi-ai
- [x] 1.2 Create server.js entry point with Express and WebSocket setup
- [x] 1.3 Create public/ directory with index.html, style.css, app.js

## 2. Backend Server

- [x] 2.1 Implement pi agent session creation with in-memory session manager and read-only tools (read, bash, grep, find, ls)
- [x] 2.2 Implement WebSocket connection handler that tracks connected clients
- [x] 2.3 Subscribe to pi session events and forward text_delta, thinking_delta, tool_execution_start, tool_execution_end, and agent_end as JSON to all connected clients
- [x] 2.4 Handle prompt messages from client: forward to session.prompt() with streamingBehavior: "steer" when agent is busy
- [x] 2.5 Serve static files from public/ directory at root path
- [x] 2.6 Add graceful error handling: log API key errors, handle agent errors without crashing

## 3. Frontend UI

- [x] 3.1 Create HTML structure: header with status indicator, scrollable chat area, input area with text field and send button
- [x] 3.2 Style the chat UI: user messages (right-aligned, blue), assistant messages (left-aligned, gray), tool indicators (inline, distinct), thinking blocks (collapsible, muted)
- [x] 3.3 Implement WebSocket client: connect on page load, display connection status, reconnect on disconnect with 2-second delay
- [x] 3.4 Implement message rendering: user messages, streaming text deltas (append to current assistant bubble), tool start/end indicators, thinking blocks
- [x] 3.5 Implement input handling: send on Enter key, send on button click, reject empty/whitespace-only input, disable input while reconnecting
- [x] 3.6 Add auto-scroll: scroll chat area to bottom on new messages and during streaming

## 4. Polish & Launch

- [x] 4.1 Add a clear/reset button to restart the conversation
- [x] 4.2 Test end-to-end: send a prompt, verify streaming text, tool calls, and final response
- [x] 4.3 Add npm start script and verify `node server.js` works