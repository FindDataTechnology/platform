# mobile-app Delta

## Purpose

壹座通用客户端（安卓/iOS）：连接任意自建实例的官方移动 App——以设备配对登录（消费 device-pairing-auth 端点），承载与小程序对齐的聊天主链（WS 契约、会话、模型/角色选择、问询卡、产物、分享）加上实例管理，信息架构为底部三 Tab（对话/定时/资源）。

## ADDED Requirements

### Requirement: First launch pairs the device against a chosen instance

The app's first launch SHALL ask for an instance address and a bind code with two entry paths: scanning the web Settings paired-devices QR (whose payload resolves both the instance origin and the 6-digit code — no typing), or typing the address and digits manually. The app SHALL generate an Ed25519 keypair on first run (private key only ever in the platform secure store), redeem the code at the instance's `POST /api/app/pair`, and persist the pairing locally. Pairing failures (wrong/expired code → 401, unreachable address, capability absent on `/api/config`) SHALL show a specific message and leave the pairing form usable; a paired instance SHALL persist across launches. An instance that answers `/api/config` without `capabilities.devicePairing` SHALL be reported as needing a server upgrade rather than failing silently.

#### Scenario: scan-to-pair in one capture

- **WHEN** the user scans the QR from the web Settings paired-devices section
- **THEN** the instance address and bind code are both filled from the scan and pairing completes with no typing

#### Scenario: wrong code leaves the form usable

- **WHEN** pairing is rejected with 401
- **THEN** the app shows the rejection reason and the pairing form remains usable for a fresh code

#### Scenario: older instance is named as such

- **WHEN** the entered instance's `/api/config` carries no `capabilities.devicePairing`
- **THEN** the app states that the server needs an upgrade instead of attempting pairing or reporting a network error

### Requirement: Every launch is a silent challenge login; revoked devices re-pair

For a paired device, launch SHALL silently request a challenge and sign it (`deviceId:nonce`, Ed25519) to obtain a fresh platform token — no UI beyond a connecting state. A `401 binding_required` (revoked or unknown) SHALL route the app back to the pairing screen with a re-pairing explanation; other auth failures during a session SHALL trigger one silent re-exchange before surfacing an error.

#### Scenario: silent launch

- **WHEN** the app starts with a stored pairing
- **THEN** it exchanges a signed challenge for a platform token without user interaction and lands on the chat tab

#### Scenario: revocation detected at launch

- **WHEN** the device's binding was revoked on the web and the app starts
- **THEN** the challenge exchange answers 401 and the app presents the pairing screen with a re-pairing explanation

### Requirement: The chat tab carries the full chat turn over the WS contract

The app SHALL connect over WebSocket using the same JSON message protocol as the web client (`prompt` in; `user`, `agent_start`, `text`, `thinking`, `tool_start`/`update`/`end`, `skill_use`, `done`, `error` out), reusing the shared core store. Streaming text SHALL render incrementally; a failed turn SHALL surface the error and leave the composer usable. Session history, model and persona selection (with the streaming guard), copy/regenerate actions, the question card, artifact strip, and collapsed secondary-activity groups SHALL behave with mini-program parity. The three-tab shell SHALL expose 对话 / 定时任务 / 资源库 as bottom tabs with chat as the initial tab.

#### Scenario: a full turn streams

- **WHEN** the user sends a prompt on the chat tab
- **THEN** the assistant's streaming text renders incrementally and the composer is released when the turn completes

#### Scenario: question card gates the composer

- **WHEN** a turn ends with a pending ask
- **THEN** the interactive question card renders and gates the composer until resolved, matching mini-program behavior

#### Scenario: history and selection work as on the mini program

- **WHEN** the user opens history or changes model/persona mid-session
- **THEN** those surfaces behave with mini-program parity, including the streaming guard on selection

### Requirement: The socket survives app lifecycle events

Backgrounding SHALL NOT corrupt session state: when the app returns to the foreground, the client SHALL reattach/reconnect and resynchronize session state with the server (the core reconnect+resync path), and a reconnect that finds the token expired SHALL first run the silent re-exchange. A connection that cannot be re-established SHALL show the disconnected affordance with a reconnect action, never a dead UI.

#### Scenario: background and return

- **WHEN** the app is backgrounded mid-conversation and returns to the foreground
- **THEN** the socket reattaches and the visible session state matches the server's

#### Scenario: offline shows a recoverable state

- **WHEN** the instance is unreachable
- **THEN** the chat tab shows a disconnected state with a retry action instead of silently dropping messages

### Requirement: Assistant content renders markdown and charts with defined degradation

Assistant messages SHALL render markdown (headings, lists, code with monospace blocks, tables as scrollable content) via a RN renderer over the shared parsing conventions. Chart fences SHALL render in a controlled WebView hosting echarts fed the option JSON; a render failure or unsupported fence SHALL degrade to the raw code block — the same contract as the other clients. Rendering SHALL be light-theme only in v1.

#### Scenario: chart fence renders and degrades

- **WHEN** an assistant message carries a chart fence
- **THEN** the chart renders interactively in the embedded echarts view, and a failing render falls back to the raw code block

#### Scenario: markdown parity

- **WHEN** an assistant message carries headings, a list, and a code block
- **THEN** all three render distinctly with monospace code blocks

### Requirement: Cron and resources tabs cover the mini-program surfaces

The cron tab SHALL list scheduled tasks with their schedule, state, and enable/disable control matching mini-program behavior; the resources tab SHALL list the resource library with preview for charts (embedded renderer) and files (metadata + open action) matching mini-program behavior. Both tabs SHALL reflect server state on refresh.

#### Scenario: cron list and toggle

- **WHEN** the user opens the cron tab and disables a task
- **THEN** the task's state updates to match the server's response

#### Scenario: resources browse and preview

- **WHEN** the user opens a chart resource
- **THEN** it renders via the embedded chart renderer

### Requirement: Shared sessions open in a public read-only view

Opening a share token (entered via the share screen) SHALL render the shared session read-only without any authentication header, mirroring the mini-program share page; an unavailable or revoked share SHALL show an explicit unavailable state.

#### Scenario: share token opens read-only

- **WHEN** the user opens a valid share token on the share screen
- **THEN** the mirrored conversation renders read-only with no credentials involved

### Requirement: Settings manages the instance, language, and this device

The in-app settings screen SHALL show the connected instance address and its reachability, offer unbind-and-switch (revoking this device's binding then returning to pairing), switch the language between 中文 and English taking effect immediately, and show app version info. The app SHALL follow the system locale at first launch.

#### Scenario: unbind and switch instance

- **WHEN** the user chooses unbind in settings
- **THEN** the device's binding is revoked server-side, local pairing state is cleared, and the app returns to the pairing screen

#### Scenario: language switch applies immediately

- **WHEN** the user switches the language in settings
- **THEN** all app copy re-renders in the chosen language without a restart

### Requirement: Capability probing degrades instead of blocking

On connecting to an instance, the app SHALL read `/api/config` capabilities and hide features the instance does not advertise (absent `capabilities` = treat as an older server); the connection itself SHALL never be refused for a missing capability. Unreadable config (e.g. 401 on forward-auth shapes) SHALL be treated as "capabilities unknown" and pairing proceeds regardless.

#### Scenario: older instance connects with fewer features

- **WHEN** the app connects to an instance whose config lacks newer capability keys
- **THEN** the app connects and hides the undisclosed features rather than refusing
