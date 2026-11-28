// Operator-declared per-server tool faces (add-crm-desk-bridge D5).
//
// A platform governance ceiling: for each named server, the leaf names that
// may EVER appear in an agent's visible/callable face -- in every mode (full,
// custom preset, pack persona), intersecting pack allowlists, role narrowing
// and the user's full-surface override alike (the override restores UP TO the
// face, never past it -- see spec pack-agent-scoping). The enforcement vehicle
// is the existing tool-filter stack (GUARD / register-shadow / composition
// restrict): the capped map is simply what writeToolFilterPatch materializes.
//
// chatwoot face = 98 = the standard-Chatwoot-available subset of
// @fazer-ai/mcp-chatwoot@1.1.0's 123 tools (123 - 23 fork-specific that 404 on
// a standard instance: kanban_* x19 + scheduled_messages_* x4) minus the
// send-class pair (messages_create / messages_delete) which MUST NOT be in
// any agent face -- sending is action-gate territory (crm.message.send) and
// message deletion is deliberately unreachable (unregistered => refused).
//
// Generated from the pinned dist's tools/list (the shipped code is the source
// of truth; finddata vetting report S4 is the cross-check). Bumping the
// dependency version REQUIRES regenerating this list and re-running the
// snapshot test's count assertions.

const CHATWOOT_FACE = Object.freeze([
  "account_get",
  "account_update",
  "agent_bots_create",
  "agent_bots_delete",
  "agent_bots_get",
  "agent_bots_list",
  "agent_bots_update",
  "agents_create",
  "agents_delete",
  "agents_list",
  "agents_update",
  "audit_logs_list",
  "automation_rules_create",
  "automation_rules_delete",
  "automation_rules_get",
  "automation_rules_list",
  "automation_rules_update",
  "canned_responses_create",
  "canned_responses_delete",
  "canned_responses_list",
  "canned_responses_update",
  "contact_labels_list",
  "contact_labels_set",
  "contacts_contactable_inboxes",
  "contacts_conversations",
  "contacts_create",
  "contacts_create_contact_inbox",
  "contacts_delete",
  "contacts_filter",
  "contacts_get",
  "contacts_list",
  "contacts_merge",
  "contacts_search",
  "contacts_update",
  "conversation_assignments_assign",
  "conversations_create",
  "conversations_filter",
  "conversations_get",
  "conversations_get_labels",
  "conversations_list",
  "conversations_meta",
  "conversations_reporting_events",
  "conversations_set_custom_attributes",
  "conversations_set_labels",
  "conversations_toggle_priority",
  "conversations_toggle_status",
  "conversations_update",
  "custom_attributes_create",
  "custom_attributes_delete",
  "custom_attributes_get",
  "custom_attributes_list",
  "custom_attributes_update",
  "custom_filters_create",
  "custom_filters_delete",
  "custom_filters_get",
  "custom_filters_list",
  "custom_filters_update",
  "help_center_articles_create",
  "help_center_categories_create",
  "help_center_portals_create",
  "help_center_portals_list",
  "help_center_portals_update",
  "inbox_members_create",
  "inbox_members_delete",
  "inbox_members_list",
  "inbox_members_update",
  "inboxes_create",
  "inboxes_get",
  "inboxes_get_agent_bot",
  "inboxes_list",
  "inboxes_set_agent_bot",
  "inboxes_update",
  "integrations_create_hook",
  "integrations_delete_hook",
  "integrations_list_apps",
  "integrations_update_hook",
  "messages_list",
  "profile_get",
  "reports_account_overview",
  "reports_account_summary",
  "reports_agent_summary",
  "reports_conversation_metrics",
  "reports_v2_agents",
  "reports_v2_inboxes",
  "reports_v2_teams",
  "team_members_add",
  "team_members_delete",
  "team_members_list",
  "team_members_update",
  "teams_create",
  "teams_delete",
  "teams_get",
  "teams_list",
  "teams_update",
  "webhooks_create",
  "webhooks_delete",
  "webhooks_list",
  "webhooks_update",
]);

// server name -> frozen Set of allowed leaf names. Keep this map tiny and
// deliberate: every entry is a platform governance decision, not a convenience.
export const OPERATOR_TOOL_FACES = Object.freeze({
  chatwoot: Object.freeze(new Set(CHATWOOT_FACE)),
});

// The face as a sorted array (derivation and tests prefer arrays).
export function operatorToolFace(server) {
  const face = OPERATOR_TOOL_FACES[server];
  return face ? [...face].sort() : null;
}
