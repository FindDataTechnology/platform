# cron-module Specification

## Purpose
Defines scheduled and recurring task execution capabilities, enabling the agent to run prompts at specific times or on recurring schedules using cron-style syntax.

## ADDED Requirements

### Requirement: Cron module provides job scheduling API
The server SHALL expose a cron module that supports adding one-shot jobs (run at specific time) and recurring jobs (run on cron schedule). The module SHALL persist jobs to disk and restore them on server startup.

#### Scenario: Add one-shot job
- **WHEN** a client sends `{ type: "cron_add", when: "2024-12-31T23:59:00", prompt: "Happy New Year!" }`
- **THEN** the server SHALL schedule the job to run at the specified time
- **AND** broadcast a `cron_status` event with the new job ID and status

#### Scenario: Add recurring job
- **WHEN** a client sends `{ type: "cron_add", cron: "0 9 * * *", prompt: "Daily standup reminder" }`
- **THEN** the server SHALL schedule the job to run daily at 9am
- **AND** broadcast a `cron_status` event with the new job ID and status

### Requirement: Cron jobs persist across server restarts
The cron module SHALL persist all jobs to `cron-store/jobs.json` using atomic temp-file + rename writes. On server startup, all persisted jobs SHALL be re-scheduled.

#### Scenario: Jobs restored on startup
- **WHEN** the server starts and `cron-store/jobs.json` exists
- **THEN** all jobs in the file SHALL be loaded and re-scheduled
- **AND** a `cron_status` event SHALL be broadcast listing all loaded jobs

#### Scenario: Job saved atomically
- **WHEN** a job is added or modified
- **THEN** the server SHALL write to a temporary file first
- **AND** rename it to `jobs.json` atomically
- **AND** SHALL NOT corrupt the file if the server crashes during write

### Requirement: Cron module supports job management
The cron module SHALL support listing all jobs, removing jobs by ID, pausing jobs, and resuming jobs.

#### Scenario: List all jobs
- **WHEN** a client sends `{ type: "cron_list" }`
- **THEN** the server SHALL reply with `{ type: "cron_jobs", jobs: [...] }` containing all jobs with their IDs, schedules, prompts, and status

#### Scenario: Remove job
- **WHEN** a client sends `{ type: "cron_remove", jobId: "<id>" }`
- **THEN** the specified job SHALL be canceled and removed from storage
- **AND** a `cron_status` event SHALL be broadcast with the removal

#### Scenario: Pause and resume job
- **WHEN** a client sends `{ type: "cron_pause", jobId: "<id>" }`
- **THEN** the job SHALL be paused (not run until resumed)
- **AND** when `{ type: "cron_resume", jobId: "<id>" }` is sent
- **THEN** the job SHALL resume its schedule

### Requirement: Cron job execution triggers agent prompt
When a cron job fires, the server SHALL execute the stored prompt as if a client sent it, broadcasting all normal chat streaming events.

#### Scenario: Job fires and runs agent prompt
- **WHEN** a cron job reaches its scheduled time
- **THEN** the server SHALL call `session.prompt()` with the stored prompt text
- **AND** broadcast all normal `agent_start`, `text`, `tool_*`, and `done` events
- **AND** record the job execution status (success/failed) and timestamp

#### Scenario: Concurrent job execution prevented
- **WHEN** multiple cron jobs are scheduled at the same time
- **THEN** the jobs SHALL be queued and run sequentially
- **AND** SHALL NOT run concurrently with an active agent turn

### Requirement: Cron job history is tracked
The cron module SHALL track the last execution time, next scheduled run, and last execution result for each job. History SHALL be pruned to keep the last 100 executions.

#### Scenario: Job history includes execution results
- **WHEN** a job finishes executing
- **THEN** the execution timestamp, duration, and success/failure status SHALL be recorded
- **AND** the job's `lastRun` field SHALL be updated

#### Scenario: History auto-pruned
- **WHEN** a job has more than 100 execution history entries
- **THEN** the oldest entries SHALL be pruned
- **AND** the 100 most recent entries SHALL be retained

### Requirement: Cron events broadcast to all clients
Cron module events (`cron_status`, `cron_fired`, `cron_completed`) SHALL be broadcast to all connected WebSocket clients for real-time UI updates.

#### Scenario: Status broadcast on job change
- **WHEN** any job is added, removed, paused, or resumed
- **THEN** a `cron_status` event SHALL be broadcast to all clients

#### Scenario: Execution events broadcast
- **WHEN** a job starts executing
- **THEN** a `cron_fired` event SHALL be broadcast
- **AND** when the job completes
- **THEN** a `cron_completed` event SHALL be broadcast with the result
