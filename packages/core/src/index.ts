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
export {
  groupTurnBlocks,
  isGroupOpen,
  groupHasError,
  groupHasPendingAsk,
  groupHasPendingAction,
  groupHasPendingInput,
  isInputRequestBlock,
  inputRequestStateOf,
  isProposeActionBlock,
  proposalStateOf,
} from "./store/activity-groups";
export type { ActivityGroup, AssistantTurn } from "./store/activity-groups";
// Chart-fence contract (capture ⇄ badge correlation, add-artifact-delivery).
export { extractChartFences, canonicalChartHash, chartHashesInText } from "./lib/chart-fence";
// Tool-call path extraction (preview affordance + turn artifact strip).
export {
  resolveCopilotCard,
  mergeCopilotCard,
  parseCopilotCardsEnv,
  surfaceMountsDock,
  BUILTIN_COPILOT_CARD,
  COPILOT_SURFACES,
} from "./lib/copilot-card";
export type {
  CopilotCard,
  CopilotCardPatch,
  CopilotSurface,
  CopilotShell,
  CopilotTools,
} from "./lib/copilot-card";
export { producedFilePaths } from "./lib/file-tool-paths";
export { fileLinkRef, fileRefPath } from "./lib/file-ref";
export type { FileRef } from "./lib/file-ref";
// Scheduled-task store (owns the cron_* events; commands go out via the page's send).
export { useCronStore } from "./store/cron-store";

// Recording state machine shared by web / mini-program / app (openspec:
// add-voice-input-mobile). DOM-free: each client injects a recorder adapter.
export {
  VoiceRecorder,
  composeTranscript,
  VOICE_MAX_UPLOAD_BYTES,
  estimateVoiceBytes,
  voiceFitsUpload,
} from "./voice-recorder";
export type {
  VoicePhase,
  VoiceErrorCode,
  VoiceFailure,
  RecordedTake,
  RecorderAdapter,
  VoiceRecorderOptions,
} from "./voice-recorder";

// Long-recording slicing + retry plan shared by web / mini-program / app
// (openspec: add-voice-capture-lane). DOM-free, like the recorder above.
export {
  CAPTURE_MAX_ATTEMPTS,
  planSlices,
  slicesCoverTotal,
  sliceAction,
  captureProgress,
  pendingSlices,
  captureComplete,
  formatOffset,
  exportCaptureText,
} from "./voice-capture-slices";
export type { CaptureSlice, SliceAction, SliceState, CaptureProgress } from "./voice-capture-slices";

// Zhiyu room cursor state machine shared by web / mini-program / app
// (openspec: add-zhiyu-mobile-clients). DOM-free; the transport is injected.
export { ZhiyuRoomClient, mergeBySeq } from "./zhiyu-room-client";
export type { RoomMessage, RoomTransport, RoomState, ZhiyuRoomClientOptions } from "./zhiyu-room-client";

// Polling transport + its one reconnect ladder (mini-program and app share it).
export { createPollingTransport, PollDriver, nextPollDelay, POLL_BACKOFF_MS } from "./zhiyu-poll";
export type { PollDriverOptions, PollTransportOptions, PollScheduler } from "./zhiyu-poll";

// Room attachments (openspec: zhiyu-room-attachments-and-voice): ONE upload
// state machine + card model for all four clients. Each client injects a
// picker and a byte transport; none of them may re-implement the transitions.
export {
  applyAttachmentEvent,
  attachmentCardModel,
  attachmentContentPath,
  attachmentPromptRef,
  canSendWithAttachments,
  formatBytes,
  uploadAttachment,
} from "./zhiyu-attachments";
export type {
  AttachmentCardModel,
  AttachmentDraft,
  AttachmentEvent,
  AttachmentStatus,
  CardTone,
  ZhiyuAttachment,
} from "./zhiyu-attachments";

// Where the phone stops and hands over to the web (5.1/5.2), and what a push
// notification is allowed to carry (6.1). Both are data, so the two mobile
// clients cannot each grow their own version of the boundary.
export {
  MOBILE_LOCAL_CAPABILITIES,
  MOBILE_HANDOFF_ACTIONS,
  isHandoffAction,
  handoffActionFor,
  mobileMayDo,
  handoffRequest,
  handoffLinkFrom,
  handoffIsExpired,
} from "./mobile-handoff";
export { NOTIFICATION_TEMPLATE_KEYS, notificationDeepLink, notificationTemplateParams, templateKeys } from "./notification-deeplink";

// The room SCREEN's state rules, shared by the mini-program and the app (3.3 /
// 3.4): the four interactions a phone supports, and the rule that a transport
// downgrade is a note rather than a reset. Pure — no DOM, no platform SDK.
export {
  initialScreen,
  mergeRows,
  applyIncoming,
  applyOlder,
  beginLoadingOlder,
  applyFailure,
  syncFailures,
  holdFor,
  setDraft,
  setRecording,
  transcriptIntoDraft,
  canSend,
  takeDraft,
  applySent,
  applySendFailed,
  connectionNote,
  presenceLine,
  isRenderableRow,
} from "./zhiyu-mobile-model";
export type { RoomRow, RoomScreenState, PresenceEntry, TransportMode } from "./zhiyu-mobile-model";
export type { NoticeLike } from "./notification-deeplink";

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

// Owner inbox read model + action dispatch (openspec: owner-inbox). Pure shapes
// and a plain http() dispatcher — shared by web, the Expo app and the mini
// program so the three clients cannot invent three inboxes.
export * from "./inbox";

// Surface registry + layout presets (openspec: layout-configuration).
export * from "./lib/surfaces";

// Business-role enumeration (openspec: role-system) — shared slug contract.
export * from "./lib/roles";

// Onboarding recipes (openspec: intent-onboarding; ADR-0027).
export * from "./lib/recipes";
