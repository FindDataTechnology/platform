// ── Marketplace credential shapes — ONE definition, two consumers ───────────
//
// The exporter (facet/marketplace-repo.js, runs offline in scripts/) and the
// facet runtime's MCP Registry projector (facet/mcp-registry-json.js) both must
// refuse—never sanitize—on the same credential shapes (pack-marketplace spec:
// "Projection output never carries credential material"). Keeping the regex
// here rather than in the exporter means the runtime face does not have to
// import the whole exporter (which drags in facet/cli/, deliberately not
// shipped in the image) just for one pattern.
//
// This is still a single source: export-only moves, no second copy. A second
// copy is exactly the drift the marketplace spec forbids.

// Credential shapes that must never appear in exported or projected bytes.
// `wgk-` = caller key, `sk-` = provider key, `skh_` = service key.
export const CREDENTIAL_RE = /\b(wgk-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|skh_[A-Za-z0-9]{16,})\b/;
