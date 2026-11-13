## ADDED Requirements

### Requirement: URL ingestion honors HTTP(S) proxy configuration
The document module SHALL honor the `https_proxy` (preferred) or `http_proxy` environment variable when fetching a URL for ingestion: when a proxy is configured, the fetch SHALL route through it so that URL uploads succeed in environments where direct egress is blocked. When no proxy is configured, the fetch SHALL behave as before (direct). SSRF protection (rejecting private/local-network hosts) SHALL still be applied to the target host before fetching, regardless of proxy use.

#### Scenario: URL fetch succeeds through a configured proxy
- **WHEN** a client submits a URL and `https_proxy` (or `http_proxy`) is set in the environment
- **AND** the target host is not private or local
- **THEN** the server SHALL fetch the URL through the proxy
- **AND** SHALL index the extracted text and transition the document to `ready`

#### Scenario: URL fetch is direct when no proxy is configured
- **WHEN** a client submits a URL and no proxy environment variable is set
- **THEN** the server SHALL fetch the URL directly (unchanged behavior)

#### Scenario: SSRF protection still applies with a proxy
- **WHEN** a client submits a URL whose host is loopback, private, link-local, or `.local`
- **THEN** the server SHALL reject it with a clear error and SHALL NOT fetch it, even if a proxy is configured

### Requirement: Document list status updates are race-free in the UI
The UI SHALL serialize document-list fetches so that overlapping fetches (for example, one triggered by an add and another by a `documents_status` event for the same document) cannot resolve out of order. A stale in-flight response SHALL NOT overwrite a newer status, so a document row SHALL always converge on its latest status and never remain stuck on an intermediate status such as `indexing`.

#### Scenario: overlapping list fetches do not stick the status
- **WHEN** a document is added and its `documents_status` events arrive while list fetches overlap
- **THEN** the document row SHALL converge on the final status (e.g. `ready`)
- **AND** SHALL NOT remain stuck on an earlier status because a stale fetch resolved last
