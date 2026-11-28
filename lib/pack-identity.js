// lib/pack-identity.js — the one definition of how a pack name becomes an id.
//
// Extracted so two things that must agree cannot drift: the draft export route
// (which mints an id for a never-published draft) and the plugin-package
// exporter (which prefixes MCP server names with the package). A second copy of
// this regex would keep working right up until one of them changed.
//
// Pure: no IO, no env.

/** Lowercase, collapse runs of non-alphanumerics to '-', trim leading/trailing '-'. */
export function slugFromName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A skill name as a directory name. Narrower than `slugFromName`: a skill name is
 * already restricted to `[A-Za-z0-9._-]`, and dropping the dot would make two
 * distinct names collide for no reason.
 */
export function skillDirectoryName(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The id to use for a manifest name, or `fallback` when the name carries nothing
 * usable (a name made entirely of CJK characters slugs to "").
 */
export function packIdFromName(name, fallback = "draft-pack") {
  return slugFromName(name) || fallback;
}

/**
 * The package id for an export envelope: an explicit id (the publish route's
 * durable `packId`, or the CLI's `--pack-id`) wins; otherwise derive from the
 * manifest name with the same rule the platform uses (`packIdFromName`), so a
 * CJK-only name yields `draft-pack`, never a literal like "pack".
 */
export function resolvePackId(name, explicit) {
  return slugFromName(explicit) || packIdFromName(name);
}
