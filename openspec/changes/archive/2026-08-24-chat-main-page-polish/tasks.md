# Tasks — chat-main-page-polish

## 1. Welcome state component
- [x] 1.1 Create `web/src/components/ChatWelcome.tsx` (greeting + 4 prompt cards + recent chats list + model/agent footer)
- [x] 1.2 Define a `SuggestedPrompt[]` prop on ChatWelcome so a future change can override defaults from config
- [x] 1.3 Hard-code 4 default prompts (write code, analyze data, summarize a document, research a topic) with icons
- [x] 1.4 Render the last 5 sessions from the store (sort by updatedAt desc), each row clickable to switch
- [x] 1.5 Add i18n keys `chat.welcome.greeting`, `chat.welcome.suggestedPrompts`, `chat.welcome.recentChats`, `chat.welcome.viewAll`, `chat.welcome.modelFooter`, `chat.welcome.agentFooter`
- [x] 1.6 Hide the recent-chats section when `sessions[]` is empty

## 2. Session header
- [x] 2.1 Create `web/src/components/ChatHeader.tsx` (editable title + model/agent status + connection dot)
- [x] 2.2 Title renders as a button; click switches to an input with the same width
- [x] 2.3 Enter commits (immediate WS send); Esc cancels and reverts
- [x] 2.4 Add a 300ms debounce on keystrokes for non-Enter commits
- [x] 2.5 Status strip is a single line: `model · agent · <StatusDot />` (reuses the existing `StatusRow` from Sidebar)
- [x] 2.6 Add i18n keys `chat.header.editTitle`, `chat.header.titlePlaceholder`, `chat.header.rename`

## 3. Chat page split
- [x] 3.1 In `web/src/pages/ChatPage.tsx`, render `ChatWelcome` when `turns.length === 0`, otherwise render `ChatHeader + Chat + Composer`
- [x] 3.2 Ensure the two states never render together (mutually exclusive)
- [x] 3.3 Confirm `clearView` action transitions back to the welcome state

## 4. Slash-command picker
- [x] 4.1 Create `web/src/components/SlashCommandPicker.tsx` (popover with Commands / Skills sections, filter, keyboard nav)
- [x] 4.2 Open on `/` typed as the first char or after a space in the composer
- [x] 4.3 Close on Escape, on Enter when committed, on outside click, or when the user clears the `/`
- [x] 4.4 Filter entries case-insensitively on the typed substring
- [x] 4.5 Highlight the first match by default; arrow keys move the highlight; Enter inserts
- [x] 4.6 Source the Skills section from the WS `skills` event (already in the store)
- [x] 4.7 Source the Commands section from a constant (`/clear`, `/model`, future additions)
- [x] 4.8 Add i18n keys `chat.composer.slashPicker.title`, `chat.composer.slashPicker.sectionCommands`, `chat.composer.slashPicker.sectionSkills`, `chat.composer.slashPicker.noMatches`

## 5. Composer integration
- [x] 5.1 In `web/src/components/Composer.tsx`, add the slash-picker state (open, filter, highlighted index)
- [x] 5.2 Open the picker when the typed text contains a leading `/` (or `/` after a space)
- [x] 5.3 Hide the picker when the user types a newline or pastes a long string
- [x] 5.4 Forward key events (arrows, Enter, Escape) to the picker when open
- [x] 5.5 Show the file-attach count when attachments are present (the existing `chat-attachments` spec already wires the attach button)
- [x] 5.6 Update the placeholder hint to mention Cmd/Ctrl+Enter to send (and `/` for commands)

## 6. Server: rename_session / session_renamed
- [x] 6.1 In `web/src/types/ws.ts`, add `rename_session` to `ClientMessage` and `session_renamed` to `ServerMessage`
- [x] 6.2 In `server.js`, add the WS handler for `rename_session` (validate id + title, delegate to `chat-history.setTitle()`)
- [x] 6.3 Broadcast `session_renamed` to all connected clients on success
- [x] 6.4 In `server.js`, add `app.patch('/api/chat-history/sessions/:id', ...)` accepting `{ title }` (1–200 chars, non-empty)
- [x] 6.5 In `chat-history.js`, add `setTitle(id, title)` that updates the SQLite mirror and the on-disk store (atomic temp-file + rename)
- [x] 6.6 Reject empty / overlong / control-character titles with 400 and a clear error
- [x] 6.7 Add i18n key `chat.titleTooLong` (server-side error key) — server returns machine-readable codes, the client maps them to messages

## 7. Client store updates
- [x] 7.1 In `web/src/hooks/useChatStore.ts`, add a `session_renamed` case in `apply()` that updates the matching session's title in `sessions[]`
- [x] 7.2 Add a `renameSession(id, title)` local action that does the optimistic update + WS send
- [x] 7.3 Update the `SessionMeta` type (in `web/src/types/ws.ts`) to require a `title: string` field
- [x] 7.4 Add a unit test for the `session_renamed` reducer case

## 8. Tests
- [x] 8.1 E2E: open the app, assert the welcome state is visible with 4 cards
- [x] 8.2 E2E: click a suggested prompt, assert composer is filled and focused
- [x] 8.3 E2E: send the first message, assert welcome disappears and header + log appear
- [x] 8.4 E2E: in-session, click the title, type a new name, press Enter, assert WS broadcast (check sidebar title updates)
- [x] 8.5 E2E: open the slash picker with `/`, type to filter, arrow-key + Enter to insert
- [x] 8.6 E2E: Esc dismisses the picker without changing the composer
- [x] 8.7 Unit: `setTitle()` rejects empty / overlong titles
- [x] 8.8 Unit: `session_renamed` reducer updates the right session
