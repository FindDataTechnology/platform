// ── Pack manifest content model (openspec: add-pack-marketplace) ─────────────
//
// The single definition of what a pack manifest may contain, shared by the
// two places that must enforce the same rules: the gateway's publish endpoint
// (creators gate + validation before anything is stored) and the cell's
// install endpoint (defense in depth — the manifest arrives via the browser
// per design D8, so the cell re-validates before materializing).
//
// The v1 content boundary lives here: MCP entries are registry-name
// references only (no endpoints or commands — a pack can never introduce a
// server the operator has not registered), and agent entries are persona-only
// (no baseUrl/model/credentials — pack agents run as local personas on the
// subscriber's runtime).

// Design D11 defaults; callers may override via env for ops/testing.
export const PACK_LIMITS = {
  maxSkills: 10,
  maxSkillBodyChars: 64 * 1024,
  maxAgents: 3,
  maxMcpRefs: 5,
  maxTags: 10,
  maxTagChars: 24,
  maxNameChars: 80,
  maxDescriptionChars: 2000,
  maxPersonaChars: 16 * 1024,
  // Serving contract (add-a2a-agent-serving D1): the contract declares WHAT is
  // exposed, never how the runtime is configured.
  maxCardNameChars: 100,
  maxCardDescriptionChars: 1000,
  maxCardSkills: 8,
  maxCapabilityDescriptionChars: 500,
};

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Keys a pack MCP entry must NOT carry — anything endpoint- or command-shaped
// would break the v1 security boundary.
const MCP_FORBIDDEN_KEYS = ["url", "command", "args", "env", "headers", "config", "configTemplate"];

// Keys a pack agent entry must NOT carry — pack agents are local personas,
// never a forwarded endpoint.
const AGENT_FORBIDDEN_KEYS = ["baseUrl", "model", "apiKey", "apiKeyEnv", "local", "url"];

// Keys the serving contract (and its card) must NOT carry — model, endpoints,
// and credentials are deployment concerns that stay out of the pack (the same
// v1 boundary, extended to the deployable surface).
const SERVING_FORBIDDEN_KEYS = ["url", "baseUrl", "endpoint", "model", "apiKey", "apiKeyEnv", "token", "credentials", "auth"];
const SERVING_KEYS = ["protocol", "card"];
const CARD_KEYS = ["name", "description", "capabilities", "skills"];
const CARD_SKILL_KEYS = ["id", "name", "description", "tags"];

function fail(errors, error, entry) {
  errors.push(entry ? { error, entry } : { error });
}

