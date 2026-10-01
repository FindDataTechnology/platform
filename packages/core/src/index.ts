// Public surface of the shared core. Everything the web app and the
// mini-program client import lives behind this single entry so consumers
// never reach into internal layout.

// Protocol contract (server.js ⇄ client).
export * from "./types/ws";

// Injectable transports.
export { configureHttp, http } from "./api/http";
export type { HttpInit, HttpResponse, HttpTransport } from "./api/http";
export { WsClient } from "./ws/client";
export type { WsStatus, SocketFactory, SocketHandle, WsClientOptions } from "./ws/client";

// Chat state machine + wiring seams (platform UI injects the sink).
export { useChatStore, setChatErrorSink, setStoreExposer } from "./store/chat-store";
export type { ConnStatus, Block, Turn } from "./store/chat-store";
// Activity-group derivation for the master collapse (shared by web + MP).
export { groupTurnBlocks, isGroupOpen, groupHasError } from "./store/activity-groups";
export type { ActivityGroup, AssistantTurn } from "./store/activity-groups";
// Scheduled-task store (owns the cron_* events; commands go out via the page's send).
export { useCronStore } from "./store/cron-store";

// REST clients.
export * from "./api/bindings-api";
export * from "./api/bots-api";
export * from "./api/chat-history";
export * from "./api/share-api";
export { httpPublic } from "./api/http";
export * from "./api/documents-api";
export * from "./api/extensions-api";
export * from "./api/llm-api";
export * from "./api/resources-api";
export * from "./api/trace-api";

// The path/href → file-reference rule (web preview drawer + MP file chip).
export * from "./lib/file-ref";
