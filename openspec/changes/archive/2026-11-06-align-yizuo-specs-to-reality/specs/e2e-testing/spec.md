## REMOVED Requirements

### Requirement: E2E suite covers document chat (RAG) flow
**Reason**: 「Ask the collection」问答面已删除——document-management-ui 规定 Documents 页 SHALL NOT 有问答面；DocumentsPage.tsx 无 QuerySection，e2e 目录亦无对应测试（`grep "Ask the collection"|QuerySection` 于 `e2e/`、`web/src/` 均无命中）。
**Migration**: 无需替代覆盖——被测 UI 已不存在；collection 问答能力由 knowledge 侧能力的既有测试承担。

## MODIFIED Requirements

### Requirement: E2E suite covers app shell navigation

The suite SHALL verify the sidebar contains exactly the canonical work-surface navigation tabs — Chat, Knowledge, Resources, Agents, and Tasks — that switching between them works correctly, and that the demoted configuration entries are absent from the sidebar.

#### Scenario: sidebar shows current navigation tabs

- **WHEN** the app loads
- **THEN** the sidebar SHALL show the navigation tabs Chat, Knowledge, Resources, Agents, and Tasks
- **AND** no Models, MCP Servers, Skills, Bots, or Trace navigation tab SHALL be present

#### Scenario: switching between work surfaces works

- **WHEN** the test clicks each work-surface tab in turn
- **THEN** the corresponding surface SHALL render
- **AND** the active tab SHALL be highlighted
