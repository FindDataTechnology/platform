// The published CLI facts, single-sourced across the shell: the intro view
// renders the install form, the footer carries only the help pointer
// (facet-platform spec: "the intro view carries the published package name
// and install form, and the footnote carries only the `facet help` pointer").
export const FACET_CLI_PACKAGE = "@finddatatechnology/facet";
export const FACET_INSTALL_COMMAND = `npx ${FACET_CLI_PACKAGE} install`;
export const FACET_HELP_COMMAND = `npx ${FACET_CLI_PACKAGE} help`;