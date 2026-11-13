# social-bot-channels Specification (delta)

## ADDED Requirements

### Requirement: Inbound bot messages record their chat for later addressing

The server SHALL record the chat of every verified inbound bot message — bot id, chat key, sender display name, and first/last-seen timestamps — upserting one row per (bot, chat key), so previously-seen chats are enumerable for administrative channel binding. The record SHALL NOT contain message content. A recording failure SHALL be logged and SHALL NOT block the agent turn or the reply.

#### Scenario: first message from a chat is recorded

- **WHEN** a verified inbound message arrives from a chat not seen before
- **THEN** a row for that (bot, chat key) is created carrying the sender display name and the first-seen timestamp

#### Scenario: repeat messages update, never duplicate

- **WHEN** further messages arrive from a recorded chat
- **THEN** the existing row's last-seen timestamp is updated and no duplicate row is created

#### Scenario: content is not stored

- **WHEN** any inbound message is recorded
- **THEN** only identity and timing fields are stored, never the message text

#### Scenario: recording failure does not affect the conversation

- **WHEN** recording the chat fails
- **THEN** the failure is logged and the agent turn and its reply proceed normally
