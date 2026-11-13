# Spec delta: wanxing-facade (paas twin)

## ADDED Requirements

### Requirement: Gateway agent cards redact non-public provider endpoints

The gateway's Wanxing serving face SHALL serialize `provider` in public agent
cards through a redactor identical in semantics to the fd-wanxing facade: a
`provider.url` that is non-publicly-routable (RFC1918, CGNAT 100.64.0.0/10,
loopback, link-local, `0.0.0.0`, single-label hostnames, cluster-internal
suffixes `.svc`, `.cluster.local`, `.local`, `.internal`) or unparseable MUST
have its `url` key omitted. Publicly-routable URLs and all other provider
fields MUST be preserved. Redaction happens at serialization only; stored
entries MUST NOT be rewritten.

#### Scenario: internal runner address stripped on platform domain card

WHEN an entry carries `provider.url` pointing at a private/tailnet address (e.g. `http://100.64.0.8`)
THEN `GET /api/wanxing/v1/a2a/<slug>/.well-known/agent-card.json` returns a provider without the `url` key, other fields intact

#### Scenario: public provider URL passes through

WHEN `provider.url` is publicly routable (e.g. `https://mcp.finddatatech.cloud`)
THEN the card includes that `url` unchanged

#### Scenario: unparseable URL fails closed

WHEN `provider.url` is present but unparseable
THEN the card omits the `url` key
