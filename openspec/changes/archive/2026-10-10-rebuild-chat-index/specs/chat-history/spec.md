# chat-history Specification Delta

## ADDED Requirements

### Requirement: The session index is a rebuildable projection of the dsh transcripts

The SQLite session index (`chat_sessions` / `chat_messages`) SHALL be treated as a projection that can be rebuilt from the dsh runtime's per-session transcripts (`<DSH_HOME>/sessions/<scope>/<sessionId>/session.jsonl.zstd`), which are the store of record for conversation content. The server SHALL ship a rebuild tool that reconstructs the index from transcripts alone, or by merging transcripts with a pre-migration single-process database when one is supplied. The tool SHALL default to a dry run that reports the plan without writing, SHALL back up the existing index before any write, SHALL be idempotent (upsert by session id, safe to re-run), and SHALL reproduce the live mirror's row semantics exactly: one `user` row per genuine user event (events whose `source.kind` is `user`, deduplicated by event id), one `assistant` row per `assistant/message` event that carries text or tool blocks, and an assistant row's `blocks` synthesized from that turn's `tool/call` and `tool/result` events. Only top-level sessions (`delegationDepth` 0) SHALL be indexed, matching the live mirror; session metadata (`title`, `agent_preset`, `workspace`, timestamps) SHALL be derived from the transcript header and first user message. Sessions present only in the supplied legacy database SHALL be imported as-is, and rows belonging to a different owner than the cell's user SHALL NOT be imported.

#### Scenario: dry run reports without writing

- **WHEN** the rebuild tool runs against a cell's transcripts without `--apply`
- **THEN** it prints the planned session and message counts (with per-session provenance: transcript, legacy database, or both) and SHALL NOT modify the index

#### Scenario: rebuild reproduces the live mirror byte-for-byte

- **WHEN** the tool rebuilds a session whose transcript was also mirrored live
- **THEN** the resulting rows match the live mirror's role, content, and `blocks` for every message, in order

#### Scenario: tool evidence survives rebuild

- **WHEN** a rebuilt assistant row's turn contained tool calls
- **THEN** its `blocks` carry each call's id, name, parsed `args`, result text, and `done`/`error` state, reconstructed from the transcript's `tool/call` and `tool/result` events

#### Scenario: subagent sessions are not indexed

- **WHEN** a transcript belongs to a delegated subagent session (`delegationDepth` > 0)
- **THEN** the rebuild creates no session row for it

#### Scenario: merge prefers the more complete side per session

- **WHEN** a session exists both in the transcripts and in the supplied legacy database
- **THEN** the rebuild uses the side with more messages, keeping the other side's extra sessions intact

#### Scenario: foreign-owner sessions are not imported

- **WHEN** the supplied legacy database contains session rows whose owner is not the cell's user
- **THEN** those rows are skipped and no session or message row is created for them

#### Scenario: write is guarded and idempotent

- **WHEN** the tool runs with `--apply` against an index that already holds rows
- **THEN** it first writes a backup copy of the index, then upserts, and a second run produces the same result
