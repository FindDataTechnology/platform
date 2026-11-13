## ADDED Requirements

### Requirement: Install smoke verifies what the user sees
The Windows install smoke MUST assert that the installed app renders content, not merely that its processes and ports respond.

#### Scenario: Installed app is launched as a GUI and proves rendering
- **WHEN** the smoke runs the installed app on a Windows runner
- **THEN** the app is launched with its self-test enabled
- **AND** the smoke waits for the app to exit and asserts a zero exit status
- **AND** the self-test report is surfaced in the build log

#### Scenario: A non-rendering window fails the smoke
- **WHEN** the app exits non-zero from its self-test
- **OR** the app never completes its self-test within the deadline
- **THEN** the smoke job fails
- **AND** the failure names the missing rendering

#### Scenario: Evidence is preserved for human review
- **WHEN** the self-test finishes, pass or fail
- **THEN** its report and screenshot are uploaded as build artifacts

### Requirement: Install smoke probes the renderer's target address
The smoke MUST probe the exact address the app window loads, in addition to any backend-level probe.

#### Scenario: Window URL is probed on the desktop port
- **WHEN** the app has launched its backend
- **THEN** the smoke requests the app's window URL on the desktop port
- **AND** requires a 200 before continuing

#### Scenario: Direct backend probe uses the variables the backend reads
- **WHEN** the smoke runs the packaged backend directly
- **THEN** it sets the port and bind-address variables that the backend process actually reads
- **AND** probes that same address
- **AND** a mismatched variable name cannot produce a guaranteed-false-negative timeout

### Requirement: External screenshots are not trusted as rendering evidence
The pipeline MUST NOT treat a display-wide screenshot of the runner desktop as proof that the application window rendered.

#### Scenario: Wallpaper-dominated capture is recognized as invalid
- **GIVEN** a captured image of the runner desktop
- **WHEN** the pixels that differ from the app backdrop come from the desktop wallpaper
- **THEN** that capture is not accepted as evidence of rendering
- **AND** the app's own renderer capture is used instead
