# extension-management-ui — Delta

## MODIFIED Requirements

### Requirement: User can add a custom skill

The UI SHALL provide an "Add Custom Skill" button that opens a form to create a new skill with fields for name, description, and skill content (markdown). The form SHALL additionally accept a skill package upload (zip): the package is parsed server-side under the platform's package contract, and the UI shows the resulting inventory — the body excerpt, every file's path, script files highlighted, and any file omitted for size or non-text kind marked as omitted — before the skill is created. A package whose parse fails SHALL surface the named cause and create nothing. The manual paste path (name, description, content) SHALL keep working unchanged, and a package without auxiliary files creates the same single-file skill as the manual path.

#### Scenario: User adds a custom skill

- **WHEN** the user clicks "Add Custom Skill", fills in name, description, and content
- **AND** clicks "Save"
- **THEN** the server SHALL create a new SKILL.md file in the skills directory
- **AND** register the skill with the agent
- **AND** display the new skill in the list

#### Scenario: User uploads a skill package

- **WHEN** the user uploads a zip containing a skill document, two reference files, and one script, and confirms the shown inventory
- **THEN** the skill is created with its auxiliary file set, materializes as a directory tree, and appears in the list with its file inventory

#### Scenario: Script files are highlighted before creation

- **WHEN** the uploaded package contains script files
- **THEN** the inventory shown before creation marks every script file

#### Scenario: Rejected package creates nothing

- **WHEN** the uploaded package has no skill document, or a path escaping the package root
- **THEN** the UI shows the named error and no skill is created
