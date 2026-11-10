// error-codes.ts — the workspace's localized error-code map (add-agent-builder-
// workspace 5.2). Server findings carry a stable `code` (5.1); this table maps
// the codes the workspace UI summarizes to five-language summary keys. Unknown
// codes fall back to the raw error text verbatim — the "no guessing" discipline
// (D5). Raw text always stays visible (5.3: summary + jump + raw in one row).
export const CODE_SUMMARY_KEYS: Record<string, string> = {
  // envelope
  name_too_long: "studio.errors.name_too_long",
  description_too_long: "studio.errors.description_too_long",
  pack_needs_one_reference: "studio.errors.pack_needs_one_reference",
  // skills bucket
  skills_too_many: "studio.errors.skills_too_many",
  skill_entry_invalid: "studio.errors.skill_entry_invalid",
  skill_name_invalid: "studio.errors.skill_name_invalid",
  skill_name_duplicate: "studio.errors.skill_name_duplicate",
  skill_description_invalid: "studio.errors.skill_description_invalid",
  skill_content_invalid: "studio.errors.skill_content_invalid",
  // mcp bucket
  mcp_too_many: "studio.errors.mcp_too_many",
  mcp_entry_invalid: "studio.errors.mcp_entry_invalid",
  mcp_forbidden_keys: "studio.errors.mcp_forbidden_keys",
  mcp_needs_registry_name: "studio.errors.mcp_needs_registry_name",
  allowtools_conflict: "studio.errors.allowtools_conflict",
  fullsurface_false: "studio.errors.fullsurface_false",
  fullsurface_needs_reason: "studio.errors.fullsurface_needs_reason",
  reason_needs_fullsurface: "studio.errors.reason_needs_fullsurface",
  allowtools_invalid: "studio.errors.allowtools_invalid",
  // agents bucket
  agents_too_many: "studio.errors.agents_too_many",
  agent_entry_invalid: "studio.errors.agent_entry_invalid",
  agent_forbidden_keys: "studio.errors.agent_forbidden_keys",
  agent_id_invalid: "studio.errors.agent_id_invalid",
  agent_id_duplicate: "studio.errors.agent_id_duplicate",
  agent_name_invalid: "studio.errors.agent_name_invalid",
  agent_persona_invalid: "studio.errors.agent_persona_invalid",
  // shape / credentials / data sources
  credential_secret_literal: "studio.errors.credential_secret_literal",
  credential_forbidden_key: "studio.errors.credential_forbidden_key",
  datasources_invalid: "studio.errors.datasources_invalid",
  datasource_entry_invalid: "studio.errors.datasource_entry_invalid",
  datasource_ref_invalid: "studio.errors.datasource_ref_invalid",
  datasource_library_unresolved: "studio.errors.datasource_library_unresolved",
  datasource_note_invalid: "studio.errors.datasource_note_invalid",
  judge_model_unknown: "studio.errors.judge_model_unknown",
  v1_format: "studio.errors.v1_format",
  // acceptance assertions
  acceptance_entry_invalid: "studio.errors.acceptance_entry_invalid",
  acceptance_kind_unsupported: "studio.errors.acceptance_kind_unsupported",
  acceptance_target_invalid: "studio.errors.acceptance_target_invalid",
  acceptance_expect_invalid: "studio.errors.acceptance_expect_invalid",
  acceptance_rubric_required: "studio.errors.acceptance_rubric_required",
  acceptance_judge_cap: "studio.errors.acceptance_judge_cap",
  // fleet template
  fleet_name_invalid: "studio.errors.fleet_name_invalid",
  fleet_missing: "studio.errors.fleet_missing",
  fleet_members_empty: "studio.errors.fleet_members_empty",
  fleet_member_needs_ref: "studio.errors.fleet_member_needs_ref",
  fleet_member_needs_title: "studio.errors.fleet_member_needs_title",
  fleet_member_needs_target: "studio.errors.fleet_member_needs_target",
  fleet_target_kind_invalid: "studio.errors.fleet_target_kind_invalid",
  fleet_tool_target_shape: "studio.errors.fleet_tool_target_shape",
  handoff_cycle: "studio.errors.handoff_cycle",
  handoff_unknown_parent: "studio.errors.handoff_unknown_parent",
};

/** Locale key for a code, or null — null means "no summary, show raw text". */
export function codeSummaryKey(code: string | undefined | null): string | null {
  if (!code) return null;
  return CODE_SUMMARY_KEYS[code] ?? null;
}
