## ADDED Requirements

### Requirement: Pairing doors also open on the facet service

The facet service SHALL mount the same device-pairing surface — bind-code minting from a facet-domain session, first pairing, silent challenge login, and the paired-device management face — backed by its own bindings store under its data root, reusing the shared pairing modules verbatim. Pairing SHALL be inert with an honest 503 while the shared token secret is unset, without affecting the rest of the facet surface. The facet identity resolution SHALL accept a verified app token (`kind: "app"`) as an account-identity channel, composing it after the proxy and session channels, exactly as the 壹座 gateway does.

#### Scenario: CLI pairs against the facet domain

- **WHEN** a device pairs on the facet domain with a bind code minted from a facet-domain session
- **THEN** pairing succeeds against the facet bindings store, and the issued token authenticates the publish route on that same domain under the bind code's account identity

#### Scenario: Silent login on the facet domain

- **WHEN** an already-paired device silently logs in on the facet domain
- **THEN** the single-use challenge is answered with a fresh account-identity token; no browser session is involved

#### Scenario: Facet without the token secret is honestly closed

- **WHEN** the facet service runs without the shared token secret configured
- **THEN** the pairing doors answer 503 and the remainder of the facet surface (browse, detail, web publish) is unaffected

#### Scenario: Devices are revocable via the facet domain

- **WHEN** a paired account revokes one of its devices through the facet domain, presenting either a web session or an app token
- **THEN** the revocation lands in the facet bindings store and the device's next silent login is refused with binding_required
