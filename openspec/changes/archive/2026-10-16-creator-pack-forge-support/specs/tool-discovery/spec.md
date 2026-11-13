# tool-discovery 变更 Delta

## MODIFIED Requirements

### Requirement: Discovery is limited to already-effective tools

Tool discovery SHALL cover only tools already available through the platform's effective runtime profile. It SHALL NOT search, mount, install, proxy, or execute registry entries that are not effective. In particular, this capability SHALL NOT cause `airegistry-tools` to be installed or mounted and SHALL NOT create a chat-driven registry marketplace discovery flow.

#### Scenario: Unmounted registry server is not returned

- **WHEN** the registry contains `airegistry-tools` or another MCP server but that server is not part of the effective runtime profile
- **THEN** effective-tool discovery SHALL NOT return that server or its tools

#### Scenario: Discovery does not modify the marketplace

- **WHEN** the agent searches for or receives candidates from effective-tool discovery
- **THEN** no marketplace entry, extension record, MCP patch, credential, or runtime profile SHALL be modified

#### Scenario: An explicitly installed pack may reference the registry discovery server

- **WHEN** a user installs a pack whose manifest references `airegistry-tools` through the normal pack installation flow
- **THEN** that server and its tools become effective for that user through the pack, as with any other referenced server
- **AND** the effective-tool discovery layer itself still does not search, mount, install, or auto-enable `airegistry-tools` for users who have not installed such a pack, and no chat-driven marketplace discovery flow is created