// Validate a pack manifest. Returns an array of { error, entry? } — empty
// means valid. `entry` names the offending item so the editor can point at it.
export function validatePackManifest(manifest, limits = PACK_LIMITS) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return [{ error: "manifest must be an object" }];
  }

  const name = manifest.name;
  if (typeof name !== "string" || !name.trim() || name.trim().length > limits.maxNameChars) {
    fail(errors, `name must be a non-empty string of at most ${limits.maxNameChars} characters`);
  }

  if (manifest.description != null && (typeof manifest.description !== "string" || manifest.description.length > limits.maxDescriptionChars)) {
    fail(errors, `description must be a string of at most ${limits.maxDescriptionChars} characters`);
  }

  const tags = manifest.tags ?? [];
  if (!Array.isArray(tags) || tags.length > limits.maxTags) {
    fail(errors, `tags must be an array of at most ${limits.maxTags} strings`);
  } else {
    tags.forEach((t, i) => {
      if (typeof t !== "string" || !t.trim() || t.trim().length > limits.maxTagChars) {
        fail(errors, `tag ${i + 1} must be a non-empty string of at most ${limits.maxTagChars} characters`, `tags[${i}]`);
      }
    });
  }

  const skills = manifest.skills ?? [];
  if (!Array.isArray(skills) || skills.length > limits.maxSkills) {
    fail(errors, `skills must be an array of at most ${limits.maxSkills} entries`);
  } else {
    const seen = new Set();
    skills.forEach((s, i) => {
      const entry = `skills[${i}]`;
      if (!s || typeof s !== "object") {
        fail(errors, "skill entry must be an object", entry);
        return;
      }
      if (typeof s.name !== "string" || !NAME_RE.test(s.name)) {
        fail(errors, "skill name must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (seen.has(s.name)) {
        fail(errors, `duplicate skill name '${s.name}'`, entry);
      } else {
        seen.add(s.name);
      }
      if (typeof s.description !== "string" || !s.description.trim() || s.description.length > 300) {
        fail(errors, "skill description must be a non-empty string of at most 300 characters", entry);
      }
      if (typeof s.content !== "string" || !s.content.trim() || s.content.length > limits.maxSkillBodyChars) {
        fail(errors, `skill content must be a non-empty string of at most ${limits.maxSkillBodyChars} characters`, entry);
      }
    });
  }

  const mcpServers = manifest.mcpServers ?? [];
  if (!Array.isArray(mcpServers) || mcpServers.length > limits.maxMcpRefs) {
    fail(errors, `mcpServers must be an array of at most ${limits.maxMcpRefs} entries`);
  } else {
    mcpServers.forEach((m, i) => {
      const entry = `mcpServers[${i}]`;
      if (!m || typeof m !== "object") {
        fail(errors, "MCP entry must be an object", entry);
        return;
      }
      const forbidden = MCP_FORBIDDEN_KEYS.filter((k) => m[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `MCP entries may only reference registry servers (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof m.registryName !== "string" || !NAME_RE.test(m.registryName)) {
        fail(errors, "MCP entry needs a registryName matching [A-Za-z0-9._-], 1-64 chars", entry);
      }
      if (m.requiredGroup != null && (typeof m.requiredGroup !== "string" || !m.requiredGroup.trim() || m.requiredGroup.length > 64)) {
        fail(errors, "MCP entry requiredGroup must be a non-empty string of at most 64 characters", entry);
      }
    });
  }

  const agents = manifest.agents ?? [];
  if (!Array.isArray(agents) || agents.length > limits.maxAgents) {
    fail(errors, `agents must be an array of at most ${limits.maxAgents} entries`);
  } else {
    const seen = new Set();
    agents.forEach((a, i) => {
      const entry = `agents[${i}]`;
      if (!a || typeof a !== "object") {
        fail(errors, "agent entry must be an object", entry);
        return;
      }
      const forbidden = AGENT_FORBIDDEN_KEYS.filter((k) => a[k] !== undefined);
      if (forbidden.length > 0) {
        fail(errors, `agent entries are persona-only (found forbidden key(s): ${forbidden.join(", ")})`, entry);
        return;
      }
      if (typeof a.id !== "string" || !NAME_RE.test(a.id)) {
        fail(errors, "agent id must match [A-Za-z0-9._-], 1-64 chars", entry);
      } else if (a.id.startsWith("user.")) {
        // Reserved namespace (add-custom-presets D6): ids under `user.` belong
        // to the cell's server-assigned custom presets — a pack may never
        // collide with one going forward (installs additionally skip via the
        // foreign-owner backstop for ids that predate this rule).
        fail(errors, `agent id '${a.id}' falls under the reserved "user." namespace (custom presets)`, entry);
      } else if (seen.has(a.id)) {
        fail(errors, `duplicate agent id '${a.id}'`, entry);
      } else {
        seen.add(a.id);
      }
      if (typeof a.name !== "string" || !a.name.trim() || a.name.length > 60) {
        fail(errors, "agent name must be a non-empty string of at most 60 characters", entry);
      }
      if (typeof a.persona !== "string" || !a.persona.trim() || a.persona.length > limits.maxPersonaChars) {
        fail(errors, `agent persona must be a non-empty string of at most ${limits.maxPersonaChars} characters`, entry);
      }
      // Resource declaration (add-persona-resource-sets D2): an optional
      // per-role subset of the pack's OWN skills / MCP references. Dimension
      // independent — absent dimension = whole-pack set for it, present-but-
      // empty = none. Foreign names and duplicates are rejected naming the
      // role, so publish and install enforce identical semantics.
      if (a.resources !== undefined) {
        if (!a.resources || typeof a.resources !== "object" || Array.isArray(a.resources)) {
          fail(errors, "agent resources must be an object of optional skills/mcpServers arrays", entry);
        } else {
          const ownSkills = new Set(
            (Array.isArray(skills) ? skills : []).map((s) => s?.name).filter((n) => typeof n === "string"),
          );
          const ownMcp = new Set(
            (Array.isArray(mcpServers) ? mcpServers : []).map((m) => m?.registryName).filter((n) => typeof n === "string"),
          );
          for (const [dim, own] of [["skills", ownSkills], ["mcpServers", ownMcp]]) {
            const declared = a.resources[dim];
            if (declared === undefined) continue; // absent dimension = whole-pack
            if (!Array.isArray(declared) || declared.some((n) => typeof n !== "string" || !NAME_RE.test(n))) {
              fail(errors, `agent resources.${dim} must be an array of names matching [A-Za-z0-9._-], 1-64 chars`, entry);
              continue;
            }
            const seenDecl = new Set();
            for (const name of declared) {
              if (seenDecl.has(name)) {
                fail(errors, `agent '${a.id}' declares '${name}' twice in resources.${dim}`, entry);
              } else if (!own.has(name)) {
                fail(errors, `agent '${a.id}' declares '${name}' in resources.${dim}, which the pack itself does not declare`, entry);
              } else {
                seenDecl.add(name);
              }
            }
          }
          for (const key of Object.keys(a.resources)) {
            if (key !== "skills" && key !== "mcpServers") {
              fail(errors, `agent resources has unknown dimension '${key}' (only skills, mcpServers)`, entry);
            }
          }
        }
      }
      // Serving contract (add-a2a-agent-serving D1): optional declaration that
      // the role is deployable as an Agent Service over A2A. Absent contract ⇒
      // every pre-existing rule applies verbatim. `card.skills` entries are
      // capability DECLARATIONS for the A2A card — same word as the pack's
      // skill files, different meaning; they never reference the files.
      if (a.serving !== undefined) {
        const sentry = `${entry}.serving`;
        if (!a.serving || typeof a.serving !== "object" || Array.isArray(a.serving)) {
          fail(errors, "serving must be an object of { protocol, card? }", entry);
        } else {
          const forbidden = SERVING_FORBIDDEN_KEYS.filter((k) => a.serving[k] !== undefined);
          if (forbidden.length > 0) {
            fail(errors, `serving declares exposure, not runtime configuration (found forbidden key(s): ${forbidden.join(", ")})`, sentry);
          }
          for (const key of Object.keys(a.serving)) {
            if (!SERVING_KEYS.includes(key)) {
              fail(errors, `serving has unknown key '${key}' (only ${SERVING_KEYS.join(", ")})`, sentry);
            }
          }
          if (typeof a.serving.protocol !== "string" || a.serving.protocol !== "a2a") {
            fail(errors, 'serving.protocol must be "a2a" (v1 exposes the A2A protocol only)', sentry);
          }
          const card = a.serving.card;
          if (card !== undefined) {
            const centry = `${sentry}.card`;
            if (!card || typeof card !== "object" || Array.isArray(card)) {
              fail(errors, "serving.card must be an object of optional manual card fields", sentry);
            } else {
              const cardForbidden = SERVING_FORBIDDEN_KEYS.filter((k) => card[k] !== undefined);
              if (cardForbidden.length > 0) {
                fail(errors, `serving.card may not carry runtime configuration (found forbidden key(s): ${cardForbidden.join(", ")})`, centry);
              }
              for (const key of Object.keys(card)) {
                if (!CARD_KEYS.includes(key)) {
                  fail(errors, `serving.card has unknown key '${key}' (only ${CARD_KEYS.join(", ")})`, centry);
                }
              }
              if (card.name !== undefined && (typeof card.name !== "string" || !card.name.trim() || card.name.length > limits.maxCardNameChars)) {
                fail(errors, `serving.card.name must be a non-empty string of at most ${limits.maxCardNameChars} characters`, centry);
              }
              if (card.description !== undefined && (typeof card.description !== "string" || card.description.length > limits.maxCardDescriptionChars)) {
                fail(errors, `serving.card.description must be a string of at most ${limits.maxCardDescriptionChars} characters`, centry);
              }
              if (card.capabilities !== undefined) {
                if (!card.capabilities || typeof card.capabilities !== "object" || Array.isArray(card.capabilities)) {
                  fail(errors, "serving.card.capabilities must be an object of boolean flags (e.g. streaming)", centry);
                } else {
                  for (const [flag, value] of Object.entries(card.capabilities)) {
                    if (typeof value !== "boolean" || !/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(flag)) {
                      fail(errors, `serving.card.capabilities '${flag}' must map to a boolean (flag names: letters/digits/-/_, ≤40 chars)`, centry);
                    }
                  }
                }
              }
              if (card.skills !== undefined) {
                if (!Array.isArray(card.skills) || card.skills.length > limits.maxCardSkills) {
                  fail(errors, `serving.card.skills must be an array of at most ${limits.maxCardSkills} capability declarations`, centry);
                } else {
                  card.skills.forEach((cs, j) => {
                    const csEntry = `${centry}.skills[${j}]`;
                    if (!cs || typeof cs !== "object") {
                      fail(errors, "capability declaration must be an object of { id, name, description?, tags? }", csEntry);
                      return;
                    }
                    for (const key of Object.keys(cs)) {
                      if (!CARD_SKILL_KEYS.includes(key)) {
                        fail(errors, `capability declaration has unknown key '${key}' (only ${CARD_SKILL_KEYS.join(", ")})`, csEntry);
                      }
                    }
                    if (typeof cs.id !== "string" || !NAME_RE.test(cs.id)) {
                      fail(errors, "capability id must match [A-Za-z0-9._-], 1-64 chars", csEntry);
                    }
                    if (typeof cs.name !== "string" || !cs.name.trim() || cs.name.length > limits.maxCardNameChars) {
                      fail(errors, `capability name must be a non-empty string of at most ${limits.maxCardNameChars} characters`, csEntry);
                    }
                    if (cs.description !== undefined && (typeof cs.description !== "string" || cs.description.length > limits.maxCapabilityDescriptionChars)) {
                      fail(errors, `capability description must be a string of at most ${limits.maxCapabilityDescriptionChars} characters`, csEntry);
                    }
                    if (cs.tags !== undefined) {
                      if (!Array.isArray(cs.tags) || cs.tags.length > limits.maxTags || cs.tags.some((t) => typeof t !== "string" || !t.trim() || t.trim().length > limits.maxTagChars)) {
                        fail(errors, `capability tags must be an array of at most ${limits.maxTags} strings of at most ${limits.maxTagChars} characters`, csEntry);
                      }
                    }
                  });
                }
              }
            }
          }
        }
      }
    });
  }

  const partCount = (Array.isArray(skills) ? skills.length : 0)
    + (Array.isArray(mcpServers) ? mcpServers.length : 0)
    + (Array.isArray(agents) ? agents.length : 0);
  if (partCount === 0) fail(errors, "a pack must contain at least one skill, MCP reference, or agent");

  return errors;
}
