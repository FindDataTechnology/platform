## MODIFIED Requirements

### Requirement: Session history is browsable

The client SHALL list past chat sessions with title and recency from the
existing chat-history REST endpoints. Tapping a session row SHALL continue
that conversation in the live chat: the client SHALL send `switch_session`
for the row's id and land the user on the chat page, where the session's
turns render through the SAME transcript renderer as live chat. A dedicated
read-only session viewer SHALL NOT exist. Each row SHALL offer a share
affordance (the ↗ icon, consistent with the chat header): tapping it SHALL
create a share token for that session and prompt the forward-card flow, and
SHALL NOT open the session.

#### Scenario: opening a past session

- **WHEN** the user taps a session row in the history list
- **THEN** the live chat switches to that session (`switch_session` → the chat page renders its turns through the shared transcript renderer), the user lands on the chat page ready to type, and returning to the list preserves the list's scroll position

#### Scenario: the row share icon shares instead of opening

- **WHEN** the user taps a row's ↗ affordance
- **THEN** a share token is created for that session with a forward-card toast, and the session does not open

## ADDED Requirements

### Requirement: History secondary surfaces live in collapsed groups

The history page SHALL organize secondary surfaces below the session list as
collapsed-by-default groups: the user's active shares (count on the header;
expanding lists tokens with a revoke action), the scheduled-task entry (count
on the header; the unread indication for unseen task output lives on this
group's header and clears by the existing seen-marking rules), and the
server/advanced settings. The session list itself SHALL remain the primary
surface above the groups. No secondary section SHALL render expanded without
a user tap.

#### Scenario: groups render collapsed with counts

- **WHEN** the history list page is shown
- **THEN** the session list renders first, followed by collapsed group headers for shares, scheduled tasks, and server settings, each carrying its count where one exists

#### Scenario: unseen task output marks the group

- **WHEN** a scheduled task produced unseen output
- **THEN** the scheduled-task group header shows the unread indication until the session is viewed by the existing rules

### Requirement: The new-session action answers every tap

The new-session action SHALL give feedback on every activation: starting a
fresh session SHALL confirm it (e.g. 「已开启新对话」), and activating it while
the current session is already blank SHALL say so (「已是新对话」) instead of
silently doing nothing.

#### Scenario: new session from an active conversation

- **WHEN** the user taps ＋ while a conversation with turns is open
- **THEN** a fresh session starts and a confirmation toast appears

#### Scenario: new session on the welcome state

- **WHEN** the user taps ＋ while the current session is already blank
- **THEN** a 「已是新对话」 toast appears and no duplicate session is created
