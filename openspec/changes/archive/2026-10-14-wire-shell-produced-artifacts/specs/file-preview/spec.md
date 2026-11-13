## ADDED Requirements

### Requirement: A file is produced by specific tools, not by any path in a call

Which files a turn produced SHALL be determined by the tool that ran, not by the mere presence of a file path in the call. A tool that creates, modifies, or exports files SHALL contribute the paths it operates on; a tool that reads, lists, or searches files SHALL contribute none; a tool with no declared production behavior SHALL contribute none. A shell tool call SHALL contribute a path from its command string only when the command declares that path as an output — by redirecting into it or by invoking a recognized archive, copy, or conversion command — and SHALL NOT contribute paths named in the command merely as inputs or in the command's output text.

#### Scenario: a tool that writes a file contributes it

- **WHEN** a turn's tool call creates or modifies a workspace file through a file-writing tool
- **THEN** that path is among the files the turn is considered to have produced

#### Scenario: a tool that reads a file contributes nothing

- **WHEN** a turn's tool call reads, lists, or searches files and writes nothing
- **THEN** none of the paths it named is among the files the turn is considered to have produced

#### Scenario: a shell command that redirects contributes its target

- **WHEN** a turn's shell call writes its output into a workspace path by redirection
- **THEN** that path is among the files the turn is considered to have produced

#### Scenario: a shell command that archives contributes the archive

- **WHEN** a turn's shell call runs an archive, copy, or conversion command naming an output file
- **THEN** that output path is among the files the turn is considered to have produced
- **AND** the input files the command consumed are not

#### Scenario: a read-only shell command contributes nothing

- **WHEN** a turn's shell call only reads, queries, or inspects state and writes no file
- **THEN** the turn is considered to have produced no files by that call

#### Scenario: a command's output text is not a source of produced files

- **WHEN** a shell command's output names files (a listing, a match, a log line) that the command did not itself create
- **THEN** those files are not attributed to the turn as produced
