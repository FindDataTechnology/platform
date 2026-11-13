## ADDED Requirements

### Requirement: Self-hosted deploy surfaces degrade to official-market guidance

The pack deploy surface on any instance SHALL probe the instance's serving capability before offering deployment: when agent serving is not configured (the self-hosted shape), the surface SHALL render a guidance panel — the pack's agents belong on the official marketplace, with links to the marketplace and the creation guide, and an honest note that self-hosting the serving stack is possible — and SHALL NOT show the deploy form nor surface internal configuration errors. On an instance with serving configured, the deploy form renders exactly as before. A capability probe endpoint SHALL answer the question honestly both ways, and a deploy attempt that races the probe (the not-configured 503) SHALL land on the same guidance panel rather than a raw error.

#### Scenario: The self-hosted shape guides, never errors

- **WHEN** a visitor opens a serving pack's detail on an instance without agent serving
- **THEN** the deploy section renders the official-market guidance panel with marketplace and creation-guide links, no deploy form, and no internal environment names

#### Scenario: The official shape is unchanged

- **WHEN** the same pack detail opens on an instance with serving configured
- **THEN** the deploy form renders exactly as before the guidance existed

#### Scenario: The race lands on guidance too

- **WHEN** a deploy click slips through before the probe answers and the server refuses with its not-configured status
- **THEN** the panel appears in place of the raw error message
